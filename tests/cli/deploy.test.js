import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main } from "../../src/cli/main.js";
import { ioFor } from "./helpers.js";

test("deploy posts stdin source into the local control plane", async () => {
  const statePath = await tempStatePath();
  const io = ioFor({ statePath, stdin: "export default { fetch(){ return new Response('ok') } }" });

  await main(["deploy", "--stdin", "--name", "notes"], io);

  const output = JSON.parse(io.stdout.text());
  assert.equal(output.deployment.status, "active");
  assert.equal(output.detected_primitives.length, 0);

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.appNames.notes, output.app_id);
  assert.equal(state.logs[0].event, "deployment.activated");
});

test("deploy derives app name from a source file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mudrock-cli-"));
  const statePath = path.join(tmp, "state.json");
  const sourcePath = path.join(tmp, "Todo App.js");
  await fs.writeFile(sourcePath, "export default { fetch(){ return Response.json({ ok: true }) } }");
  const io = ioFor({ statePath });

  await main(["deploy", sourcePath], io);

  const output = JSON.parse(io.stdout.text());
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.apps[output.app_id].name, "todo-app");
  assert.equal(state.apps[output.app_id].entrypoint, sourcePath);
});

async function tempStatePath() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mudrock-cli-"));
  return path.join(tmp, "state.json");
}
