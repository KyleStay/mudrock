import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { compileSource } from "../compiler/memory-compiler.js";
import { buildOmdDocument } from "../omd/manifest.js";
import { DEFAULT_RUNTIME_LIMITS, LocalDataPlane } from "../runtime/index.mjs";
import { createNamespace, hashBytes, stableJson } from "../shared/index.js";

const STATE_VERSION = 1;
const LOCAL_AGENT_TOKEN_TTL_SECONDS = 900;
const STATE_LOCK_STALE_MS = 5 * 60_000;
const STATE_LOCK_RETRY_MS = 10;

export class LocalProjectStore {
  constructor({ statePath = ".mudrock/local-state.json", ownerId = "local" } = {}) {
    this.statePath = resolve(statePath);
    this.ownerId = ownerId;
  }

  async read() {
    let raw;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return normalizeState(undefined, this.ownerId, this.statePath);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SyntaxError(`Failed to parse Mudrock local state at ${this.statePath}: ${error.message}`, {
        cause: error
      });
    }

    return normalizeState(parsed, this.ownerId, this.statePath);
  }

  async write(state) {
    await this.#withStateLock(() => this.#writeAtomic(state));
  }

  async #writeAtomic(state) {
    const normalized = normalizeState(state, this.ownerId, this.statePath);
    const stateDir = dirname(this.statePath);
    const tempPath = join(stateDir, `.${basename(this.statePath)}.${process.pid}.${randomUUID()}.tmp`);

    await mkdir(stateDir, { recursive: true });
    try {
      await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        flag: "wx",
        flush: true
      });
      await rename(tempPath, this.statePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #update(mutator) {
    return this.#withStateLock(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.#writeAtomic(state);
      return result;
    });
  }

  async #withStateLock(task) {
    const release = await acquireStateLock(this.statePath);
    try {
      return await task();
    } finally {
      await release();
    }
  }

  async deploy({ name, entrypoint, source, runtime = "v8-isolate", runtime_limits }) {
    const appName = requireAppName(name);
    const normalizedRuntimeLimits = normalizeRuntimeLimitOverrides(runtime_limits);
    const appId = `app_${hashBytes(`${this.ownerId}:${appName}`).slice(0, 24)}`;
    const namespace = createNamespace({ ownerId: this.ownerId, appId });
    const compiled = compileSource({
      app_id: appId,
      namespace,
      entrypoint,
      source,
      runtime
    });

    const deployment = {
      deployment_id: `dep_${compiled.build_id.slice(4)}`,
      build_id: compiled.build_id,
      bundle_sha256: compiled.integrity.bundle_sha256,
      source_sha256: compiled.integrity.source_sha256,
      runtime,
      ...(normalizedRuntimeLimits === undefined ? {} : { runtime_limits: normalizedRuntimeLimits }),
      status: "active",
      deployed_at: new Date().toISOString()
    };

    await this.#update((state) => {
      state.appNames[appName] = appId;
      state.apps[appId] = {
        app_id: appId,
        name: appName,
        namespace,
        entrypoint,
        active_deployment_id: deployment.deployment_id,
        detected_primitives: compiled.detected_primitives,
        data_plane: state.apps[appId]?.data_plane ?? emptyDataPlane(),
        deployments: {
          ...(state.apps[appId]?.deployments ?? {}),
          [deployment.deployment_id]: {
            ...deployment,
            module_format: compiled.module_format,
            bundle_text: compiled.bundle_text
          }
        }
      };
      state.logs.push({
        at: deployment.deployed_at,
        app: appName,
        namespace,
        deployment_id: deployment.deployment_id,
        event: "deployment.activated",
        build_id: deployment.build_id
      });
    });

    return {
      app_id: appId,
      namespace,
      deployment,
      detected_primitives: compiled.detected_primitives
    };
  }

  async getApp(nameOrId) {
    const state = await this.read();
    const appId = state.appNames[nameOrId] ?? nameOrId;
    const app = state.apps[appId];
    if (!app) {
      throw new Error(`Unknown Mudrock app: ${nameOrId}`);
    }
    return app;
  }

  async logs(nameOrId) {
    const state = await this.read();
    if (!nameOrId) return state.logs;
    const appId = state.appNames[nameOrId] ?? nameOrId;
    const app = state.apps[appId];
    const namespace = app?.namespace;
    return state.logs.filter((row) => row.app === nameOrId || row.namespace === namespace);
  }

  async appendLog(row) {
    await this.#update((state) => {
      state.logs.push({
        at: new Date().toISOString(),
        ...row
      });
    });
  }

  async dataPlaneForApp(nameOrId) {
    const app = await this.getApp(nameOrId);
    return new LocalDataPlane(app.data_plane ?? emptyDataPlane());
  }

  async withDataPlaneForApp(nameOrId, task) {
    return this.#withDataPlane((state) => {
      const appId = state.appNames[nameOrId] ?? nameOrId;
      const app = state.apps[appId];
      if (!app) {
        throw new Error(`Unknown Mudrock app: ${nameOrId}`);
      }
      return { appId, app };
    }, task);
  }

  async withMergedDataPlaneForApp(nameOrId, task) {
    return this.#withMergedDataPlane((state) => {
      const appId = state.appNames[nameOrId] ?? nameOrId;
      const app = state.apps[appId];
      if (!app) {
        throw new Error(`Unknown Mudrock app: ${nameOrId}`);
      }
      return { appId, app };
    }, task);
  }

  async withDataPlaneForNamespace(namespace, task) {
    return this.#withDataPlane((state) => {
      const entry = Object.entries(state.apps)
        .find(([, app]) => app.namespace === namespace);
      if (!entry) {
        throw new Error(`Unknown Mudrock namespace: ${namespace}`);
      }
      const [appId, app] = entry;
      return { appId, app };
    }, task);
  }

  async withMergedDataPlaneForNamespace(namespace, task) {
    return this.#withMergedDataPlane((state) => {
      const entry = Object.entries(state.apps)
        .find(([, app]) => app.namespace === namespace);
      if (!entry) {
        throw new Error(`Unknown Mudrock namespace: ${namespace}`);
      }
      const [appId, app] = entry;
      return { appId, app };
    }, task);
  }

  async #withDataPlane(resolveApp, task) {
    return this.#withStateLock(async () => {
      const state = await this.read();
      const { appId, app } = resolveApp(state);
      const dataPlane = new LocalDataPlane(app.data_plane ?? emptyDataPlane());
      const result = await task({
        app,
        appId,
        dataPlane,
        baseSnapshot: dataPlane.snapshot()
      });
      if (result?.dataPlane) {
        app.data_plane = result.dataPlane.snapshot();
      }
      for (const log of result?.logs ?? []) {
        state.logs.push({
          at: new Date().toISOString(),
          ...log
        });
      }
      await this.#writeAtomic(state);
      return result?.value;
    });
  }

  async #withMergedDataPlane(resolveApp, task) {
    const base = await this.#withStateLock(async () => {
      const state = await this.read();
      const { appId, app } = resolveApp(state);
      return {
        app: structuredClone(app),
        appId,
        baseSnapshot: structuredClone(app.data_plane ?? emptyDataPlane())
      };
    });
    const dataPlane = new LocalDataPlane(base.baseSnapshot);
    const result = await task({
      app: base.app,
      appId: base.appId,
      dataPlane,
      baseSnapshot: base.baseSnapshot
    });

    return this.#withStateLock(async () => {
      const state = await this.read();
      const app = state.apps[base.appId];
      if (!app) {
        throw new Error(`Unknown Mudrock app: ${base.appId}`);
      }
      const merge = mergeDataPlaneSnapshots({
        baseSnapshot: base.baseSnapshot,
        currentSnapshot: app.data_plane ?? emptyDataPlane(),
        nextSnapshot: result?.dataPlane?.snapshot?.() ?? dataPlane.snapshot()
      });
      app.data_plane = merge.snapshot;
      for (const log of result?.logs ?? []) {
        state.logs.push({
          at: new Date().toISOString(),
          ...log
        });
      }
      await this.#writeAtomic(state);
      return result?.value === undefined
        ? undefined
        : {
          ...result.value,
          dataPlaneSnapshot: merge.snapshot,
          durableEvents: merge.events
        };
    });
  }

  async saveDataPlaneForApp(nameOrId, dataPlane, { expectedSnapshot } = {}) {
    await this.#update((state) => {
      const appId = state.appNames[nameOrId] ?? nameOrId;
      const app = state.apps[appId];
      if (!app) {
        throw new Error(`Unknown Mudrock app: ${nameOrId}`);
      }
      if (expectedSnapshot !== undefined && stateFingerprint(app.data_plane ?? emptyDataPlane()) !== stateFingerprint(expectedSnapshot)) {
        throw new LocalStateConflictError(`Data plane for ${nameOrId} changed before commit.`);
      }

      app.data_plane = dataPlane.snapshot();
    });
  }

  async claimAgent(manifest, { apiBase, authBase } = {}) {
    const agent = requireAgentManifest(manifest);
    const omd = buildOmdDocument({ apiBase, authBase });
    const agentId = `agent_${hashBytes(`${this.ownerId}:${agent.agent_name}:${agent.jwks_uri}`).slice(0, 24)}`;
    const claimedAt = new Date().toISOString();
    const response = {
      agent_id: agentId,
      client_id: `client_${hashBytes(agentId).slice(0, 24)}`,
      token_endpoint: omd.authkit.token_endpoint,
      approved_scopes: agent.requested_scopes
    };

    await this.#update((state) => {
      state.agents ??= {};
      state.agents[agentId] = {
        ...agent,
        ...response,
        claimed_at: claimedAt
      };
      state.logs.push({
        at: claimedAt,
        agent_id: agentId,
        event: "agent.claimed",
        scopes: agent.requested_scopes
      });
    });

    return response;
  }

  async issueAgentToken({ grant_type, client_id, scope } = {}, { issuer, audience } = {}) {
    if (grant_type !== "client_credentials") {
      throw new TypeError("Unsupported AuthKit grant_type");
    }

    const state = await this.read();
    const agent = Object.values(state.agents)
      .find((candidate) => candidate.client_id === client_id);
    if (!agent) {
      throw new TypeError("Unknown AuthKit client_id");
    }

    const requestedScopes = normalizeRequestedScopes(scope ?? agent.approved_scopes);
    const approvedScopes = new Set(agent.approved_scopes ?? []);
    const deniedScopes = requestedScopes.filter((entry) => !approvedScopes.has(entry));
    if (deniedScopes.length > 0) {
      throw new TypeError(`Requested scopes are not approved: ${deniedScopes.join(", ")}`);
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      iss: normalizeIssuer(issuer),
      aud: audience ?? "mudrock.local",
      sub: agent.agent_id,
      agent_id: agent.agent_id,
      owner_id: state.owner_id,
      scope: requestedScopes,
      cnf: { method: "local-development" },
      iat: issuedAt,
      exp: issuedAt + LOCAL_AGENT_TOKEN_TTL_SECONDS,
      jti: `jti_${randomUUID()}`
    };
    const accessToken = encodeLocalToken(claims);

    await this.#update((latestState) => {
      latestState.logs.push({
        at: new Date(issuedAt * 1000).toISOString(),
        agent_id: agent.agent_id,
        client_id: agent.client_id,
        event: "agent.token_issued",
        scopes: requestedScopes,
        expires_at: new Date(claims.exp * 1000).toISOString()
      });
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: LOCAL_AGENT_TOKEN_TTL_SECONDS,
      scope: requestedScopes.join(" ")
    };
  }

  async verifyAgentToken(accessToken, { required_scopes = [] } = {}) {
    const claims = decodeLocalToken(accessToken);
    const state = await this.read();
    const agent = Object.values(state.agents)
      .find((candidate) => candidate.agent_id === claims.agent_id);
    if (!agent) {
      throw new TypeError("Unknown AuthKit token subject");
    }
    if (claims.owner_id !== state.owner_id) {
      throw new TypeError("AuthKit token owner mismatch");
    }
    if (claims.exp <= Math.floor(Date.now() / 1000)) {
      throw new TypeError("AuthKit token has expired");
    }

    const tokenScopes = new Set(claims.scope ?? []);
    const missing = required_scopes.filter((scopeName) => !tokenScopes.has(scopeName));
    if (missing.length > 0) {
      throw new TypeError(`AuthKit token is missing required scopes: ${missing.join(", ")}`);
    }

    return claims;
  }
}

export class LocalStateConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalStateConflictError";
    this.code = "MUDROCK_LOCAL_STATE_CONFLICT";
  }
}

export function createLocalControlPlane(options = {}) {
  return new LocalProjectStore(options);
}

function emptyState(ownerId) {
  return {
    version: STATE_VERSION,
    owner_id: ownerId,
    appNames: {},
    apps: {},
    agents: {},
    logs: []
  };
}

function normalizeState(value, ownerId, statePath) {
  if (value === undefined) return emptyState(ownerId);
  requirePlainObject(value, "state", statePath);

  const version = normalizeStateVersion(value.version, statePath);
  const normalizedOwnerId = normalizeOwnerId(value.owner_id, ownerId, statePath);

  return {
    ...value,
    version,
    owner_id: normalizedOwnerId,
    appNames: normalizePlainRecord(value.appNames, "appNames", statePath),
    apps: normalizePlainRecord(value.apps, "apps", statePath),
    agents: normalizePlainRecord(value.agents, "agents", statePath),
    logs: normalizeArray(value.logs, "logs", statePath)
  };
}

function normalizeStateVersion(version, statePath) {
  if (version === undefined) return STATE_VERSION;
  if (version === STATE_VERSION) return version;
  if (Number.isInteger(version) && version > STATE_VERSION) {
    throw invalidState(`Unsupported Mudrock local state version ${version}`, statePath);
  }
  throw invalidState("Mudrock local state version must be 1", statePath);
}

function normalizeOwnerId(ownerId, fallback, statePath) {
  if (ownerId === undefined) return fallback;
  if (typeof ownerId === "string" && ownerId.length > 0) return ownerId;
  throw invalidState("Mudrock local state owner_id must be a non-empty string", statePath);
}

function normalizePlainRecord(value, field, statePath) {
  if (value === undefined) return {};
  requirePlainObject(value, field, statePath);
  return value;
}

function normalizeArray(value, field, statePath) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw invalidState(`Mudrock local state ${field} must be an array`, statePath);
}

function requirePlainObject(value, field, statePath) {
  if (value && typeof value === "object" && !Array.isArray(value)) return;
  throw invalidState(`Mudrock local state ${field} must be an object`, statePath);
}

function invalidState(message, statePath) {
  return new TypeError(`${message} at ${statePath}`);
}

function emptyDataPlane() {
  return { namespaces: {} };
}

function mergeDataPlaneSnapshots({ baseSnapshot, currentSnapshot, nextSnapshot }) {
  const merged = structuredClone(currentSnapshot ?? emptyDataPlane());
  merged.namespaces ??= {};
  const emittedEvents = [];
  const namespaceNames = new Set([
    ...Object.keys(baseSnapshot?.namespaces ?? {}),
    ...Object.keys(nextSnapshot?.namespaces ?? {})
  ]);

  for (const namespace of namespaceNames) {
    const base = normalizeSnapshotNamespace(baseSnapshot?.namespaces?.[namespace]);
    const current = normalizeSnapshotNamespace(currentSnapshot?.namespaces?.[namespace]);
    const next = normalizeSnapshotNamespace(nextSnapshot?.namespaces?.[namespace]);
    const target = merged.namespaces[namespace] ?? {
      nextSequence: 1,
      kv: [],
      objects: [],
      log: []
    };

    mergeSnapshotCollection({
      label: "record",
      namespace,
      baseItems: base.kv,
      currentItems: current.kv,
      nextItems: next.kv,
      targetItems: target.kv,
      keyFor: snapshotRecordKey
    });
    mergeSnapshotCollection({
      label: "object",
      namespace,
      baseItems: base.objects,
      currentItems: current.objects,
      nextItems: next.objects,
      targetItems: target.objects,
      keyFor: snapshotObjectKey
    });

    const nextEvents = next.log.filter((event) => event.sequence > base.maxSequence);
    if (nextEvents.length > 0) {
      let sequence = Math.max(0, ...target.log.map((event) => event.sequence ?? 0)) + 1;
      for (const event of nextEvents) {
        const reassigned = {
          ...structuredClone(event),
          event_id: `${namespace}:${sequence}`,
          sequence
        };
        target.log.push(reassigned);
        emittedEvents.push(structuredClone(reassigned));
        sequence += 1;
      }
      target.nextSequence = sequence;
    } else {
      target.nextSequence = Math.max(target.nextSequence ?? 1, (Math.max(0, ...target.log.map((event) => event.sequence ?? 0)) + 1));
    }

    merged.namespaces[namespace] = target;
  }

  return { snapshot: merged, events: emittedEvents };
}

function mergeSnapshotCollection({ label, namespace, baseItems, currentItems, nextItems, targetItems, keyFor }) {
  const baseByKey = mapSnapshotItems(baseItems, keyFor);
  const currentByKey = mapSnapshotItems(currentItems, keyFor);
  const nextByKey = mapSnapshotItems(nextItems, keyFor);
  const targetByKey = mapSnapshotItems(targetItems, keyFor);
  const keys = new Set([...baseByKey.keys(), ...nextByKey.keys()]);

  for (const key of keys) {
    const baseValue = baseByKey.get(key);
    const nextValue = nextByKey.get(key);
    if (stableJson(baseValue ?? null) === stableJson(nextValue ?? null)) {
      continue;
    }

    const currentValue = currentByKey.get(key);
    if (stableJson(currentValue ?? null) !== stableJson(baseValue ?? null)) {
      throw new LocalStateConflictError(`Cannot merge ${label} ${namespace}/${key}; it changed concurrently.`);
    }

    if (nextValue === undefined) {
      targetByKey.delete(key);
    } else {
      targetByKey.set(key, structuredClone(nextValue));
    }
  }

  targetItems.splice(0, targetItems.length, ...[...targetByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value));
}

function normalizeSnapshotNamespace(value) {
  const log = value?.log ?? [];
  return {
    kv: value?.kv ?? [],
    objects: value?.objects ?? [],
    log,
    maxSequence: Math.max(0, ...log.map((event) => event.sequence ?? 0))
  };
}

function mapSnapshotItems(items, keyFor) {
  return new Map(items.map((item) => [keyFor(item), item]));
}

function snapshotRecordKey(record) {
  return `${record.primitive}\0${record.key}`;
}

function snapshotObjectKey(object) {
  return `${object.metadata.primitive}\0${object.metadata.key}`;
}

function requireAppName(name) {
  const value = String(name || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value)) {
    throw new TypeError("App name must match ^[a-z0-9][a-z0-9-]{0,62}$");
  }
  return value;
}

function normalizeRuntimeLimitOverrides(value) {
  if (value === undefined) return undefined;
  requirePlainObject(value, "runtime_limits", "deployment request");

  const allowed = new Set(Object.keys(DEFAULT_RUNTIME_LIMITS));
  const normalized = {};
  for (const [key, limit] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Unsupported runtime limit: ${key}`);
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError(`Runtime limit ${key} must be a positive integer`);
    }
    normalized[key] = limit;
  }
  return normalized;
}

export function stateFingerprint(state) {
  return hashBytes(stableJson(state));
}

function requireAgentManifest(manifest) {
  const agentName = String(manifest.agent_name || "").trim();
  if (!agentName) throw new TypeError("Agent manifest requires agent_name");

  let jwksUrl;
  try {
    jwksUrl = new URL(manifest.jwks_uri);
  } catch {
    throw new TypeError("Agent manifest requires an absolute jwks_uri");
  }

  if (!["http:", "https:"].includes(jwksUrl.protocol)) {
    throw new TypeError("Agent manifest jwks_uri must use http or https");
  }

  if (!Array.isArray(manifest.requested_scopes) || manifest.requested_scopes.length === 0) {
    throw new TypeError("Agent manifest requires requested_scopes");
  }

  return {
    agent_name: agentName,
    jwks_uri: jwksUrl.toString(),
    requested_scopes: manifest.requested_scopes.map((scope) => String(scope))
  };
}

function normalizeRequestedScopes(scope) {
  const scopes = Array.isArray(scope)
    ? scope
    : String(scope || "").split(/\s+/u);
  const normalized = scopes.map((entry) => String(entry).trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new TypeError("AuthKit token request requires at least one scope");
  }
  return [...new Set(normalized)];
}

function normalizeIssuer(issuer) {
  if (!issuer) return "https://local.mudrock.dev";
  const url = new URL(issuer);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function encodeLocalToken(claims) {
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = hashBytes(`local-authkit:${payload}`);
  return `mrt_${payload}.${signature}`;
}

function decodeLocalToken(token) {
  const value = String(token || "");
  const match = /^mrt_([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u.exec(value);
  if (!match) {
    throw new TypeError("Invalid AuthKit access token");
  }

  const [, payload, signature] = match;
  if (signature !== hashBytes(`local-authkit:${payload}`)) {
    throw new TypeError("Invalid AuthKit access token signature");
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(base64UrlDecode(payload)).toString("utf8"));
  } catch (error) {
    throw new TypeError("Invalid AuthKit access token payload", { cause: error });
  }

  for (const field of ["iss", "aud", "sub", "agent_id", "owner_id", "scope", "cnf", "iat", "exp", "jti"]) {
    if (!(field in claims)) {
      throw new TypeError(`AuthKit access token is missing ${field}`);
    }
  }
  if (!Array.isArray(claims.scope)) {
    throw new TypeError("AuthKit access token scope must be an array");
  }
  return claims;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}

async function acquireStateLock(statePath) {
  const stateDir = dirname(statePath);
  const lockPath = join(stateDir, `.${basename(statePath)}.lock`);
  const lockToken = randomUUID();

  await mkdir(stateDir, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquired_at: new Date().toISOString(),
          token: lockToken
        }));
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await removeStaleLock(lockPath)) continue;
      await delay(STATE_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleLock(lockPath) {
  try {
    const details = await stat(lockPath);
    const owner = await readLockOwner(lockPath);
    if (owner !== undefined && !isPidAlive(owner.pid)) {
      return removeLockIfUnchanged(lockPath, owner?.token, details.mtimeMs);
    }
    const lockAgeMs = getLockAgeMs(owner, details.mtimeMs);
    if (lockAgeMs < STATE_LOCK_STALE_MS) return false;
    return removeLockIfUnchanged(lockPath, owner?.token, details.mtimeMs);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function removeLockIfUnchanged(lockPath, expectedToken, observedMtimeMs) {
  try {
    const details = await stat(lockPath);
    const owner = await readLockOwner(lockPath);
    if (owner?.token !== expectedToken) return false;
    if (expectedToken === undefined && details.mtimeMs !== observedMtimeMs) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function getLockAgeMs(owner, fallbackMtimeMs) {
  const nowMs = Date.now();
  if (owner?.acquired_at) {
    const acquiredAtMs = Date.parse(owner.acquired_at);
    if (Number.isFinite(acquiredAtMs) && acquiredAtMs <= nowMs) {
      return nowMs - acquiredAtMs;
    }
  }
  const mtimeAgeMs = nowMs - fallbackMtimeMs;
  return mtimeAgeMs < 0 ? 0 : mtimeAgeMs;
}

function isPidAlive(pid) {
  const normalizedPid = Number(pid);
  if (!isValidPid(normalizedPid)) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function isValidPid(pid) {
  const normalizedPid = Number(pid);
  return Number.isInteger(normalizedPid) && normalizedPid > 0;
}

async function readLockOwner(lockPath) {
  try {
    const ownerPath = join(lockPath, "owner.json");
    const raw = await readFile(ownerPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
