import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createLocalPlatform } from "../../src/gateway/local-platform.js";

test("local platform composes gateway, control plane, runtime, and sync", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });

  const createApp = await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "notes",
      entrypoint: "index.js",
      source: `
        export default {
          async fetch(request) {
            const url = new URL(request.url);
            const db = Mudrock.db("notes");
            if (url.pathname === "/notes" && request.method === "POST") {
              await db.put("note:1", { title: "Gateway note" });
              return Response.json({ ok: true }, { status: 201 });
            }
            return Response.json(await db.list());
          }
        };
      `
    })
  });
  const created = JSON.parse(createApp.body);
  assert.equal(createApp.statusCode, 200);
  assert.match(created.namespace, /^ns_/);

  const write = await platform.handle({
    method: "POST",
    path: `/a/${created.namespace}/notes`
  });
  assert.equal(write.statusCode, 201);

  const read = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/notes`
  });
  assert.deepEqual(JSON.parse(read.body), [
    { key: "note:1", value: { title: "Gateway note" }, version: "1" }
  ]);

  const manifest = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/manifest`
  });
  assert.equal(JSON.parse(manifest.body).app_id, created.app_id);

  const sync = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/sync?primitive=notes`
  });
  assert.equal(sync.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.match(sync.body, /^retry: 1000\n\nid: ns_[^:]+:1\nevent: mutation\ndata: \{"event_id":"ns_[^"]+:1"/u);

  const logs = await platform.handle({
    method: "GET",
    path: `/v1/apps/${created.app_id}/logs?tail=1`
  });
  assert.match(logs.body, /"event":"invocation\.completed"/u);
  assert.match(logs.body, /"method":"GET"/u);
  assert.match(logs.body, /"status":200/u);

  const auth = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/auth/start?provider=github&redirect_path=/notes`
  });
  assert.equal(auth.statusCode, 302);
  const authBody = JSON.parse(auth.body);
  assert.match(auth.headers.location, /^https:\/\/local\.test\/auth\/callback\/github\?code=local-development-code&state=oauth_/u);
  assert.deepEqual({
    provider: authBody.provider,
    namespace: authBody.namespace,
    redirect_path: authBody.redirect_path,
    status: authBody.status
  }, {
    provider: "github",
    namespace: created.namespace,
    redirect_path: "/notes",
    status: "local-auth-redirect"
  });
});

test("local platform issues namespace-scoped app sessions through OAuth callback", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    authBase: "https://auth.test",
    gatewayBaseUrl: "https://local.test",
  });

  const createApp = await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "session",
      entrypoint: "index.js",
      source: `
        export default {
          async fetch() {
            const user = await Mudrock.auth.require();
            return Response.json(user);
          }
        };
      `
    })
  });
  const created = JSON.parse(createApp.body);

  const start = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/auth/start?provider=github&redirect_path=/session`
  });
  const callbackUrl = new URL(start.headers.location);
  assert.equal(callbackUrl.origin, "https://auth.test");

  const callback = await platform.handle({
    method: "GET",
    path: `${callbackUrl.pathname}${callbackUrl.search}`
  });
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, "/session");
  assert.match(callback.headers["set-cookie"], /^mudrock_session=mrs_/u);
  const session = JSON.parse(callback.body);
  assert.match(session.access_token, /^mrs_/u);
  assert.equal(session.namespace, created.namespace);
  assert.equal(session.user.provider, "github");

  const invocation = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/session`,
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  assert.equal(invocation.statusCode, 200);
  assert.deepEqual(JSON.parse(invocation.body), session.user);

  const replay = await platform.handle({
    method: "GET",
    path: `${callbackUrl.pathname}${callbackUrl.search}`
  });
  assert.equal(replay.statusCode, 400);
  assert.match(replay.body, /already been consumed/u);

  const invalidToken = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/session`,
    headers: { authorization: "Bearer mrs_invalid" }
  });
  assert.equal(invalidToken.statusCode, 401);
  assert.match(invalidToken.body, /Invalid app session token/u);
});

test("local platform serves persisted storage objects through gateway URLs", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });
  const createApp = await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "files",
      entrypoint: "index.js",
      source: `
        export default {
          async fetch(request) {
            const files = Mudrock.storage("attachments");
            if (request.method === "POST") {
              const object = await files.put("attachment:first", request.body);
              return Response.json(object, { status: 201 });
            }
            return new Response("not found", { status: 404 });
          }
        };
      `
    })
  });
  const created = JSON.parse(createApp.body);
  const upload = await platform.handle({
    method: "POST",
    path: `/a/${created.namespace}/upload`,
    body: "attachment text"
  });
  const object = JSON.parse(upload.body);
  const objectPath = new URL(object.url).pathname;

  const download = await platform.handle({
    method: "GET",
    path: objectPath
  });

  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "application/octet-stream");
  assert.equal(download.headers.etag, `"${object.sha256}"`);
  assert.equal(download.body, "attachment text");
});

test("local platform runs app code without exposing host globals", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });
  const previousSecret = globalThis.__mudrockHostSecret;
  globalThis.__mudrockHostSecret = "should-not-leak";

  try {
    const created = JSON.parse((await platform.handle({
      method: "POST",
      path: "/v1/apps",
      body: JSON.stringify({
        name: "isolation",
        entrypoint: "index.js",
        source: `
          export default {
            async fetch() {
              await Mudrock.db("store").put("seen", {
                hostSecret: typeof globalThis["__mudrockHostSecret"],
                processType: typeof globalThis["process"],
                ambientFetch: typeof globalThis["fetch"]
              });
              return Response.json(await Mudrock.db("store").get("seen"));
            }
          };
        `
      })
    })).body);

    const response = await platform.handle({ method: "GET", path: `/a/${created.namespace}/run` });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      hostSecret: "undefined",
      processType: "undefined",
      ambientFetch: "undefined"
    });

    const dataPlane = await platform.controlPlane.dataPlaneForApp(created.app_id);
    assert.deepEqual(dataPlane.getRecord(created.namespace, "store", "seen"), {
      hostSecret: "undefined",
      processType: "undefined",
      ambientFetch: "undefined"
    });
  } finally {
    if (previousSecret === undefined) {
      delete globalThis.__mudrockHostSecret;
    } else {
      globalThis.__mudrockHostSecret = previousSecret;
    }
  }
});

test("local platform salts bundle imports so module-scope bindings do not cross apps", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });
  const source = `
    let db;
    export default {
      async fetch(request) {
        db ??= Mudrock.db("store");
        const key = new URL(request.url).pathname.slice(1);
        await db.put(key, { key });
        return Response.json(await db.list());
      }
    };
  `;
  const alpha = JSON.parse((await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({ name: "alpha-cache", entrypoint: "index.js", source })
  })).body);
  const beta = JSON.parse((await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({ name: "beta-cache", entrypoint: "index.js", source })
  })).body);

  const alphaResponse = await platform.handle({ method: "GET", path: `/a/${alpha.namespace}/alpha` });
  const betaResponse = await platform.handle({ method: "GET", path: `/a/${beta.namespace}/beta` });

  assert.deepEqual(JSON.parse(alphaResponse.body), [
    { key: "alpha", value: { key: "alpha" }, version: "1" }
  ]);
  assert.deepEqual(JSON.parse(betaResponse.body), [
    { key: "beta", value: { key: "beta" }, version: "1" }
  ]);
});

test("local platform registers OMD agents through the advertised endpoint", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    authBase: "https://auth.test",
  });

  const discovery = await platform.handle({ method: "GET", path: "/.well-known/omd.json" });
  const authkit = JSON.parse(discovery.body).authkit;
  const capabilities = JSON.parse(discovery.body).capabilities;
  const registrationEndpoint = authkit.registration_endpoint;
  assert.equal(registrationEndpoint, "https://local.test/v1/agents/register");
  assert.equal(authkit.token_endpoint, "https://auth.test/oauth/token");
  assert.ok(capabilities.includes("sync.sse"));
  assert.equal(capabilities.includes("sync.websocket"), false);

  const registered = await platform.handle({
    method: "POST",
    path: "/v1/agents/register",
    body: JSON.stringify({
      agent_name: "builder",
      jwks_uri: "https://agent.test/jwks.json",
      requested_scopes: ["apps:create", "apps:deploy", "logs:read"]
    })
  });

  assert.equal(registered.statusCode, 200);
  const body = JSON.parse(registered.body);
  assert.match(body.agent_id, /^agent_/u);
  assert.match(body.client_id, /^client_/u);
  assert.equal(body.token_endpoint, "https://auth.test/oauth/token");
  assert.deepEqual(body.approved_scopes, ["apps:create", "apps:deploy", "logs:read"]);

  const token = await platform.handle({
    method: "POST",
    path: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: body.client_id,
      scope: "apps:create logs:read"
    }).toString()
  });

  assert.equal(token.statusCode, 200);
  const tokenBody = JSON.parse(token.body);
  assert.match(tokenBody.access_token, /^mrt_/u);
  assert.equal(tokenBody.token_type, "Bearer");
  assert.equal(tokenBody.expires_in, 900);
  assert.equal(tokenBody.scope, "apps:create logs:read");

  const claims = await platform.controlPlane.verifyAgentToken(tokenBody.access_token, {
    required_scopes: ["apps:create"]
  });
  assert.equal(claims.iss, "https://auth.test");
  assert.equal(claims.aud, "https://local.test");
  assert.equal(claims.agent_id, body.agent_id);

  const denied = await platform.handle({
    method: "POST",
    path: "/oauth/token",
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: body.client_id,
      scope: "admin:all"
    })
  });
  assert.equal(denied.statusCode, 400);
  assert.match(denied.body, /Requested scopes are not approved/u);

  const state = await platform.controlPlane.read();
  assert.equal(Object.keys(state.agents).length, 1);
  assert.deepEqual(Object.values(state.agents)[0].requested_scopes, ["apps:create", "apps:deploy", "logs:read"]);
  assert.equal(state.logs.at(-1).event, "agent.token_issued");
});

test("local platform can require AuthKit scopes for control-plane routes", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    authBase: "https://auth.test",
    requireControlPlaneAuth: true,
  });

  const registered = await platform.handle({
    method: "POST",
    path: "/v1/agents/register",
    body: JSON.stringify({
      agent_name: "builder",
      jwks_uri: "https://agent.test/jwks.json",
      requested_scopes: ["apps:create", "logs:read"]
    })
  });
  const registration = JSON.parse(registered.body);
  const token = await platform.handle({
    method: "POST",
    path: "/oauth/token",
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: registration.client_id,
      scope: "apps:create logs:read"
    })
  });
  const accessToken = JSON.parse(token.body).access_token;

  const missing = await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({ name: "notes", entrypoint: "index.js", source: "export default {}" })
  });
  assert.equal(missing.statusCode, 401);

  const created = await platform.handle({
    method: "POST",
    path: "/v1/apps",
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: "notes", entrypoint: "index.js", source: "export default {}" })
  });
  assert.equal(created.statusCode, 200);
  const app = JSON.parse(created.body);

  const logs = await platform.handle({
    method: "GET",
    path: `/v1/apps/${app.app_id}/logs`,
    headers: { authorization: `Bearer ${accessToken}` }
  });
  assert.equal(logs.statusCode, 200);
  assert.match(logs.body, /deployment\.activated/u);

  const deployOnlyToken = await platform.handle({
    method: "POST",
    path: "/oauth/token",
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: registration.client_id,
      scope: "apps:create"
    })
  });
  const deniedLogs = await platform.handle({
    method: "GET",
    path: `/v1/apps/${app.app_id}/logs`,
    headers: { authorization: `Bearer ${JSON.parse(deployOnlyToken.body).access_token}` }
  });
  assert.equal(deniedLogs.statusCode, 403);
  assert.match(deniedLogs.body, /missing required scopes: logs:read/u);
});

test("local platform rejects timed-out invocations without persisting mutations", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });
  const created = await platform.controlPlane.deploy({
    name: "slow",
    entrypoint: "index.js",
    runtime_limits: { max_wall_ms_per_request: 5 },
    source: `
        export default {
          async fetch() {
            await new Promise((resolve) => setTimeout(resolve, 30));
            await Mudrock.db("store").put("should:not:persist", { ok: false });
            return new Response("late");
          }
        };
      `
  });
  assert.deepEqual(created.deployment.runtime_limits, { max_wall_ms_per_request: 5 });

  const response = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/slow`
  });

  assert.equal(response.statusCode, 504);
  assert.match(response.body, /max_wall_ms_per_request/u);
  await delay(40);

  const dataPlane = await platform.controlPlane.dataPlaneForApp(created.app_id);
  assert.equal(dataPlane.getRecord(created.namespace, "store", "should:not:persist"), null);

  const logs = await platform.controlPlane.logs(created.app_id);
  assert.equal(logs.at(-1).event, "invocation.failed");
  assert.match(logs.at(-1).error, /max_wall_ms_per_request/u);
});

test("local platform terminates synchronous CPU loops at the wall-clock deadline", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });
  const created = await platform.controlPlane.deploy({
    name: "cpu-loop",
    entrypoint: "index.js",
    runtime_limits: { max_wall_ms_per_request: 25 },
    source: `
        export default {
          fetch() {
            while (true) {}
          }
        };
      `
  });

  const response = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/loop`
  });

  assert.equal(response.statusCode, 504);
  assert.match(response.body, /max_wall_ms_per_request/u);

  const dataPlane = await platform.controlPlane.dataPlaneForApp(created.app_id);
  assert.deepEqual(dataPlane.snapshot(), { namespaces: {} });

  const logs = await platform.controlPlane.logs(created.app_id);
  assert.equal(logs.at(-1).event, "invocation.failed");
  assert.match(logs.at(-1).error, /max_wall_ms_per_request/u);
});

test("local platform rejects oversized responses without persisting staged mutations", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
    gatewayBaseUrl: "https://local.test",
  });
  const created = await platform.controlPlane.deploy({
    name: "large-response",
    entrypoint: "index.js",
    runtime_limits: { max_response_body_bytes: 5 },
    source: `
        export default {
          async fetch() {
            await Mudrock.db("store").put("should:not:persist", { ok: false });
            return new Response("01234567890");
          }
        };
      `
  });
  assert.deepEqual(created.deployment.runtime_limits, { max_response_body_bytes: 5 });

  const response = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/too-large`
  });

  assert.equal(response.statusCode, 502);
  assert.match(response.body, /max_response_body_bytes/u);

  const dataPlane = await platform.controlPlane.dataPlaneForApp(created.app_id);
  assert.equal(dataPlane.getRecord(created.namespace, "store", "should:not:persist"), null);

  const logs = await platform.controlPlane.logs(created.app_id);
  assert.equal(logs.at(-1).event, "invocation.failed");
  assert.match(logs.at(-1).error, /max_response_body_bytes/u);
});

test("local platform live SSE publishes committed mutations after snapshot save", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
  });
  const created = await platform.controlPlane.deploy({
    name: "live-notes",
    entrypoint: "index.js",
    source: `
        export default {
          async fetch() {
            await Mudrock.db("notes").put("note:live", { title: "Live" });
            return new Response("ok");
          }
        };
      `
  });
  const sync = await openSseStream(platform, `/a/${created.namespace}/__mudrock/sync?primitive=notes`);
  try {
    const invoke = await platform.handle({
      method: "GET",
      path: `/a/${created.namespace}/write`
    });
    assert.equal(invoke.statusCode, 200);

    const event = await sync.nextEvent();
    assert.equal(event.id, `${created.namespace}:1`);
    assert.equal(event.name, "mutation");
    assert.deepEqual(JSON.parse(event.data), {
      event_id: `${created.namespace}:1`,
      namespace: created.namespace,
      primitive: "notes",
      key: "note:live",
      operation: "put",
      version: "1",
      sequence: 1,
      payload: { title: "Live" },
      occurred_at: JSON.parse(event.data).occurred_at
    });

    const dataPlane = await platform.controlPlane.dataPlaneForApp(created.app_id);
    assert.deepEqual(dataPlane.getRecord(created.namespace, "notes", "note:live"), { title: "Live" });
  } finally {
    sync.close();
  }
});

test("local platform live SSE does not publish rolled-back oversized response mutations", async () => {
  const platform = createLocalPlatform({
    statePath: await tempStatePath(),
    ownerId: "owner_123",
    apiBase: "https://local.test",
  });
  const created = await platform.controlPlane.deploy({
    name: "live-rollback",
    entrypoint: "index.js",
    runtime_limits: { max_response_body_bytes: 5 },
    source: `
        export default {
          async fetch() {
            await Mudrock.db("notes").put("note:rollback", { title: "Nope" });
            return new Response("01234567890");
          }
        };
      `
  });
  const sync = await openSseStream(platform, `/a/${created.namespace}/__mudrock/sync?primitive=notes`);
  try {
    const invoke = await platform.handle({
      method: "GET",
      path: `/a/${created.namespace}/write`
    });
    assert.equal(invoke.statusCode, 502);
    assert.equal(await sync.nextEvent({ timeoutMs: 60 }), null);

    const dataPlane = await platform.controlPlane.dataPlaneForApp(created.app_id);
    assert.equal(dataPlane.getRecord(created.namespace, "notes", "note:rollback"), null);
  } finally {
    sync.close();
  }
});

async function tempStatePath() {
  const dir = await mkdtemp(join(tmpdir(), "mudrock-platform-"));
  return join(dir, "state.json");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openSseStream(platform, path) {
  const abort = new AbortController();
  const response = await platform.gateway.handle({
    method: "GET",
    path,
    signal: abort.signal,
    streaming: true
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(typeof response.stream?.[Symbol.asyncIterator], "function");

  const parser = createSseParser();
  const waiters = [];
  const events = [];
  const firstChunk = new Promise((resolve, reject) => {
    pumpSseStream(response.stream, {
      abort,
      parser,
      events,
      waiters,
      onFirstChunk: resolve
    }).catch(reject);
  });
  await firstChunk;

  return {
    nextEvent({ timeoutMs = 1000 } = {}) {
      if (events.length > 0) return Promise.resolve(events.shift());
      return new Promise((eventResolve) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onEvent);
          if (index !== -1) waiters.splice(index, 1);
          eventResolve(null);
        }, timeoutMs);
        function onEvent(event) {
          clearTimeout(timer);
          eventResolve(event);
        }
        waiters.push(onEvent);
      });
    },
    close() {
      abort.abort();
    }
  };
}

async function pumpSseStream(stream, { abort, parser, events, waiters, onFirstChunk }) {
  let sawChunk = false;
  try {
    for await (const chunk of stream) {
      if (!sawChunk) {
        sawChunk = true;
        onFirstChunk();
      }
      for (const event of parser.push(String(chunk))) {
        const waiter = waiters.shift();
        if (waiter) waiter(event);
        else events.push(event);
      }
    }
  } finally {
    if (!sawChunk) onFirstChunk();
    while (waiters.length > 0) waiters.shift()(null);
    abort.abort();
  }
}

function createSseParser() {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk;
      const events = [];
      while (buffer.includes("\n\n")) {
        const index = buffer.indexOf("\n\n");
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = parseSseEvent(raw);
        if (event) events.push(event);
      }
      return events;
    }
  };
}

function parseSseEvent(raw) {
  const event = { name: "message", data: "" };
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) event.id = line.slice(4);
    else if (line.startsWith("event: ")) event.name = line.slice(7);
    else if (line.startsWith("data: ")) event.data += `${line.slice(6)}\n`;
  }
  if (!event.id && event.name === "message" && event.data === "") return null;
  event.data = event.data.replace(/\n$/u, "");
  return event;
}
