import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalDataPlane,
  MudrockRuntimeError,
  createLocalRuntime
} from "../../src/runtime/index.mjs";

function createLimitedRuntime(limits = {}) {
  const dataPlane = new LocalDataPlane();
  const runtime = createLocalRuntime({
    namespace: "ns_limits_contract",
    dataPlane,
    gatewayBaseUrl: "http://local.mudrock.test",
    limits
  });

  return { runtime, dataPlane };
}

function isMudrockError(code, messagePattern) {
  return (error) => {
    assert.equal(error instanceof MudrockRuntimeError, true);
    assert.equal(error.code, code);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  };
}

test("database value limit rejects before committing records or sync events", async () => {
  const { runtime } = createLimitedRuntime({ max_heap_bytes: 256 });
  const notes = runtime.db("notes");

  await assert.rejects(
    notes.put("note:too-large", { body: "x".repeat(1024) }),
    isMudrockError("MUDROCK_RUNTIME_LIMIT_EXCEEDED", /max_heap_bytes/u)
  );

  assert.equal(await notes.get("note:too-large"), null);
  assert.deepEqual(await runtime.sync("notes").list(), []);

  const receipt = await notes.put("note:ok", { title: "small" });
  assert.equal(receipt.sequence, 1);
  assert.equal((await notes.get("note:ok")).title, "small");
});

test("storage request body limit rejects before committing objects or sync events", async () => {
  const { runtime } = createLimitedRuntime({ max_request_body_bytes: 5 });
  const files = runtime.storage("attachments");

  await assert.rejects(
    files.put("attachment:too-large", new Uint8Array(6)),
    isMudrockError("MUDROCK_RUNTIME_LIMIT_EXCEEDED", /max_request_body_bytes/u)
  );

  assert.equal(await files.get("attachment:too-large"), null);
  assert.deepEqual(await runtime.sync("attachments").list(), []);

  const object = await files.put("attachment:ok", new Uint8Array(5));
  assert.equal(object.size, 5);
  assert.equal((await runtime.sync("attachments").list()).length, 1);
});

test("database transaction rolls back staged writes when a limit fails", async () => {
  const { runtime } = createLimitedRuntime({ max_heap_bytes: 256 });
  const notes = runtime.db("notes");

  await notes.put("note:seed", { title: "seed" });

  await assert.rejects(
    notes.transaction(async (tx) => {
      await tx.put("note:staged", { title: "not committed" });
      await tx.put("note:too-large", { body: "x".repeat(1024) });
    }),
    isMudrockError("MUDROCK_RUNTIME_LIMIT_EXCEEDED", /max_heap_bytes/u)
  );

  assert.equal(await notes.get("note:staged"), null);
  assert.equal(await notes.get("note:too-large"), null);
  assert.deepEqual(
    (await runtime.sync("notes").list()).map((event) => [event.operation, event.key]),
    [["put", "note:seed"]]
  );
});

test("primitive and key validation use stable Mudrock error codes", async () => {
  const { runtime } = createLimitedRuntime();

  assert.throws(
    () => runtime.db("___"),
    isMudrockError("MUDROCK_INVALID_PRIMITIVE_NAME", /Invalid Mudrock primitive name/u)
  );

  await assert.rejects(
    runtime.db("notes").put("", { title: "missing key" }),
    isMudrockError("MUDROCK_INVALID_KEY", /non-empty string/u)
  );
});
