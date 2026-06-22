import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { main } from "../../src/cli/main.js";

test("CLI deploy stores an active compiled revision and logs activation", async () => {
  const statePath = await tempStatePath();
  const output = await runCli([
    "deploy",
    "--stdin",
    "--name",
    "notes",
    "--state",
    statePath
  ], "export default { fetch(){ return Response.json({ ok: true }) } }");

  const deployment = JSON.parse(output);
  assert.equal(deployment.deployment.status, "active");
  assert.match(deployment.app_id, /^app_/u);
  assert.match(deployment.namespace, /^ns_/u);

  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.logs[0].event, "deployment.activated");
  assert.equal(state.apps[deployment.app_id].deployments[deployment.deployment.deployment_id].source_sha256, deployment.deployment.source_sha256);
  assert.equal(Object.hasOwn(state.apps[deployment.app_id].deployments[deployment.deployment.deployment_id], "source"), false);
});

test("CLI invoke executes the active bundle with Mudrock runtime bindings", async () => {
  const statePath = await tempStatePath();
  await runCli([
    "deploy",
    "--stdin",
    "--name",
    "hello",
    "--state",
    statePath
  ], `
    export default {
      async fetch() {
        const db = Mudrock.db("store");
        await db.put("one", { ok: true });
        return Response.json(await db.list());
      }
    };
  `);

  const output = await runCli(["invoke", "hello", "/", "--state", statePath]);
  assert.deepEqual(JSON.parse(output), [{ key: "one", value: { ok: true }, version: "1" }]);
});

test("CLI omd claim emits discovery metadata", async () => {
  const output = await runCli(["omd", "claim", "--api-base", "http://127.0.0.1:8787"]);
  const claim = JSON.parse(output);

  assert.equal(claim.api_base, "http://127.0.0.1:8787");
  assert.ok(claim.capabilities.includes("deploy.raw_source"));
  assert.ok(claim.capabilities.includes("sync.sse"));
  assert.equal(claim.capabilities.includes("sync.websocket"), false);
});

async function runCli(argv, input = "") {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  await main(argv, {
    stdin: Readable.from([input]),
    stdout,
    stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    env: {}
  });

  return output;
}

async function tempStatePath() {
  const dir = await mkdtemp(join(tmpdir(), "mudrock-cli-"));
  return join(dir, "state.json");
}
