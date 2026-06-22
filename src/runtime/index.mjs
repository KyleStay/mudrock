import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { serialize } from "node:v8";

const DEFAULT_PRIMITIVE = "default";
const PRIMITIVE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DEFAULT_BLOCK_SIZE = 1024 * 1024;

export const DEFAULT_RUNTIME_LIMITS = Object.freeze({
  max_cpu_ms_per_request: 50,
  max_wall_ms_per_request: 1000,
  max_heap_bytes: 64 * 1024 * 1024,
  max_request_body_bytes: 10 * 1024 * 1024,
  max_response_body_bytes: 10 * 1024 * 1024,
  max_open_sync_connections: 100,
});

export class MudrockRuntimeError extends Error {
  constructor(message, code = "MUDROCK_RUNTIME_ERROR") {
    super(message);
    this.name = "MudrockRuntimeError";
    this.code = code;
  }
}

export function normalizePrimitiveName(name = DEFAULT_PRIMITIVE) {
  if (name === undefined || name === null || name === "") {
    return DEFAULT_PRIMITIVE;
  }

  const normalized = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[-_]+$/g, "");

  if (!PRIMITIVE_PATTERN.test(normalized)) {
    throw new MudrockRuntimeError(
      `Invalid Mudrock primitive name "${name}". Names must normalize to ${PRIMITIVE_PATTERN.source}.`,
      "MUDROCK_INVALID_PRIMITIVE_NAME",
    );
  }

  return normalized;
}

export function createLocalRuntime(options = {}) {
  const dataPlane = options.dataPlane ?? new LocalDataPlane();
  const namespace = normalizeNamespace(options.namespace ?? "local");
  const gatewayBaseUrl = options.gatewayBaseUrl ?? "https://local.mudrock.dev";
  const authContext = normalizeAuthContext(options.authContext, namespace);
  const limits = normalizeRuntimeLimits(options.limits);

  const runtime = {
    namespace,
    limits,
    db(name) {
      return createDatabaseBinding({ dataPlane, namespace, primitive: normalizePrimitiveName(name), limits });
    },
    storage(name) {
      return createStorageBinding({
        dataPlane,
        namespace,
        primitive: normalizePrimitiveName(name),
        gatewayBaseUrl,
        limits,
      });
    },
    sync(name) {
      return createSyncBinding({ dataPlane, namespace, primitive: normalizePrimitiveName(name), limits });
    },
    auth: Object.freeze({
      async currentUser() {
        return authContext?.user ?? null;
      },
      async signIn(provider = "github", { redirectPath = "/" } = {}) {
        const url = new URL(`/a/${encodeURIComponent(namespace)}/__mudrock/auth/start`, gatewayBaseUrl);
        url.searchParams.set("provider", provider);
        url.searchParams.set("redirect_path", redirectPath);
        return url.toString();
      },
      async require() {
        if (authContext?.user) return authContext.user;
        throw new MudrockRuntimeError("Mudrock.auth.require could not find a current user.", "MUDROCK_AUTH_REQUIRED");
      },
    }),
  };

  return Object.freeze(runtime);
}

export function createMudrockRuntime(options = {}) {
  return createLocalRuntime(options);
}

export class LocalDataPlane {
  #namespaces = new Map();

  constructor(snapshot) {
    if (snapshot) {
      this.#restore(snapshot);
    }
  }

  getRecord(namespace, primitive, key) {
    const entry = this.#namespace(namespace);
    const record = entry.kv.get(recordKey(primitive, key));
    if (!record) return null;
    return cloneValue(record.value);
  }

  putRecord(namespace, primitive, key, value, limits) {
    assertWithinRuntimeLimit(value, limits?.max_heap_bytes, "Mudrock.db().put value", "max_heap_bytes");

    const entry = this.#namespace(namespace);
    const now = new Date();
    const id = recordKey(primitive, key);
    const existing = entry.kv.get(id);
    const version = nextVersion(existing?.version);
    const stored = {
      primitive,
      key,
      version,
      value: cloneValue(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    entry.kv.set(id, stored);
    return this.#commitMutation(entry, {
      namespace,
      primitive,
      key,
      operation: "put",
      version,
      payload: cloneValue(value),
      occurredAt: now,
    });
  }

  patchRecord(namespace, primitive, key, patch, limits) {
    assertPlainObject(patch, "patch");

    const entry = this.#namespace(namespace);
    const id = recordKey(primitive, key);
    const existing = entry.kv.get(id);
    const base = existing ? cloneValue(existing.value) : {};
    assertPlainObject(base, "existing value");

    const now = new Date();
    const value = { ...base, ...cloneValue(patch) };
    assertWithinRuntimeLimit(value, limits?.max_heap_bytes, "Mudrock.db().patch result", "max_heap_bytes");

    const version = nextVersion(existing?.version);
    entry.kv.set(id, {
      primitive,
      key,
      version,
      value,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    return this.#commitMutation(entry, {
      namespace,
      primitive,
      key,
      operation: "patch",
      version,
      payload: cloneValue(patch),
      occurredAt: now,
    });
  }

  deleteRecord(namespace, primitive, key) {
    const entry = this.#namespace(namespace);
    const id = recordKey(primitive, key);
    const existing = entry.kv.get(id);
    const now = new Date();
    const version = nextVersion(existing?.version);

    entry.kv.delete(id);
    return this.#commitMutation(entry, {
      namespace,
      primitive,
      key,
      operation: "delete",
      version,
      occurredAt: now,
    });
  }

  async transactionRecords(namespace, primitive, fn, limits) {
    if (typeof fn !== "function") {
      throw new TypeError("Mudrock.db().transaction requires a function.");
    }

    const entry = this.#namespace(namespace);
    const stagedRecords = new Map([...entry.kv.entries()].map(([key, value]) => [key, cloneValue(value)]));
    const stagedMutations = [];
    const tx = Object.freeze({
      primitive,
      async get(key) {
        const record = stagedRecords.get(recordKey(primitive, requireKey(key)));
        return record ? cloneValue(record.value) : null;
      },
      async put(key, value) {
        const record = stagePut({
          stagedRecords,
          stagedMutations,
          namespace,
          primitive,
          key: requireKey(key),
          value,
          limits,
          operation: "put",
        });
        return mutationReceipt(previewEvent(entry, stagedMutations.length, record));
      },
      async patch(key, patch) {
        const record = stagePatch({
          stagedRecords,
          stagedMutations,
          namespace,
          primitive,
          key: requireKey(key),
          patch,
          limits,
        });
        return mutationReceipt(previewEvent(entry, stagedMutations.length, record));
      },
      async delete(key) {
        const record = stageDelete({
          stagedRecords,
          stagedMutations,
          namespace,
          primitive,
          key: requireKey(key),
        });
        return mutationReceipt(previewEvent(entry, stagedMutations.length, record));
      },
      async list(query) {
        return listStagedRecords(stagedRecords, primitive, query);
      },
    });

    const result = await fn(tx);
    entry.kv = stagedRecords;
    for (const mutation of stagedMutations) {
      this.#commitMutation(entry, mutation);
    }
    return result;
  }

  listRecords(namespace, primitive, query = {}) {
    const entry = this.#namespace(namespace);
    const prefix = query?.prefix ?? "";
    const limit = query?.limit ?? Number.POSITIVE_INFINITY;
    const rows = [];

    for (const record of entry.kv.values()) {
      if (record.primitive !== primitive || !record.key.startsWith(prefix)) continue;
      rows.push({
        key: record.key,
        value: cloneValue(record.value),
        version: record.version,
      });
    }

    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows.slice(0, limit);
  }

  putObject(namespace, primitive, object) {
    const entry = this.#namespace(namespace);
    const stored = normalizeStoredObject(object);
    entry.objects.set(recordKey(primitive, stored.metadata.key), stored);
    return this.#commitMutation(entry, {
      namespace,
      primitive,
      key: stored.metadata.key,
      operation: "storage.put",
      version: stored.metadata.version,
      payload: cloneValue(stored.metadata),
      occurredAt: new Date(stored.metadata.updated_at),
    });
  }

  getObject(namespace, primitive, key) {
    const entry = this.#namespace(namespace);
    const object = entry.objects.get(recordKey(primitive, key));
    return object ? materializeStorageObject(object) : null;
  }

  deleteObject(namespace, primitive, key) {
    const entry = this.#namespace(namespace);
    const object = entry.objects.get(recordKey(primitive, key));
    const now = new Date();
    const version = nextVersion(object?.metadata?.version);

    entry.objects.delete(recordKey(primitive, key));
    return this.#commitMutation(entry, {
      namespace,
      primitive,
      key,
      operation: "storage.delete",
      version,
      occurredAt: now,
    });
  }

  getEvents(namespace, primitive, options = {}) {
    const entry = this.#namespace(namespace);
    const afterSequence = options.afterSequence ?? options.after_sequence ?? 0;

    return entry.log
      .filter((event) => event.primitive === primitive && event.sequence > afterSequence)
      .map(cloneValue);
  }

  subscribe(namespace, primitive, listener) {
    const entry = this.#namespace(namespace);
    const id = randomUUID();
    entry.subscribers.set(id, { primitive, listener });

    return () => {
      entry.subscribers.delete(id);
    };
  }

  snapshot() {
    return {
      namespaces: Object.fromEntries([...this.#namespaces.entries()].map(([namespace, entry]) => [
        namespace,
        {
          nextSequence: entry.nextSequence,
          kv: [...entry.kv.values()].map((record) => ({
            primitive: record.primitive,
            key: record.key,
            version: record.version,
            value: cloneValue(record.value),
            createdAt: serializeDate(record.createdAt),
            updatedAt: serializeDate(record.updatedAt),
          })),
          objects: [...entry.objects.values()].map((object) => ({
            metadata: cloneValue(object.metadata),
            bytes_base64: Buffer.from(object.bytes).toString("base64"),
          })),
          log: entry.log.map(cloneValue),
        }
      ]))
    };
  }

  #commitMutation(entry, mutation) {
    const event = Object.freeze({
      event_id: `${mutation.namespace}:${entry.nextSequence}`,
      namespace: mutation.namespace,
      primitive: mutation.primitive,
      key: mutation.key,
      operation: mutation.operation,
      version: mutation.version,
      sequence: entry.nextSequence,
      ...(mutation.payload === undefined ? {} : { payload: cloneValue(mutation.payload) }),
      occurred_at: mutation.occurredAt.toISOString(),
    });

    entry.nextSequence += 1;
    entry.log.push(event);

    for (const subscriber of entry.subscribers.values()) {
      if (subscriber.primitive !== event.primitive) continue;
      queueMicrotask(() => subscriber.listener(cloneValue(event)));
    }

    return mutationReceipt(event);
  }

  #namespace(namespace) {
    let entry = this.#namespaces.get(namespace);
    if (!entry) {
      entry = {
        kv: new Map(),
        objects: new Map(),
        log: [],
        subscribers: new Map(),
        nextSequence: 1,
      };
      this.#namespaces.set(namespace, entry);
    }
    return entry;
  }

  #restore(snapshot) {
    for (const [namespace, rawEntry] of Object.entries(snapshot.namespaces ?? {})) {
      const entry = {
        kv: new Map(),
        objects: new Map(),
        log: (rawEntry.log ?? []).map((event) => Object.freeze(cloneValue(event))),
        subscribers: new Map(),
        nextSequence: rawEntry.nextSequence ?? ((rawEntry.log?.length ?? 0) + 1),
      };

      for (const record of rawEntry.kv ?? []) {
        entry.kv.set(recordKey(record.primitive, record.key), {
          primitive: record.primitive,
          key: record.key,
          version: record.version,
          value: cloneValue(record.value),
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
        });
      }

      for (const object of rawEntry.objects ?? []) {
        const stored = normalizeStoredObject({
          ...object.metadata,
          bytes: Buffer.from(object.bytes_base64 ?? "", "base64"),
        });
        entry.objects.set(recordKey(stored.metadata.primitive, stored.metadata.key), stored);
      }

      this.#namespaces.set(namespace, entry);
    }
  }
}

function createDatabaseBinding({ dataPlane, namespace, primitive, limits }) {
  return Object.freeze({
    primitive,
    limits,
    async get(key) {
      return dataPlane.getRecord(namespace, primitive, requireKey(key));
    },
    async put(key, value) {
      return dataPlane.putRecord(namespace, primitive, requireKey(key), value, limits);
    },
    async patch(key, patch) {
      return dataPlane.patchRecord(namespace, primitive, requireKey(key), patch, limits);
    },
    async delete(key) {
      return dataPlane.deleteRecord(namespace, primitive, requireKey(key));
    },
    async list(query) {
      return dataPlane.listRecords(namespace, primitive, query);
    },
    async transaction(fn) {
      return dataPlane.transactionRecords(namespace, primitive, fn, limits);
    },
  });
}

function stagePut({ stagedRecords, stagedMutations, namespace, primitive, key, value, limits, operation }) {
  assertWithinRuntimeLimit(value, limits?.max_heap_bytes, "Mudrock.db().transaction value", "max_heap_bytes");

  const now = new Date();
  const id = recordKey(primitive, key);
  const existing = stagedRecords.get(id);
  const version = nextVersion(existing?.version);
  stagedRecords.set(id, {
    primitive,
    key,
    version,
    value: cloneValue(value),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  const mutation = {
    namespace,
    primitive,
    key,
    operation,
    version,
    payload: cloneValue(value),
    occurredAt: now,
  };
  stagedMutations.push(mutation);
  return mutation;
}

function stagePatch({ stagedRecords, stagedMutations, namespace, primitive, key, patch, limits }) {
  assertPlainObject(patch, "patch");

  const id = recordKey(primitive, key);
  const existing = stagedRecords.get(id);
  const base = existing ? cloneValue(existing.value) : {};
  assertPlainObject(base, "existing value");
  const value = { ...base, ...cloneValue(patch) };

  return stagePut({
    stagedRecords,
    stagedMutations,
    namespace,
    primitive,
    key,
    value,
    limits,
    operation: "patch",
  });
}

function stageDelete({ stagedRecords, stagedMutations, namespace, primitive, key }) {
  const id = recordKey(primitive, key);
  const existing = stagedRecords.get(id);
  const now = new Date();
  const version = nextVersion(existing?.version);
  stagedRecords.delete(id);
  const mutation = {
    namespace,
    primitive,
    key,
    operation: "delete",
    version,
    occurredAt: now,
  };
  stagedMutations.push(mutation);
  return mutation;
}

function previewEvent(entry, stagedLength, mutation) {
  const sequence = entry.nextSequence + stagedLength - 1;
  return Object.freeze({
    event_id: `${mutation.namespace}:${sequence}`,
    namespace: mutation.namespace,
    primitive: mutation.primitive,
    key: mutation.key,
    operation: mutation.operation,
    version: mutation.version,
    sequence,
    ...(mutation.payload === undefined ? {} : { payload: cloneValue(mutation.payload) }),
    occurred_at: mutation.occurredAt.toISOString(),
  });
}

function listStagedRecords(stagedRecords, primitive, query = {}) {
  const prefix = query?.prefix ?? "";
  const limit = query?.limit ?? Number.POSITIVE_INFINITY;
  const rows = [];

  for (const record of stagedRecords.values()) {
    if (record.primitive !== primitive || !record.key.startsWith(prefix)) continue;
    rows.push({
      key: record.key,
      value: cloneValue(record.value),
      version: record.version,
    });
  }

  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows.slice(0, limit);
}

function createStorageBinding({ dataPlane, namespace, primitive, gatewayBaseUrl, limits }) {
  return Object.freeze({
    primitive,
    limits,
    async put(key, body, options = {}) {
      const objectKey = requireKey(key);
      const bytes = await bodyToUint8Array(body, {
        maxBytes: limits.max_request_body_bytes,
        label: "Mudrock.storage().put body",
        limitName: "max_request_body_bytes",
      });
      const now = new Date();
      const existing = dataPlane.getObject(namespace, primitive, objectKey);
      const version = nextVersion(existing?.version);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const contentType = options.content_type ?? options.contentType ?? null;
      const blockSize = options.block_size ?? options.blockSize ?? DEFAULT_BLOCK_SIZE;
      if (!Number.isInteger(blockSize) || blockSize <= 0) {
        throw new MudrockRuntimeError("Mudrock.storage().put block size must be a positive integer.", "MUDROCK_INVALID_BLOCK_SIZE");
      }

      const object = {
        id: `${namespace}:${primitive}:${objectKey}:${version}`,
        primitive,
        key: objectKey,
        size: bytes.byteLength,
        content_type: contentType,
        sha256,
        block_size: blockSize,
        block_count: bytes.byteLength === 0 ? 0 : Math.ceil(bytes.byteLength / blockSize),
        version,
        created_at: existing?.created_at ?? now.toISOString(),
        updated_at: now.toISOString(),
        url: signedLocalObjectUrl({ gatewayBaseUrl, namespace, primitive, key: objectKey, version }),
      };

      dataPlane.putObject(namespace, primitive, { ...object, bytes });
      return materializeStorageObject({ metadata: object, bytes });
    },
    async get(key) {
      return dataPlane.getObject(namespace, primitive, requireKey(key));
    },
    async delete(key) {
      return dataPlane.deleteObject(namespace, primitive, requireKey(key));
    },
  });
}

function createSyncBinding({ dataPlane, namespace, primitive, limits }) {
  return Object.freeze({
    primitive,
    limits,
    async events(options) {
      return dataPlane.getEvents(namespace, primitive, options);
    },
    async list(afterSequence = 0) {
      return dataPlane.getEvents(namespace, primitive, { afterSequence });
    },
    async since(afterSequence = 0) {
      return dataPlane.getEvents(namespace, primitive, { afterSequence });
    },
    on(eventName, listener) {
      if (eventName !== "change") {
        throw new MudrockRuntimeError(`Unsupported sync event "${eventName}".`, "MUDROCK_UNSUPPORTED_SYNC_EVENT");
      }
      if (typeof listener !== "function") {
        throw new TypeError("Mudrock.sync().on requires a listener function.");
      }
      return dataPlane.subscribe(namespace, primitive, listener);
    },
  });
}

function mutationReceipt(event) {
  return Object.freeze({
    event_id: event.event_id,
    namespace: event.namespace,
    primitive: event.primitive,
    key: event.key,
    operation: event.operation,
    version: event.version,
    sequence: event.sequence,
    occurred_at: event.occurred_at,
  });
}

function normalizeNamespace(namespace) {
  const value = String(namespace ?? "").trim();
  if (!value) {
    throw new MudrockRuntimeError("Mudrock runtime namespace is required.", "MUDROCK_INVALID_NAMESPACE");
  }
  return value;
}

function normalizeAuthContext(authContext, namespace) {
  if (!authContext) return null;
  const user = authContext.user ?? authContext.currentUser ?? authContext;
  if (!user || typeof user !== "object") return null;

  return Object.freeze({
    user: Object.freeze({
      ...cloneValue(user),
      namespace: user.namespace ?? namespace,
    }),
  });
}

function normalizeRuntimeLimits(overrides = {}) {
  const limits = {};

  for (const [name, defaultValue] of Object.entries(DEFAULT_RUNTIME_LIMITS)) {
    const value = overrides?.[name] ?? defaultValue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new MudrockRuntimeError(
        `Mudrock runtime limit ${name} must be a positive integer.`,
        "MUDROCK_INVALID_RUNTIME_LIMIT",
      );
    }
    limits[name] = value;
  }

  return Object.freeze(limits);
}

function recordKey(primitive, key) {
  return `${primitive}\u0000${key}`;
}

function requireKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new MudrockRuntimeError("Mudrock primitive key must be a non-empty string.", "MUDROCK_INVALID_KEY");
  }
  return key;
}

function nextVersion(previousVersion) {
  const current = Number.parseInt(previousVersion ?? "0", 10);
  return String(current + 1);
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function serializeDate(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeStoredObject(object) {
  if (object?.metadata && object.bytes !== undefined) {
    return {
      metadata: cloneValue(object.metadata),
      bytes: object.bytes instanceof Uint8Array ? object.bytes : new Uint8Array(object.bytes),
    };
  }

  const { bytes = new Uint8Array(), ...metadata } = object;
  return {
    metadata: cloneValue(metadata),
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  };
}

function materializeStorageObject(stored) {
  const metadata = cloneValue(stored.metadata);
  Object.defineProperty(metadata, "arrayBuffer", {
    enumerable: false,
    value: async () => stored.bytes.buffer.slice(
      stored.bytes.byteOffset,
      stored.bytes.byteOffset + stored.bytes.byteLength,
    ),
  });
  return Object.freeze(metadata);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MudrockRuntimeError(`Mudrock ${label} must be an object.`, "MUDROCK_EXPECTED_OBJECT");
  }
}

function assertWithinRuntimeLimit(value, maxBytes, label, limitName) {
  if (maxBytes === undefined) return;
  const size = serialize(value).byteLength;
  if (size > maxBytes) {
    throw new MudrockRuntimeError(
      `${label} exceeds ${limitName} (${size} bytes > ${maxBytes} bytes).`,
      "MUDROCK_RUNTIME_LIMIT_EXCEEDED",
    );
  }
}

function assertByteLength(byteLength, maxBytes, label, limitName) {
  if (maxBytes === undefined || byteLength <= maxBytes) return;
  throw new MudrockRuntimeError(
    `${label} exceeds ${limitName} (${byteLength} bytes > ${maxBytes} bytes).`,
    "MUDROCK_RUNTIME_LIMIT_EXCEEDED",
  );
}

async function bodyToUint8Array(body, limits = {}) {
  if (body instanceof Uint8Array) {
    assertByteLength(body.byteLength, limits.maxBytes, limits.label, limits.limitName);
    return body;
  }
  if (body instanceof ArrayBuffer) {
    assertByteLength(body.byteLength, limits.maxBytes, limits.label, limits.limitName);
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    assertByteLength(body.byteLength, limits.maxBytes, limits.label, limits.limitName);
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body && typeof body.getReader === "function") {
    return readWebStream(body, limits);
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    return readNodeStream(body, limits);
  }

  throw new MudrockRuntimeError(
    "Mudrock.storage().put accepts a ReadableStream, ArrayBuffer, Uint8Array, or async iterable.",
    "MUDROCK_INVALID_STORAGE_BODY",
  );
}

async function readWebStream(stream, limits) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    size += chunk.byteLength;
    assertByteLength(size, limits.maxBytes, limits.label, limits.limitName);
  }

  return concatChunks(chunks, size);
}

async function readNodeStream(stream, limits) {
  const chunks = [];
  let size = 0;

  for await (const value of Readable.from(stream)) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    size += chunk.byteLength;
    assertByteLength(size, limits.maxBytes, limits.label, limits.limitName);
  }

  return concatChunks(chunks, size);
}

function concatChunks(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function signedLocalObjectUrl({ gatewayBaseUrl, namespace, primitive, key, version }) {
  const url = new URL(`/a/${encodeURIComponent(namespace)}/__mudrock/storage/${encodeURIComponent(primitive)}/${encodeURIComponent(key)}`, gatewayBaseUrl);
  url.searchParams.set("version", version);
  return url.toString();
}
