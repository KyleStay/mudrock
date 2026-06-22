import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createServeCommandServer } from "../../src/cli/main.js";

test("serve command builds a local platform-backed HTTP server", async () => {
  const statePath = await tempStatePath();
  const { platform, server, url } = createServeCommandServer({
    port: 9999,
    host: "127.0.0.1",
    options: {
      state: statePath,
      userId: "user_ada",
    },
    io: { env: {}, stdout: sink(), stderr: sink(), stdin: null }
  });

  assert.equal(url, "http://127.0.0.1:9999");
  assert.equal(typeof server.listen, "function");
  assert.equal(typeof server.close, "function");

  const createApp = await platform.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "session",
      entrypoint: "index.js",
      source: `
        export default {
          async fetch() {
            return Response.json(await Mudrock.auth.require());
          }
        };
      `
    })
  });
  const created = JSON.parse(createApp.body);
  const invoked = await platform.handle({
    method: "GET",
    path: `/a/${created.namespace}/session`
  });

  assert.deepEqual(JSON.parse(invoked.body), {
    id: "user_ada",
    provider: "local",
    namespace: created.namespace,
  });
});

async function tempStatePath() {
  const dir = await mkdtemp(join(tmpdir(), "mudrock-serve-"));
  return join(dir, "state.json");
}

function sink() {
  return { write() {} };
}
