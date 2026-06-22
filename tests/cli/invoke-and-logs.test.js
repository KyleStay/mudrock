import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { test } from "node:test";

import { main } from "../../src/cli/main.js";
import { LocalProjectStore } from "../../src/control-plane/local-store.js";
import { ioFor } from "./helpers.js";

test("invoke runs the active local deployment", async () => {
  const statePath = await tempStatePath();
  const deployIo = ioFor({
    statePath,
    stdin: "export default { fetch(request){ return new Response(new URL(request.url).pathname) } }"
  });
  await main(["deploy", "--stdin", "--name", "notes"], deployIo);

  const invokeIo = ioFor({ statePath });
  await main(["invoke", "notes", "/todos"], invokeIo);

  assert.equal(invokeIo.stdout.text(), "/todos\n");

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.logs.at(-1).event, "invocation.completed");
  assert.equal(state.logs.at(-1).method, "GET");
  assert.equal(state.logs.at(-1).path, "/todos");
  assert.equal(state.logs.at(-1).status, 200);
});

test("logs returns local control-plane events for an app", async () => {
  const statePath = await tempStatePath();
  const deployIo = ioFor({
    statePath,
    stdin: "export default { fetch(){ return new Response('ok') } }"
  });
  await main(["deploy", "--stdin", "--name", "notes"], deployIo);

  const logsIo = ioFor({ statePath });
  await main(["logs", "notes"], logsIo);

  const logs = JSON.parse(logsIo.stdout.text());
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "deployment.activated");
});

test("invoke persists database and storage mutations across separate requests", async () => {
  const statePath = await tempStatePath();
  const deployIo = ioFor({ statePath });
  await main(["deploy", "examples/zero-config-notes/index.js", "--name", "notes"], deployIo);

  const createNoteIo = ioFor({ statePath });
  await main([
    "invoke",
    "notes",
    "/notes",
    "--method",
    "POST",
    "--body",
    JSON.stringify({ id: "first", title: "Hello", body: "Persistent state" })
  ], createNoteIo);
  assert.equal(JSON.parse(createNoteIo.stdout.text()).note.id, "first");

  const listIo = ioFor({ statePath });
  await main(["invoke", "notes", "/notes"], listIo);
  assert.equal(JSON.parse(listIo.stdout.text()).notes[0].title, "Hello");

  const uploadIo = ioFor({ statePath });
  await main([
    "invoke",
    "notes",
    "/attachments?note_id=first",
    "--method",
    "POST",
    "--body",
    "attachment text"
  ], uploadIo);
  assert.equal(JSON.parse(uploadIo.stdout.text()).attachment.size, "attachment text".length);

  const readAttachmentIo = ioFor({ statePath });
  await main(["invoke", "notes", "/attachments?note_id=first"], readAttachmentIo);
  assert.equal(JSON.parse(readAttachmentIo.stdout.text()).text, "attachment text");

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const app = state.apps[state.appNames.notes];
  assert.ok(app.data_plane.namespaces[app.namespace].kv.length >= 1);
  assert.equal(app.data_plane.namespaces[app.namespace].objects.length, 1);
});

test("invoke salts local bundle imports so module-scope bindings do not cross apps", async () => {
  const statePath = await tempStatePath();
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
  await main(["deploy", "--stdin", "--name", "alpha"], ioFor({ statePath, stdin: source }));
  await main(["deploy", "--stdin", "--name", "beta"], ioFor({ statePath, stdin: source }));

  const alphaIo = ioFor({ statePath });
  await main(["invoke", "alpha", "/alpha"], alphaIo);

  const betaIo = ioFor({ statePath });
  await main(["invoke", "beta", "/beta"], betaIo);

  assert.deepEqual(JSON.parse(alphaIo.stdout.text()), [
    { key: "alpha", value: { key: "alpha" }, version: "1" }
  ]);
  assert.deepEqual(JSON.parse(betaIo.stdout.text()), [
    { key: "beta", value: { key: "beta" }, version: "1" }
  ]);
});

test("overlapping invokes against one state file preserve both mutations", async () => {
  const statePath = await tempStatePath();
  await main(["deploy", "--stdin", "--name", "overlap"], ioFor({
    statePath,
    stdin: `
      export default {
        async fetch(request) {
          const key = new URL(request.url).pathname.slice(1);
          await new Promise((resolve) => setTimeout(resolve, key === "one" ? 20 : 0));
          await Mudrock.db("store").put(key, { key });
          return new Response(key);
        }
      };
    `
  }));

  const first = ioFor({ statePath });
  const second = ioFor({ statePath });
  await Promise.all([
    main(["invoke", "overlap", "/one"], first),
    main(["invoke", "overlap", "/two"], second)
  ]);

  assert.equal(first.stdout.text(), "one\n");
  assert.equal(second.stdout.text(), "two\n");

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const app = state.apps[state.appNames.overlap];
  const namespace = app.namespace;
  const records = app.data_plane.namespaces[namespace].kv
    .filter((row) => row.primitive === "store")
    .map((row) => [row.key, row.version, row.value])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(records, [
    ["one", "1", { key: "one" }],
    ["two", "1", { key: "two" }]
  ]);
  const events = app.data_plane.namespaces[namespace].log.map((event) => [event.sequence, event.key]);
  assert.deepEqual(events.map(([sequence]) => sequence), [1, 2]);
  assert.deepEqual(events.map(([, key]) => key).sort(), ["one", "two"]);
});

test("invoke rejects oversized responses before persisting data-plane mutations", async () => {
  const statePath = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "test-owner" });
  await store.deploy({
    name: "large",
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
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const app = state.apps[state.appNames.large];
  assert.deepEqual(app.deployments[app.active_deployment_id].runtime_limits, {
    max_response_body_bytes: 5
  });

  const invokeIo = ioFor({ statePath });
  await assert.rejects(
    () => main(["invoke", "large", "/"], invokeIo),
    /max_response_body_bytes/,
  );

  const nextState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(nextState.apps[state.appNames.large].data_plane, { namespaces: {} });
});

test("invoke rejects timed-out responses before persisting data-plane mutations", async () => {
  const statePath = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "test-owner" });
  await store.deploy({
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
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const app = state.apps[state.appNames.slow];
  assert.deepEqual(app.deployments[app.active_deployment_id].runtime_limits, {
    max_wall_ms_per_request: 5
  });

  const invokeIo = ioFor({ statePath });
  await assert.rejects(
    () => main(["invoke", "slow", "/"], invokeIo),
    /max_wall_ms_per_request/,
  );
  await delay(40);

  const nextState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(nextState.apps[state.appNames.slow].data_plane, { namespaces: {} });
});

test("invoke terminates synchronous CPU loops at the wall-clock deadline", async () => {
  const statePath = await tempStatePath();
  const store = new LocalProjectStore({ statePath, ownerId: "test-owner" });
  await store.deploy({
    name: "loop",
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

  const invokeIo = ioFor({ statePath });
  await assert.rejects(
    () => main(["invoke", "loop", "/"], invokeIo),
    /max_wall_ms_per_request/,
  );

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(state.apps[state.appNames.loop].data_plane, { namespaces: {} });
});

async function tempStatePath() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mudrock-cli-"));
  return path.join(tmp, "state.json");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
