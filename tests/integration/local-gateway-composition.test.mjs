import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalPlatform } from "../../src/gateway/local-platform.js";

const exampleSourceUrl = new URL("../../examples/zero-config-notes/index.js", import.meta.url);

test("local gateway composes deploy, invoke, sync, and persisted state", async () => {
  const statePath = join(await mkdtemp(join(tmpdir(), "mudrock-gateway-")), "state.json");
  const source = await readFile(exampleSourceUrl, "utf8");
  const first = localPlatform({ statePath });

  const discovery = await handleJson(first, { method: "GET", path: "/.well-known/omd.json" });
  assert.equal(discovery.api_base, "http://local.mudrock.test");

  const created = await handleJson(first, {
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify({
      name: "zero-config-notes",
      entrypoint: "examples/zero-config-notes/index.js",
      source,
      runtime: "v8-isolate"
    })
  });
  assert.match(created.app_id, /^app_/u);
  assert.match(created.namespace, /^ns_/u);
  assert.equal(created.deployment.status, "active");

  const note = await handleJson(first, {
    method: "POST",
    path: `/a/${created.namespace}/notes`,
    body: JSON.stringify({
      id: "first",
      title: "Gateway",
      body: "persist me"
    })
  });
  assert.equal(note.note.owner, "anonymous");
  assert.equal(note.receipt.operation, "put");

  const second = localPlatform({ statePath });

  const manifest = await handleJson(second, {
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/manifest`
  });
  assert.equal(manifest.active_deployment_id, created.deployment.deployment_id);
  assert.deepEqual(manifest.detected_primitives, [
    { kind: "auth", name: "default" },
    { kind: "db", name: "notes" },
    { kind: "storage", name: "attachments" }
  ]);

  const list = await handleJson(second, {
    method: "GET",
    path: `/a/${created.namespace}/notes`
  });
  assert.equal(list.notes.length, 1);
  assert.equal(list.notes[0].id, "first");
  assert.equal(list.notes[0].title, "Gateway");

  const sync = await second.handle({
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/sync?primitive=notes`
  });
  assert.equal(sync.statusCode, 200);
  assert.match(sync.headers["content-type"] || "", /^text\/event-stream/u);
  assert.match(sync.body, /^retry: 1000\n\nid: ns_[^:]+:1\nevent: mutation/u);
  assert.match(sync.body, /event: mutation/u);
  assert.match(sync.body, /"operation":"put"/u);
  assert.match(sync.body, /"key":"note:first"/u);

  const resume = await second.handle({
    method: "GET",
    path: `/a/${created.namespace}/__mudrock/sync?primitive=notes`,
    headers: { "last-event-id": `${created.namespace}:1` }
  });
  assert.equal(resume.statusCode, 200);
  assert.equal(resume.body, "retry: 1000\n\n");
});

function localPlatform({ statePath }) {
  return createLocalPlatform({
    statePath,
    ownerId: "owner_gateway",
    apiBase: "http://local.mudrock.test",
    authBase: "http://local.mudrock.test",
    gatewayBaseUrl: "http://local.mudrock.test"
  });
}

async function handleJson(platform, request) {
  const response = await platform.handle(request);
  assert.equal(response.statusCode >= 200 && response.statusCode < 300, true, response.body);
  return JSON.parse(response.body);
}
