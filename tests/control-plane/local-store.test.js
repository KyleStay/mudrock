import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalDataPlane } from "../../src/runtime/index.mjs";
import { LocalProjectStore, LocalStateConflictError } from "../../src/control-plane/local-store.js";

test("LocalProjectStore creates a complete state file from a missing path", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  const deployment = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.owner_id, "owner_test");
  assert.equal(state.appNames.notes, deployment.app_id);
  assert.deepEqual(state.agents, {});
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].event, "deployment.activated");
  assert.equal(state.apps[deployment.app_id].data_plane.namespaces !== undefined, true);
});

test("LocalProjectStore rejects app names outside the public gateway contract", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  await assert.rejects(
    () => store.deploy({
      name: "notes_api",
      entrypoint: "index.js",
      source: "export default { fetch(){ return new Response('ok') } }"
    }),
    /App name must match \^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\$/
  );
});

test("LocalProjectStore persists validated runtime limit overrides on deployments", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  const deployment = await store.deploy({
    name: "limits",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }",
    runtime_limits: {
      max_wall_ms_per_request: 25,
      max_response_body_bytes: 128
    }
  });

  assert.deepEqual(deployment.deployment.runtime_limits, {
    max_wall_ms_per_request: 25,
    max_response_body_bytes: 128
  });

  await assert.rejects(
    () => store.deploy({
      name: "bad-limits",
      entrypoint: "index.js",
      source: "export default { fetch(){ return new Response('ok') } }",
      runtime_limits: { max_files: 1 }
    }),
    /Unsupported runtime limit/
  );
});

test("LocalProjectStore issues and verifies local AuthKit agent tokens", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const registration = await store.claimAgent({
    agent_name: "builder",
    jwks_uri: "https://agent.test/jwks.json",
    requested_scopes: ["apps:create", "apps:deploy", "logs:read"]
  }, {
    apiBase: "https://api.test",
    authBase: "https://auth.test"
  });

  const token = await store.issueAgentToken({
    grant_type: "client_credentials",
    client_id: registration.client_id,
    scope: "apps:create logs:read"
  }, {
    issuer: "https://auth.test",
    audience: "https://api.test"
  });

  assert.match(token.access_token, /^mrt_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u);
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.expires_in, 900);
  assert.equal(token.scope, "apps:create logs:read");

  const claims = await store.verifyAgentToken(token.access_token, { required_scopes: ["logs:read"] });
  assert.equal(claims.iss, "https://auth.test");
  assert.equal(claims.aud, "https://api.test");
  assert.equal(claims.sub, registration.agent_id);
  assert.equal(claims.agent_id, registration.agent_id);
  assert.equal(claims.owner_id, "owner_test");
  assert.deepEqual(claims.scope, ["apps:create", "logs:read"]);
  assert.equal(typeof claims.cnf, "object");
  assert.equal(typeof claims.jti, "string");

  await assert.rejects(
    () => store.issueAgentToken({
      grant_type: "client_credentials",
      client_id: registration.client_id,
      scope: "admin:all"
    }),
    /Requested scopes are not approved/
  );
});

test("LocalProjectStore migrates state missing current top-level fields", async () => {
  const { statePath } = await tempStatePath();
  await writeFile(statePath, JSON.stringify({ owner_id: "legacy_owner" }));

  const state = await new LocalProjectStore({ statePath, ownerId: "fallback_owner" }).read();

  assert.deepEqual(state, {
    version: 1,
    owner_id: "legacy_owner",
    appNames: {},
    apps: {},
    agents: {},
    oauthStates: {},
    logs: []
  });
});

test("LocalProjectStore rejects malformed JSON state", async () => {
  const { statePath } = await tempStatePath();
  await writeFile(statePath, "{ nope");

  const store = new LocalProjectStore({ statePath });

  await assert.rejects(
    () => store.read(),
    /Failed to parse Mudrock local state/
  );
});

test("LocalProjectStore rejects wrong-shaped persisted fields", async () => {
  const { statePath } = await tempStatePath();
  await writeFile(statePath, JSON.stringify({ appNames: [], logs: {} }));

  const store = new LocalProjectStore({ statePath });

  await assert.rejects(
    () => store.read(),
    /appNames must be an object/
  );
});

test("LocalProjectStore writes through a single final state file", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath });

  await store.write({ logs: [{ event: "manual" }] });

  const entries = await readdir(stateDir);
  assert.deepEqual(entries, ["state.json"]);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.logs[0].event, "manual");
  assert.deepEqual(state.appNames, {});
  assert.deepEqual(state.apps, {});
  assert.deepEqual(state.agents, {});
});

test("LocalProjectStore preserves concurrent appendLog calls across store instances", async () => {
  const { statePath } = await tempStatePath();
  const first = new LocalProjectStore({ statePath });
  const second = new LocalProjectStore({ statePath });

  await Promise.all([
    first.appendLog({ event: "first" }),
    second.appendLog({ event: "second" })
  ]);

  const state = await first.read();
  assert.deepEqual(state.logs.map((row) => row.event).sort(), ["first", "second"]);
});

test("LocalProjectStore reclaims stale locks before continuing", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const staleLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const oldAt = new Date(Date.now() - 10 * 60_000);

  await rm(staleLock, { recursive: true, force: true });
  await mkdir(staleLock, { recursive: true });
  await writeFile(join(staleLock, "owner.json"), JSON.stringify({ pid: 99999, acquired_at: oldAt.toISOString() }));
  await utimes(staleLock, oldAt, oldAt);

  await store.appendLog({ event: "reclaimed" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["reclaimed"]);
  await assert.rejects(
    async () => readFile(join(staleLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore reclaims stale locks based on acquired_at metadata when owner is not running", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const staleLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const staleAcquiredAt = new Date(Date.now() - (5 * 60_000 + 60_000));

  const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => deadOwner.once("exit", resolve));

  await rm(staleLock, { recursive: true, force: true });
  await mkdir(staleLock, { recursive: true });
  await writeFile(join(staleLock, "owner.json"), JSON.stringify({
    pid: deadOwner.pid,
    acquired_at: staleAcquiredAt.toISOString()
  }));
  await utimes(staleLock, new Date(), new Date());

  await store.appendLog({ event: "acquired-at-reclaimed" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["acquired-at-reclaimed"]);
  await assert.rejects(
    async () => readFile(join(staleLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore falls back to mtime when acquired_at metadata is malformed", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const staleLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const staleMtime = new Date(Date.now() - (5 * 60_000 + 60_000));

  const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => deadOwner.once("exit", resolve));

  await rm(staleLock, { recursive: true, force: true });
  await mkdir(staleLock, { recursive: true });
  await writeFile(join(staleLock, "owner.json"), JSON.stringify({
    pid: deadOwner.pid,
    acquired_at: "not-a-real-timestamp"
  }));
  await utimes(staleLock, staleMtime, staleMtime);

  await store.appendLog({ event: "fallback-age-reclaimed" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["fallback-age-reclaimed"]);
  await assert.rejects(
    async () => readFile(join(staleLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore falls back to mtime when owner metadata file is missing", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const staleLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const staleMtime = new Date(Date.now() - (5 * 60_000 + 60_000));

  await rm(staleLock, { recursive: true, force: true });
  await mkdir(staleLock, { recursive: true });
  await utimes(staleLock, staleMtime, staleMtime);

  await store.appendLog({ event: "missing-owner-file-reclaimed" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["missing-owner-file-reclaimed"]);
  await assert.rejects(
    async () => readFile(join(staleLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore falls back to mtime when acquired_at metadata is in the future", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const staleLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const staleMtime = new Date(Date.now() - (5 * 60_000 + 60_000));
  const futureAcquiredAt = new Date(Date.now() + 60_000);

  const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise((resolve) => deadOwner.once("exit", resolve));

  await rm(staleLock, { recursive: true, force: true });
  await mkdir(staleLock, { recursive: true });
  await writeFile(join(staleLock, "owner.json"), JSON.stringify({
    pid: deadOwner.pid,
    acquired_at: futureAcquiredAt.toISOString()
  }));
  await utimes(staleLock, staleMtime, staleMtime);

  await store.appendLog({ event: "future-acquired-at-fallback" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["future-acquired-at-fallback"]);
  await assert.rejects(
    async () => readFile(join(staleLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore reclaims stale locks when owner metadata is malformed", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const malformedLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const oldAt = new Date(Date.now() - 10 * 60_000);

  await rm(malformedLock, { recursive: true, force: true });
  await mkdir(malformedLock, { recursive: true });
  await writeFile(join(malformedLock, "owner.json"), "not valid json");
  await utimes(malformedLock, oldAt, oldAt);

  await store.appendLog({ event: "malformed-owner-reclaimed" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["malformed-owner-reclaimed"]);
  await assert.rejects(
    async () => readFile(join(malformedLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore reclaims lock with invalid owner metadata", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const invalidPidLock = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  await rm(invalidPidLock, { recursive: true, force: true });
  await mkdir(invalidPidLock, { recursive: true });
  await writeFile(join(invalidPidLock, "owner.json"), JSON.stringify({ pid: 0, acquired_at: new Date().toISOString() }));

  await store.appendLog({ event: "invalid-owner-reclaimed" });

  const state = await store.read();
  assert.deepEqual(state.logs.map((row) => row.event), ["invalid-owner-reclaimed"]);
  await assert.rejects(
    async () => readFile(join(invalidPidLock, "owner.json"), "utf8"),
    /ENOENT/
  );
});

test("LocalProjectStore waits for live lock before mutating state", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const lockPath = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  await withLiveOwnerProcess(async (owner) => {
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: String(owner.pid),
      acquired_at: new Date().toISOString()
    }));

    let resolved = false;
    const append = store.appendLog({ event: "blocked" }).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false);

    await rm(lockPath, { recursive: true, force: true });
    await append;

    const state = await store.read();
    assert.equal(state.logs.at(-1).event, "blocked");
  });
});

test("LocalProjectStore waits for live lock when acquired_at is old but process is still running", async () => {
  const { stateDir, statePath } = await tempStatePath();
  const lockPath = join(stateDir, ".state.json.lock");
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  await withLiveOwnerProcess(async (owner) => {
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: owner.pid,
      acquired_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      token: "manual-test-token"
    }));

    let resolved = false;
    const append = store.appendLog({ event: "blocked-by-live-pid" }).then(() => {
      resolved = true;
    });

    const blocked = await waitFor(() => resolved, { timeoutMs: 80, intervalMs: 10 });
    assert.equal(blocked, false, "appendLog should wait while owner process is still alive");

    owner.kill("SIGKILL");
    await new Promise((resolve) => owner.once("exit", resolve));
    await append;
    await assert.rejects(async () => readFile(join(lockPath, "owner.json"), "utf8"), /ENOENT/);

    const state = await store.read();
    assert.equal(state.logs.at(-1).event, "blocked-by-live-pid");
  });
});

test("LocalProjectStore withDataPlaneForApp failure releases lock", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const failed = store.withDataPlaneForApp("notes", async () => {
    throw new Error("boom");
  });
  await assert.rejects(failed, /boom/);

  await store.appendLog({ event: "after-data-plane-failure" });
  const state = await store.read();
  assert.equal(state.logs.at(-1).event, "after-data-plane-failure");
});

test("LocalProjectStore withMergedDataPlaneForApp failure releases lock", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const failed = store.withMergedDataPlaneForApp("notes", async () => {
    throw new Error("boom");
  });
  await assert.rejects(failed, /boom/);

  await store.appendLog({ event: "after-merged-failure" });
  const state = await store.read();
  assert.equal(state.logs.at(-1).event, "after-merged-failure");
});

test("LocalProjectStore returns durable events and snapshot from merged transaction value", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const result = await store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(deployed.namespace, "notes", "note:1", { title: "contract" });
    return {
      value: { ok: true },
      dataPlane,
      logs: [{ event: "contract" }]
    };
  });

  assert.deepEqual(result?.ok, true);
  assert.ok(Array.isArray(result?.durableEvents));
  assert.equal(result.durableEvents.at(-1).key, "note:1");
  assert.equal(result.durableEvents.at(-1).sequence, 1);
  assert.equal(result.durableEvents.at(-1).namespace, deployed.namespace);

  const snapshot = result.dataPlaneSnapshot;
  const persisted = snapshot.namespaces[deployed.namespace];
  assert.ok(Array.isArray(persisted?.kv));
  assert.equal(persisted.kv.at(-1).key, "note:1");

  const state = await store.read();
  assert.equal(state.logs.at(-1).event, "contract");
});

test("LocalProjectStore supports merged transactions with logs-only return", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const result = await store.withMergedDataPlaneForApp("notes", async () => {
    return { logs: [{ event: "merged-logs-only" }] };
  });

  assert.equal(result, undefined);

  const state = await store.read();
  assert.equal(state.logs.at(-1).event, "merged-logs-only");
  const dataPlane = await store.dataPlaneForApp("notes");
  assert.equal(Object.keys(dataPlane.snapshot().namespaces).length, 0);
});

test("LocalProjectStore preserves concurrent deploy and appendLog writes", async () => {
  const { statePath } = await tempStatePath();
  const first = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const second = new LocalProjectStore({ statePath, ownerId: "owner_test" });

  await Promise.all([
    first.deploy({
      name: "notes",
      entrypoint: "index.js",
      source: "export default { fetch(){ return new Response('ok') } }"
    }),
    second.appendLog({ event: "manual" })
  ]);

  const state = await first.read();
  assert.equal(state.appNames.notes.startsWith("app_"), true);
  assert.deepEqual(new Set(state.logs.map((row) => row.event)), new Set(["deployment.activated", "manual"]));
});

test("LocalProjectStore rejects stale direct data-plane commits", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });
  const base = await store.dataPlaneForApp("notes");
  const baseSnapshot = base.snapshot();
  const first = new LocalDataPlane(baseSnapshot);
  const second = new LocalDataPlane(baseSnapshot);

  first.putRecord(deployed.namespace, "notes", "note:1", { title: "one" });
  second.putRecord(deployed.namespace, "notes", "note:2", { title: "two" });

  await store.saveDataPlaneForApp("notes", first, { expectedSnapshot: baseSnapshot });
  await assert.rejects(
    () => store.saveDataPlaneForApp("notes", second, { expectedSnapshot: baseSnapshot }),
    (error) => error instanceof LocalStateConflictError && error.code === "MUDROCK_LOCAL_STATE_CONFLICT"
  );

  const dataPlane = await store.dataPlaneForApp("notes");
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:1"), { title: "one" });
  assert.equal(dataPlane.getRecord(deployed.namespace, "notes", "note:2"), null);
});

test("LocalProjectStore data-plane transactions commit data and logs atomically", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  await store.withDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:1", { title: "atomic" });
    return {
      dataPlane,
      logs: [{ app: app.name, namespace: app.namespace, event: "invocation.completed" }]
    };
  });

  const state = await store.read();
  assert.equal(state.logs.at(-1).event, "invocation.completed");
  const dataPlane = await store.dataPlaneForApp("notes");
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:1"), { title: "atomic" });
});

test("LocalProjectStore non-merged data-plane failures do not persist mutations or logs", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const failed = store.withDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:1", { title: "rolled-back" });
    throw new Error("boom");
  });

  await assert.rejects(failed, /boom/);

  const dataPlane = await store.dataPlaneForApp("notes");
  assert.equal(dataPlane.getRecord(deployed.namespace, "notes", "note:1"), null);

  const state = await store.read();
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs.at(-1).event, "deployment.activated");
});

test("LocalProjectStore merged data-plane transactions preserve independent stale-base writes", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  let releaseFirst;
  const firstCanCommit = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:one", { title: "one" });
    await firstCanCommit;
    return {
      dataPlane,
      logs: [{ event: "first" }]
    };
  });
  const second = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:two", { title: "two" });
    releaseFirst();
    return {
      dataPlane,
      logs: [{ event: "second" }]
    };
  });

  await Promise.all([first, second]);

  const dataPlane = await store.dataPlaneForApp("notes");
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:one"), { title: "one" });
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:two"), { title: "two" });
  const log = dataPlane.snapshot().namespaces[deployed.namespace].log.map((event) => [event.sequence, event.key]);
  const sequences = log.map(([sequence]) => sequence);
  const keys = log.map(([, key]) => key);
  assert.deepEqual([...new Set(sequences)].sort((left, right) => left - right), [1, 2]);
  assert.deepEqual([...new Set(keys)].sort(), ["note:one", "note:two"]);

  const state = await store.read();
  assert.deepEqual(state.logs.slice(-2).map((row) => row.event).sort(), ["first", "second"]);
});

test("LocalProjectStore merged data-plane transactions preserve sequence continuity when a stale base is retried", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  let releaseSeed;
  const seedCanCommit = new Promise((resolve) => {
    releaseSeed = resolve;
  });
  const seeded = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:seed", { title: "seed" });
    await seedCanCommit;
    return {
      dataPlane,
      logs: [{ event: "seed" }],
      value: { label: "seed" }
    };
  });

  const second = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:next", { title: "next" });
    return {
      dataPlane,
      logs: [{ event: "next" }],
      value: { label: "second" }
    };
  });
  releaseSeed();
  const [seededResult, secondResult] = await Promise.all([seeded, second]);
  assert.deepEqual(seededResult.label, "seed");
  assert.equal(Array.isArray(seededResult.durableEvents), true);
  assert.equal(Array.isArray(secondResult.durableEvents), true);
  const seededSequence = seededResult.durableEvents.at(-1).sequence;
  const secondSequence = secondResult.durableEvents.at(-1).sequence;
  assert.equal(typeof seededSequence, "number");
  assert.equal(typeof secondSequence, "number");
  assert.equal(new Set([seededSequence, secondSequence]).size, 2);
  assert.equal(Math.max(seededSequence, secondSequence) - Math.min(seededSequence, secondSequence), 1);
  assert.equal(seededResult.durableEvents.at(-1).key, "note:seed");
  assert.equal(secondResult.durableEvents.at(-1).key, "note:next");
  assert.equal(seededResult.durableEvents.at(-1).event_id, `${deployed.namespace}:${seededResult.durableEvents.at(-1).sequence}`);
  assert.equal(secondResult.durableEvents.at(-1).event_id, `${deployed.namespace}:${secondResult.durableEvents.at(-1).sequence}`);
  assert.deepEqual(secondResult.label, "second");

  const dataPlane = await store.dataPlaneForApp("notes");
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:seed"), { title: "seed" });
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:next"), { title: "next" });
});

test("LocalProjectStore merged data-plane transactions do not persist rolled-back writes", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  const failed = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:one", { title: "rolled-back" });
    throw new Error("boom");
  });

  await assert.rejects(failed, /boom/);

  const dataPlane = await store.dataPlaneForApp("notes");
  assert.equal(dataPlane.getRecord(deployed.namespace, "notes", "note:one"), null);

  const state = await store.read();
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs.at(-1).event, "deployment.activated");

  await store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane: nextDataPlane }) => {
    nextDataPlane.putRecord(app.namespace, "notes", "note:two", { title: "kept" });
    return { dataPlane: nextDataPlane, logs: [{ event: "second" }] };
  });

  const recovered = await store.dataPlaneForApp("notes");
  assert.deepEqual(recovered.getRecord(deployed.namespace, "notes", "note:two"), { title: "kept" });
});

test("LocalProjectStore merged data-plane transactions reject same-key conflicts", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  const deployed = await store.deploy({
    name: "notes",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  let releaseFirst;
  let firstStarted;
  const firstHasBase = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const firstCanCommit = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:shared", { title: "first" });
    firstStarted();
    await firstCanCommit;
    return { dataPlane };
  });
  await firstHasBase;
  const second = store.withMergedDataPlaneForApp("notes", async ({ app, dataPlane }) => {
    dataPlane.putRecord(app.namespace, "notes", "note:shared", { title: "second" });
    return { dataPlane };
  });

  await second;
  releaseFirst();
  await assert.rejects(
    first,
    (error) => error instanceof LocalStateConflictError && error.code === "MUDROCK_LOCAL_STATE_CONFLICT"
  );

  const dataPlane = await store.dataPlaneForApp("notes");
  assert.deepEqual(dataPlane.getRecord(deployed.namespace, "notes", "note:shared"), { title: "second" });
});

test("LocalProjectStore merged data-plane transactions reject same-object storage conflicts", async () => {
  const { statePath } = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "owner_test" });
  await store.deploy({
    name: "files",
    entrypoint: "index.js",
    source: "export default { fetch(){ return new Response('ok') } }"
  });

  let releaseFirst;
  let firstStarted;
  const firstHasBase = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const firstCanCommit = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = store.withMergedDataPlaneForApp("files", async ({ app, dataPlane }) => {
    const runtime = createRuntimeForTest(app.namespace, dataPlane);
    await runtime.storage("files").put("avatar", new TextEncoder().encode("first"));
    firstStarted();
    await firstCanCommit;
    return { dataPlane };
  });
  await firstHasBase;
  const second = store.withMergedDataPlaneForApp("files", async ({ app, dataPlane }) => {
    const runtime = createRuntimeForTest(app.namespace, dataPlane);
    await runtime.storage("files").put("avatar", new TextEncoder().encode("second"));
    return { dataPlane };
  });

  await second;
  releaseFirst();
  await assert.rejects(
    first,
    (error) => error instanceof LocalStateConflictError && /object/u.test(error.message)
  );

  const dataPlane = await store.dataPlaneForApp("files");
  const app = await store.getApp("files");
  const object = dataPlane.getObject(app.namespace, "files", "avatar");
  assert.equal(new TextDecoder().decode(await object.arrayBuffer()), "second");
});

async function tempStatePath() {
  const stateDir = await mkdtemp(join(tmpdir(), "mudrock-control-plane-"));
  return {
    stateDir,
    statePath: join(stateDir, "state.json")
  };
}

function createRuntimeForTest(namespace, dataPlane) {
  return {
    storage(name) {
      return {
        async put(key, bytes) {
          const now = new Date().toISOString();
          const existing = dataPlane.getObject(namespace, name, key);
          const version = existing ? String(Number(existing.version) + 1) : "1";
          return dataPlane.putObject(namespace, name, {
            primitive: name,
            key,
            version,
            size: bytes.byteLength,
            content_type: null,
            sha256: "test",
            block_size: 1024,
            block_count: bytes.byteLength === 0 ? 0 : 1,
            created_at: existing?.created_at ?? now,
            updated_at: now,
            url: `https://local.test/${key}`,
            bytes
          });
        }
      };
    }
  };
}

async function withLiveOwnerProcess(fn) {
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50000)"]);
  let exited = false;
  owner.once("exit", () => {
    exited = true;
  });
  try {
    return await fn(owner);
  } finally {
    owner.kill("SIGKILL");
    if (!exited) {
      await new Promise((resolve) => owner.once("exit", resolve));
    }
  }
}

async function waitFor(condition, { timeoutMs = 500, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
