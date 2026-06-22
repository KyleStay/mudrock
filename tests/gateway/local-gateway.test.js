import assert from "node:assert/strict";
import { test } from "node:test";

import { createLocalGateway, GatewayError } from "../../src/gateway/index.js";

test("routes OMD discovery and control-plane deployment endpoints", async () => {
  const calls = [];
  const gateway = createLocalGateway({
    apiBase: "https://gateway.test",
    authBase: "https://auth.test",
    callbacks: {
      createApp(payload) {
        calls.push(["createApp", payload]);
        return {
          app_id: "app_notes",
          namespace: "ns_notes",
          deployment: {
            deployment_id: "dep_1",
            build_id: "bld_1",
            bundle_sha256: "abc",
            runtime: "v8-isolate",
            status: "active"
          }
        };
      },
      createDeployment(appId, payload) {
        calls.push(["createDeployment", appId, payload]);
        return {
          deployment_id: "dep_2",
          build_id: "bld_2",
          bundle_sha256: "def",
          runtime: payload.runtime,
          status: "active"
        };
      }
    }
  });

  const discovery = await gateway.handle({ method: "GET", path: "/.well-known/omd.json" });
  assert.equal(discovery.statusCode, 200);
  assert.equal(discovery.headers["content-type"], "application/json");
  const document = JSON.parse(discovery.body);
  assert.equal(document.api_base, "https://gateway.test");
  assert.ok(document.capabilities.includes("sync.sse"));
  assert.equal(document.capabilities.includes("sync.websocket"), false);

  const created = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "notes",
      entrypoint: "index.js",
      source: "export default {}",
      runtime: "v8-isolate"
    })
  });
  assert.equal(created.statusCode, 200);
  assert.equal(JSON.parse(created.body).app_id, "app_notes");

  const deployment = await gateway.handle({
    method: "POST",
    path: "/v1/apps/app_notes/deployments",
    body: JSON.stringify({ entrypoint: "index.js", source: "export default {}", runtime: "wasm-worker" })
  });
  assert.equal(deployment.statusCode, 200);
  assert.equal(JSON.parse(deployment.body).build_id, "bld_2");

  assert.deepEqual(calls, [
    [
      "createApp",
      {
        name: "notes",
        entrypoint: "index.js",
        source: "export default {}",
        runtime: "v8-isolate"
      }
    ],
    ["createDeployment", "app_notes", { entrypoint: "index.js", source: "export default {}", runtime: "wasm-worker" }]
  ]);
});

test("routes OMD agent registration through the gateway contract", async () => {
  const calls = [];
  const gateway = createLocalGateway({
    callbacks: {
      registerAgent(payload) {
        calls.push(payload);
        return {
          agent_id: "agent_123",
          client_id: "client_123",
          token_endpoint: "https://auth.test/oauth/token",
          approved_scopes: payload.requested_scopes
        };
      }
    }
  });

  const response = await gateway.handle({
    method: "POST",
    path: "/v1/agents/register",
    body: JSON.stringify({
      agent_name: "planner",
      jwks_uri: "https://agent.test/jwks.json",
      requested_scopes: ["apps:create", "logs:read"]
    })
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    agent_id: "agent_123",
    client_id: "client_123",
    token_endpoint: "https://auth.test/oauth/token",
    approved_scopes: ["apps:create", "logs:read"]
  });
  assert.deepEqual(calls, [
    {
      agent_name: "planner",
      jwks_uri: "https://agent.test/jwks.json",
      requested_scopes: ["apps:create", "logs:read"]
    }
  ]);
});

test("routes AuthKit client credentials token requests", async () => {
  const calls = [];
  const gateway = createLocalGateway({
    callbacks: {
      issueToken(payload) {
        calls.push(payload);
        return {
          access_token: "mrt_test.token",
          token_type: "Bearer",
          expires_in: 900,
          scope: payload.scope
        };
      }
    }
  });

  const response = await gateway.handle({
    method: "POST",
    path: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "client_123",
      scope: "apps:create logs:read"
    }).toString()
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    access_token: "mrt_test.token",
    token_type: "Bearer",
    expires_in: 900,
    scope: "apps:create logs:read"
  });
  assert.deepEqual(calls, [{
    grant_type: "client_credentials",
    client_id: "client_123",
    scope: "apps:create logs:read"
  }]);
});

test("optionally enforces AuthKit scopes on control-plane routes", async () => {
  const calls = [];
  const gateway = createLocalGateway({
    requireControlPlaneAuth: true,
    callbacks: {
      verifyToken(token, options) {
        calls.push(["verifyToken", token, options]);
        if (token !== "valid") throw new TypeError("bad token");
        return { agent_id: "agent_1", scope: options.required_scopes };
      },
      createApp(payload) {
        calls.push(["createApp", payload.name]);
        return {
          app_id: "app_notes",
          namespace: "ns_notes",
          deployment: {
            deployment_id: "dep_1",
            build_id: "bld_1",
            bundle_sha256: "abc",
            runtime: "v8-isolate",
            status: "active"
          }
        };
      }
    }
  });

  const missing = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({ name: "notes", entrypoint: "index.js", source: "export default {}" })
  });
  assert.equal(missing.statusCode, 401);

  const denied = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    headers: { authorization: "Bearer wrong" },
    body: JSON.stringify({ name: "notes", entrypoint: "index.js", source: "export default {}" })
  });
  assert.equal(denied.statusCode, 403);
  assert.match(denied.body, /bad token/u);

  const allowed = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    headers: { authorization: "Bearer valid" },
    body: JSON.stringify({ name: "notes", entrypoint: "index.js", source: "export default {}" })
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(JSON.parse(allowed.body).app_id, "app_notes");
  assert.deepEqual(calls, [
    ["verifyToken", "wrong", { required_scopes: ["apps:create"] }],
    ["verifyToken", "valid", { required_scopes: ["apps:create"] }],
    ["createApp", "notes"]
  ]);
});

test("intercepts app health, manifest, and sync reserved paths", async () => {
  const syncCalls = [];
  const gateway = createLocalGateway({
    callbacks: {
      health(namespace) {
        return { ok: true, namespace, region: "local" };
      },
      manifest(namespace) {
        return {
          app_id: "app_notes",
          namespace,
          active_deployment_id: "dep_1",
          primitives: [{ kind: "db", name: "notes" }]
        };
      },
      sync(namespace, options) {
        assert.equal(namespace, "team.notes");
        syncCalls.push(options);
        return [
          {
            event_id: "team.notes:4",
            namespace,
            primitive: "notes",
            key: "note:first",
            operation: "put",
            sequence: 4
          }
        ];
      }
    }
  });

  const health = await gateway.handle({ method: "GET", path: "/a/team.notes/__mudrock/health" });
  assert.deepEqual(JSON.parse(health.body), { ok: true, namespace: "team.notes", region: "local" });

  const manifest = await gateway.handle({ method: "GET", path: "/a/team.notes/__mudrock/manifest" });
  assert.equal(JSON.parse(manifest.body).active_deployment_id, "dep_1");

  const sync = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/sync?primitive=notes&after_sequence=3"
  });
  assert.equal(sync.statusCode, 200);
  assert.equal(sync.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.match(sync.body, /^retry: 1000\n\nid: team\.notes:4\nevent: mutation\ndata: \{"event_id":"team\.notes:4"/u);
  assert.match(sync.body, /\n\n$/u);

  const resumed = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/sync?primitive=notes",
    headers: { "last-event-id": "team.notes:4" }
  });
  assert.equal(resumed.statusCode, 200);

  const invalidResume = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/sync?primitive=notes",
    headers: { "last-event-id": "not-a-sequence" }
  });
  assert.equal(invalidResume.statusCode, 400);
  assert.match(invalidResume.body, /Last-Event-ID/u);

  const mismatchedResume = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/sync?primitive=notes",
    headers: { "last-event-id": "other.notes:4" }
  });
  assert.equal(mismatchedResume.statusCode, 400);
  assert.match(mismatchedResume.body, /namespace does not match/u);

  const websocket = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/sync?primitive=notes",
    headers: { upgrade: "websocket" }
  });
  assert.equal(websocket.statusCode, 501);
  assert.match(websocket.body, /WebSocket sync is not supported/u);

  assert.deepEqual(syncCalls, [
    { primitive: "notes", after_sequence: 3 },
    { primitive: "notes", after_sequence: 4 }
  ]);
});

test("intercepts app auth start, storage object, and logs routes", async () => {
  const calls = [];
  const gateway = createLocalGateway({
    callbacks: {
      authStart(namespace, query) {
        calls.push(["authStart", namespace, query]);
        return { status: "ok", namespace, ...query };
      },
      storageObject(namespace, object) {
        calls.push(["storageObject", namespace, object]);
        return {
          content_type: "text/plain",
          size: 5,
          sha256: "abc123",
          arrayBuffer: async () => new TextEncoder().encode("hello").buffer
        };
      },
      logs(appId, query) {
        calls.push(["logs", appId, query]);
        return {
          statusCode: 200,
          headers: { "content-type": "text/plain" },
          body: "line one\n"
        };
      }
    }
  });

  const auth = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/auth/start?provider=github&redirect_path=/session"
  });
  assert.deepEqual(JSON.parse(auth.body), {
    status: "ok",
    namespace: "team.notes",
    provider: "github",
    redirect_path: "/session"
  });

  const storage = await gateway.handle({
    method: "GET",
    path: "/a/team.notes/__mudrock/storage/files/avatar%3A1"
  });
  assert.equal(storage.statusCode, 200);
  assert.equal(storage.headers["content-type"], "text/plain");
  assert.equal(storage.headers.etag, "\"abc123\"");
  assert.equal(storage.body, "hello");

  const logs = await gateway.handle({
    method: "GET",
    path: "/v1/apps/app_notes/logs?tail=1"
  });
  assert.equal(logs.body, "line one\n");

  assert.deepEqual(calls, [
    ["authStart", "team.notes", { provider: "github", redirect_path: "/session" }],
    ["storageObject", "team.notes", { primitive: "files", key: "avatar:1" }],
    ["logs", "app_notes", { tail: 1 }]
  ]);
});

test("routes non-reserved app paths through invocation callbacks with the spec envelope shape", async () => {
  let envelope;
  let context;
  const gateway = createLocalGateway({
    apiBase: "https://gateway.test",
    now: () => 1_700_000_000_000,
    callbacks: {
      resolveInvocation(namespace) {
        assert.equal(namespace, "team.notes");
        return {
          app_id: "app_notes",
          build_id: "bld_active"
        };
      },
      invoke(nextEnvelope, nextContext) {
        envelope = nextEnvelope;
        context = nextContext;
        return {
          statusCode: 201,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoked: true })
        };
      }
    }
  });

  const result = await gateway.handle({
    method: "POST",
    path: "/a/team.notes/notes/first?expand=true",
    headers: { "x-request-id": "req_1", "content-type": "application/json" },
    body: "{\"title\":\"Hello\"}"
  });

  assert.equal(result.statusCode, 201);
  assert.deepEqual(JSON.parse(result.body), { invoked: true });
  assert.match(envelope.invocation_id, /^inv_/u);
  assert.equal(envelope.app_id, "app_notes");
  assert.equal(envelope.namespace, "team.notes");
  assert.equal(envelope.build_id, "bld_active");
  assert.equal(envelope.method, "POST");
  assert.equal(envelope.url, "https://gateway.test/notes/first?expand=true");
  assert.deepEqual(envelope.headers, [
    ["x-request-id", "req_1"],
    ["content-type", "application/json"]
  ]);
  assert.equal(envelope.deadline_unix_ms, 1_700_000_030_000);
  assert.equal(envelope.body, "{\"title\":\"Hello\"}");
  assert.equal(context.path, "/notes/first");
  assert.equal(context.search, "?expand=true");
});

test("returns gateway errors for bad methods, bad JSON, and missing callbacks", async () => {
  const gateway = createLocalGateway();

  const method = await gateway.handle({ method: "POST", path: "/.well-known/omd.json" });
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, "GET");

  const json = await gateway.handle({ method: "POST", path: "/v1/apps", body: "{" });
  assert.equal(json.statusCode, 400);
  assert.equal(json.body, "Expected JSON request body");

  const missing = await gateway.handle({ method: "GET", path: "/a/team.notes/__mudrock/manifest" });
  assert.equal(missing.statusCode, 501);
  assert.equal(missing.body, "Gateway route is not configured");

  const cursor = await createLocalGateway({
    callbacks: {
      sync() {
        return [];
      }
    }
  }).handle({ method: "GET", path: "/a/team.notes/__mudrock/sync?after_sequence=3abc" });
  assert.equal(cursor.statusCode, 400);
  assert.equal(cursor.body, "after_sequence must be a non-negative integer");

  const explicit = new GatewayError("Nope", { statusCode: 418 });
  assert.equal(explicit.statusCode, 418);
});

test("validates create app and deployment API request contracts", async () => {
  const gateway = createLocalGateway({
    callbacks: {
      createApp(payload) {
        return {
          app_id: "app_ok",
          namespace: "ns_ok",
          received: payload,
          deployment: {
            deployment_id: "dep_ok",
            build_id: "bld_ok",
            bundle_sha256: "sha",
            runtime: payload.runtime ?? "v8-isolate",
            status: "active"
          }
        };
      },
      createDeployment(_appId, payload) {
        return {
          deployment_id: "dep_ok",
          build_id: "bld_ok",
          bundle_sha256: "sha",
          runtime: payload.runtime ?? "v8-isolate",
          status: "active"
        };
      }
    }
  });

  const missing = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({ name: "notes", source: "export default {}" })
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body, "entrypoint is required");

  const badName = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({ name: "Bad Name", entrypoint: "index.js", source: "export default {}" })
  });
  assert.equal(badName.statusCode, 400);
  assert.match(badName.body, /name must match/u);

  const badRuntime = await gateway.handle({
    method: "POST",
    path: "/v1/apps/app_ok/deployments",
    body: JSON.stringify({ entrypoint: "index.js", source: "export default {}", runtime: "container" })
  });
  assert.equal(badRuntime.statusCode, 400);
  assert.match(badRuntime.body, /runtime must/u);

  const forbidden = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "notes",
      entrypoint: "index.js",
      source: "export default {}",
      database: "postgres",
      bucket: "assets",
      oauth_client: "github"
    })
  });
  assert.equal(forbidden.statusCode, 400);
  assert.match(forbidden.body, /Unsupported configuration fields: database, bucket, oauth_client/u);

  const valid = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "notes",
      entrypoint: "index.js",
      source: "export default {}",
      runtime: "wasm-worker"
    })
  });
  assert.deepEqual(JSON.parse(valid.body).received, {
    name: "notes",
    entrypoint: "index.js",
    source: "export default {}",
    runtime: "wasm-worker"
  });
});
