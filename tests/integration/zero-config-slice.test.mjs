import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const exampleSourceUrl = new URL("../../examples/zero-config-notes/index.js", import.meta.url);
const deployRequestUrl = new URL("../../examples/zero-config-notes/deploy-request.json", import.meta.url);
const specUrl = new URL("../../system-spec.json", import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonResponseBody(response) {
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  return response.json();
}

function detectPrimitives(source) {
  const refs = [];
  const literalCall = /Mudrock\.(db|storage|sync)\(\s*["']([a-z0-9][a-z0-9_-]{0,62})["']\s*\)/g;
  for (const match of source.matchAll(literalCall)) {
    refs.push({ kind: match[1], name: match[2] });
  }
  if (/\bMudrock\.auth\b/.test(source)) {
    refs.push({ kind: "auth", name: "default" });
  }
  return refs;
}

async function readExampleDeployment() {
  const [source, deployRequestRaw, specRaw] = await Promise.all([
    readFile(exampleSourceUrl, "utf8"),
    readFile(deployRequestUrl, "utf8"),
    readFile(specUrl, "utf8")
  ]);

  return {
    source,
    deployRequest: JSON.parse(deployRequestRaw),
    spec: JSON.parse(specRaw)
  };
}

function buildCreateAppRequest(deployRequest, source) {
  return {
    name: deployRequest.name,
    entrypoint: deployRequest.entrypoint,
    source,
    runtime: deployRequest.runtime
  };
}

class InMemoryPrimitiveLog {
  #events = [];
  #sequence = 0;

  append(namespace, primitive, key, operation, payload) {
    const event = {
      event_id: `evt_${this.#sequence + 1}`,
      namespace,
      primitive,
      key,
      operation,
      version: String(this.#sequence + 1),
      sequence: this.#sequence + 1,
      payload,
      occurred_at: new Date(this.#sequence + 1).toISOString()
    };
    this.#sequence += 1;
    this.#events.push(event);
    return event;
  }

  list(primitive, afterSequence = 0) {
    return this.#events.filter((event) => {
      return event.primitive === primitive && event.sequence > afterSequence;
    });
  }
}

class InMemoryDatabase {
  constructor(namespace, primitive, log) {
    this.namespace = namespace;
    this.primitive = primitive;
    this.log = log;
    this.records = new Map();
  }

  async get(key) {
    return this.records.get(key)?.value ?? null;
  }

  async put(key, value) {
    const version = String((Number(this.records.get(key)?.version) || 0) + 1);
    this.records.set(key, { key, value, version });
    return this.log.append(this.namespace, this.primitive, key, "put", value);
  }

  async patch(key, patch) {
    const current = this.records.get(key)?.value ?? {};
    const value = { ...current, ...patch };
    const version = String((Number(this.records.get(key)?.version) || 0) + 1);
    this.records.set(key, { key, value, version });
    return this.log.append(this.namespace, this.primitive, key, "patch", patch);
  }

  async list(query = {}) {
    const prefix = query.prefix || "";
    return [...this.records.values()].filter((row) => row.key.startsWith(prefix));
  }
}

class InMemoryStorage {
  constructor(namespace, primitive, log) {
    this.namespace = namespace;
    this.primitive = primitive;
    this.log = log;
    this.objects = new Map();
  }

  async put(key, body) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const digest = sha256(bytes);
    const object = {
      id: `${this.primitive}_${digest.slice(0, 12)}`,
      primitive: this.primitive,
      key,
      size: bytes.byteLength,
      content_type: null,
      sha256: digest,
      block_size: 1048576,
      block_count: bytes.byteLength === 0 ? 0 : Math.ceil(bytes.byteLength / 1048576),
      version: "1",
      created_at: new Date(1).toISOString(),
      updated_at: new Date(1).toISOString(),
      url: `/__mudrock/storage/${this.primitive}/${encodeURIComponent(key)}`,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };

    this.objects.set(key, object);
    this.log.append(this.namespace, this.primitive, key, "storage.put", {
      id: object.id,
      size: object.size,
      sha256: object.sha256
    });
    return object;
  }

  async get(key) {
    return this.objects.get(key) ?? null;
  }
}

class ZeroConfigHarness {
  constructor({ ownerId }) {
    this.ownerId = ownerId;
    this.deployments = new Map();
  }

  async deploy({ name, entrypoint, source, runtime = "v8-isolate" }) {
    const appId = `app_${sha256(`${this.ownerId}:${name}`).slice(0, 16)}`;
    const namespace = `ns_${sha256(`${this.ownerId}:${appId}`).slice(0, 20)}`;
    const buildId = `bld_${sha256(source).slice(0, 16)}`;
    const log = new InMemoryPrimitiveLog();
    const dbs = new Map();
    const stores = new Map();
    const mudrock = {
      db(primitive = "default") {
        if (!dbs.has(primitive)) {
          dbs.set(primitive, new InMemoryDatabase(namespace, primitive, log));
        }
        return dbs.get(primitive);
      },
      storage(primitive = "default") {
        if (!stores.has(primitive)) {
          stores.set(primitive, new InMemoryStorage(namespace, primitive, log));
        }
        return stores.get(primitive);
      },
      auth: {
        async currentUser() {
          return {
            id: "user_ada",
            provider: "github",
            namespace
          };
        }
      },
      sync(primitive = "default") {
        return {
          list(afterSequence = 0) {
            return log.list(primitive, afterSequence);
          }
        };
      }
    };

    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    const module = await import(moduleUrl);
    const deployment = {
      app_id: appId,
      namespace,
      entrypoint,
      source_sha256: sha256(source),
      deployment: {
        deployment_id: `dep_${buildId.slice(4)}`,
        build_id: buildId,
        bundle_sha256: sha256(`bundle:${source}`),
        runtime,
        status: "active"
      },
      detected_primitives: detectPrimitives(source),
      app: module.default,
      mudrock
    };
    this.deployments.set(namespace, deployment);
    return deployment;
  }

  async invoke(deployment, path, init = {}) {
    const previousMudrock = globalThis.Mudrock;
    globalThis.Mudrock = deployment.mudrock;
    try {
      return await deployment.app.fetch(new Request(`https://example.test${path}`, init));
    } finally {
      if (previousMudrock === undefined) {
        delete globalThis.Mudrock;
      } else {
        globalThis.Mudrock = previousMudrock;
      }
    }
  }
}

test("example deployment metadata builds a create app request", async () => {
  const { deployRequest, spec, source } = await readExampleDeployment();
  const createApp = spec.$defs.CreateAppRequest;
  const createAppRequest = buildCreateAppRequest(deployRequest, source);

  const allowedKeys = new Set(Object.keys(createApp.properties));
  for (const key of createApp.required) {
    assert.equal(Object.hasOwn(createAppRequest, key), true);
  }
  for (const key of Object.keys(createAppRequest)) {
    assert.equal(allowedKeys.has(key), true);
  }
  assert.equal(createAppRequest.name, "zero-config-notes");
  assert.equal(createAppRequest.entrypoint, "index.js");
  assert.equal(createAppRequest.runtime, "v8-isolate");
  assert.match(createAppRequest.name, new RegExp(createApp.properties.name.pattern));
  assert.equal(typeof createAppRequest.source, "string");
  assert.ok(source.includes("Mudrock.db(\"notes\")"));
  assert.ok(source.includes("Mudrock.storage(\"attachments\")"));
  assert.ok(source.includes("Mudrock.auth.currentUser"));
  assert.equal(Object.hasOwn(createAppRequest, "database"), false);
  assert.equal(Object.hasOwn(createAppRequest, "bucket"), false);
  assert.equal(Object.hasOwn(createAppRequest, "oauth_client"), false);
});

test("zero-config deploy detects primitives and derives namespace from owner identity", async () => {
  const { deployRequest, source } = await readExampleDeployment();
  const harness = new ZeroConfigHarness({ ownerId: "owner_123" });
  const deployment = await harness.deploy({ ...deployRequest, source });

  assert.match(deployment.app_id, /^app_[a-f0-9]{16}$/);
  assert.match(deployment.namespace, /^ns_[a-f0-9]{20}$/);
  assert.equal(deployment.deployment.runtime, "v8-isolate");
  assert.equal(deployment.deployment.status, "active");
  assert.deepEqual(deployment.detected_primitives, [
    { kind: "db", name: "notes" },
    { kind: "storage", name: "attachments" },
    { kind: "auth", name: "default" }
  ]);

  const sameNameDifferentOwner = await new ZeroConfigHarness({ ownerId: "owner_456" }).deploy({
    ...deployRequest,
    source
  });
  assert.notEqual(deployment.namespace, sameNameDifferentOwner.namespace);
});

test("invoke exercises implicit db, storage, auth, and sync behavior", async () => {
  const { deployRequest, source } = await readExampleDeployment();
  const harness = new ZeroConfigHarness({ ownerId: "owner_123" });
  const deployment = await harness.deploy({ ...deployRequest, source });

  const createdResponse = await harness.invoke(deployment, "/notes", {
    method: "POST",
    body: JSON.stringify({ id: "first", title: "Hello", body: "From source only" })
  });
  assert.equal(createdResponse.status, 201);
  const created = await jsonResponseBody(createdResponse);
  assert.equal(created.note.owner, "user_ada");
  assert.equal(created.receipt.operation, "put");
  assert.equal(created.receipt.primitive, "notes");

  const uploadResponse = await harness.invoke(deployment, "/attachments?note_id=first", {
    method: "POST",
    body: "attachment text"
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await jsonResponseBody(uploadResponse);
  assert.equal(uploaded.attachment.primitive, "attachments");
  assert.equal(uploaded.attachment.size, "attachment text".length);
  assert.equal(uploaded.attachment.url.startsWith("/__mudrock/storage/"), true);

  const listResponse = await harness.invoke(deployment, "/notes");
  const list = await jsonResponseBody(listResponse);
  assert.equal(list.notes.length, 1);
  assert.equal(list.notes[0].attachment.id, uploaded.attachment.id);
  assert.deepEqual(list.sync, {
    primitive: "notes",
    href: "/__mudrock/sync?primitive=notes"
  });

  const attachmentResponse = await harness.invoke(deployment, "/attachments?note_id=first");
  const attachment = await jsonResponseBody(attachmentResponse);
  assert.equal(attachment.text, "attachment text");

  const sessionResponse = await harness.invoke(deployment, "/session");
  const session = await jsonResponseBody(sessionResponse);
  assert.equal(session.user.namespace, deployment.namespace);
  assert.equal(session.sign_in, "/__mudrock/auth/start?provider=github&redirect_path=/session");

  const noteEvents = deployment.mudrock.sync("notes").list();
  assert.deepEqual(
    noteEvents.map((event) => [event.operation, event.key]),
    [
      ["put", "note:first"],
      ["patch", "note:first"]
    ]
  );
  assert.equal(noteEvents.every((event) => event.namespace === deployment.namespace), true);

  const storageEvents = deployment.mudrock.sync("attachments").list();
  assert.deepEqual(storageEvents.map((event) => event.operation), ["storage.put"]);
});

test("example paths stay inside the developer experience ownership boundary", async () => {
  const files = [
    new URL("../../examples/zero-config-notes/index.js", import.meta.url),
    new URL("../../examples/zero-config-notes/local-gateway-server.js", import.meta.url),
    new URL("../../examples/zero-config-notes/deploy-request.json", import.meta.url),
    new URL("./zero-config-slice.test.mjs", import.meta.url),
    new URL("./local-gateway-composition.test.mjs", import.meta.url),
    new URL("../../docs/first-executable-slice.md", import.meta.url),
    new URL("../../docs/integration-notes.md", import.meta.url)
  ];

  for (const file of files) {
    assert.equal(file.href.startsWith(new URL("examples/", repoRoot).href) ||
      file.href.startsWith(new URL("tests/integration/", repoRoot).href) ||
      file.href.startsWith(new URL("docs/", repoRoot).href), true);
  }
});
