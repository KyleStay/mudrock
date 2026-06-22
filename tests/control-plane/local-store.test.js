import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  assert.deepEqual(
    dataPlane.snapshot().namespaces[deployed.namespace].log.map((event) => [event.sequence, event.key]),
    [[1, "note:two"], [2, "note:one"]]
  );

  const state = await store.read();
  assert.deepEqual(state.logs.slice(-2).map((row) => row.event).sort(), ["first", "second"]);
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
