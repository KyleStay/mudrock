import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  DEFAULT_RUNTIME_LIMITS,
  LocalDataPlane,
  MudrockRuntimeError,
  createLocalRuntime,
  normalizePrimitiveName,
} from "../../src/runtime/index.mjs";

test("normalizes primitive names to Mudrock's local primitive pattern", () => {
  assert.equal(normalizePrimitiveName(), "default");
  assert.equal(normalizePrimitiveName("Store One"), "store-one");
  assert.equal(normalizePrimitiveName("__Accounts__"), "accounts");
  assert.equal(normalizePrimitiveName("cache_v2"), "cache_v2");

  assert.throws(
    () => normalizePrimitiveName("___"),
    (error) => error instanceof MudrockRuntimeError && error.code === "MUDROCK_INVALID_PRIMITIVE_NAME",
  );
  assert.throws(
    () => normalizePrimitiveName("a".repeat(64)),
    /Invalid Mudrock primitive name/,
  );
});

test("database bindings are namespace-scoped and emit committed mutation receipts", async () => {
  const dataPlane = new LocalDataPlane();
  const alpha = createLocalRuntime({ namespace: "owner-a.app", dataPlane });
  const beta = createLocalRuntime({ namespace: "owner-b.app", dataPlane });

  const alphaDb = alpha.db("Store");
  const betaDb = beta.db("store");

  const receipt = await alphaDb.put("user:1", { name: "Ada", visits: 1 });
  assert.deepEqual(receipt, {
    event_id: "owner-a.app:1",
    namespace: "owner-a.app",
    primitive: "store",
    key: "user:1",
    operation: "put",
    version: "1",
    sequence: 1,
    occurred_at: receipt.occurred_at,
  });

  assert.deepEqual(await alphaDb.get("user:1"), { name: "Ada", visits: 1 });
  assert.equal(await betaDb.get("user:1"), null);

  const patchReceipt = await alphaDb.patch("user:1", { visits: 2 });
  assert.equal(patchReceipt.operation, "patch");
  assert.equal(patchReceipt.version, "2");
  assert.deepEqual(await alphaDb.get("user:1"), { name: "Ada", visits: 2 });

  await alphaDb.put("user:2", { name: "Grace" });
  await alphaDb.put("note:1", { text: "hello" });
  assert.deepEqual(await alphaDb.list({ prefix: "user:" }), [
    { key: "user:1", value: { name: "Ada", visits: 2 }, version: "2" },
    { key: "user:2", value: { name: "Grace" }, version: "1" },
  ]);
});

test("database values are cloned across the runtime boundary", async () => {
  const runtime = createLocalRuntime({ namespace: "clone-test" });
  const db = runtime.db("store");
  const value = { nested: { count: 1 } };

  await db.put("item", value);
  value.nested.count = 999;

  const stored = await db.get("item");
  assert.deepEqual(stored, { nested: { count: 1 } });

  stored.nested.count = 1000;
  assert.deepEqual(await db.get("item"), { nested: { count: 1 } });
});

test("database transactions stage writes and commit mutation events together", async () => {
  const runtime = createLocalRuntime({ namespace: "transaction.app" });
  const db = runtime.db("store");

  const result = await db.transaction(async (tx) => {
    const firstReceipt = await tx.put("item:1", { count: 1 });
    await tx.patch("item:1", { count: 2 });
    await tx.put("item:2", { count: 3 });

    assert.deepEqual(await tx.get("item:1"), { count: 2 });
    assert.deepEqual(await tx.list({ prefix: "item:" }), [
      { key: "item:1", value: { count: 2 }, version: "2" },
      { key: "item:2", value: { count: 3 }, version: "1" },
    ]);
    return firstReceipt;
  });

  assert.equal(result.sequence, 1);
  assert.deepEqual(await db.list({ prefix: "item:" }), [
    { key: "item:1", value: { count: 2 }, version: "2" },
    { key: "item:2", value: { count: 3 }, version: "1" },
  ]);

  const events = await runtime.sync("store").events();
  assert.deepEqual(events.map((event) => [event.sequence, event.operation, event.key, event.version]), [
    [1, "put", "item:1", "1"],
    [2, "patch", "item:1", "2"],
    [3, "put", "item:2", "1"],
  ]);
});

test("database transactions roll back staged writes and mutation events on failure", async () => {
  const runtime = createLocalRuntime({ namespace: "rollback.app" });
  const db = runtime.db("store");
  await db.put("stable", { ok: true });

  await assert.rejects(
    () => db.transaction(async (tx) => {
      await tx.put("unstable", { ok: false });
      await tx.delete("stable");
      throw new Error("abort transaction");
    }),
    /abort transaction/,
  );

  assert.deepEqual(await db.get("stable"), { ok: true });
  assert.equal(await db.get("unstable"), null);
  assert.deepEqual(
    (await runtime.sync("store").events()).map((event) => [event.sequence, event.operation, event.key]),
    [[1, "put", "stable"]],
  );
});

test("runtime exposes frozen default limits through host bindings", () => {
  const runtime = createLocalRuntime({ namespace: "limits.app" });

  assert.deepEqual(runtime.limits, DEFAULT_RUNTIME_LIMITS);
  assert.equal(Object.isFrozen(runtime.limits), true);
  assert.strictEqual(runtime.db("store").limits, runtime.limits);
  assert.strictEqual(runtime.storage("files").limits, runtime.limits);
  assert.strictEqual(runtime.sync("store").limits, runtime.limits);
});

test("runtime limit overrides are validated and applied to database values", async () => {
  assert.throws(
    () => createLocalRuntime({ limits: { max_heap_bytes: 0 } }),
    (error) => error instanceof MudrockRuntimeError && error.code === "MUDROCK_INVALID_RUNTIME_LIMIT",
  );

  const runtime = createLocalRuntime({
    namespace: "db-limits.app",
    limits: { max_heap_bytes: 96 },
  });
  const db = runtime.db("store");

  await db.put("small", { text: "ok" });
  await assert.rejects(
    () => db.put("large", { text: "x".repeat(256) }),
    (error) => error instanceof MudrockRuntimeError && error.code === "MUDROCK_RUNTIME_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    () => db.patch("small", { text: "x".repeat(256) }),
    /max_heap_bytes/,
  );
  assert.deepEqual(await db.get("small"), { text: "ok" });
});

test("storage put records object metadata and logs storage mutations", async () => {
  const runtime = createLocalRuntime({
    namespace: "files.app",
    gatewayBaseUrl: "https://gateway.test",
  });
  const storage = runtime.storage();

  const object = await storage.put("avatar.png", new Uint8Array([1, 2, 3, 4]), {
    contentType: "image/png",
    blockSize: 2,
  });

  assert.equal(object.primitive, "default");
  assert.equal(object.key, "avatar.png");
  assert.equal(object.size, 4);
  assert.equal(object.content_type, "image/png");
  assert.equal(object.block_size, 2);
  assert.equal(object.block_count, 2);
  assert.equal(object.version, "1");
  assert.equal(object.sha256, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
  assert.equal(object.url, "https://gateway.test/a/files.app/__mudrock/storage/default/avatar.png?version=1");

  assert.deepEqual(await storage.get("avatar.png"), object);

  const events = await runtime.sync().events();
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "storage.put");
  assert.deepEqual(events[0].payload, object);

  const emptyObject = await storage.put("empty.bin", new Uint8Array());
  assert.equal(emptyObject.size, 0);
  assert.equal(emptyObject.block_count, 0);
});

test("storage accepts web streams and node streams", async () => {
  const runtime = createLocalRuntime({ namespace: "stream-test" });
  const storage = runtime.storage("files");

  const webObject = await storage.put(
    "web",
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2, 3]));
        controller.close();
      },
    }),
  );
  assert.equal(webObject.size, 3);

  const nodeObject = await storage.put("node", Readable.from([Buffer.from([4, 5])]));
  assert.equal(nodeObject.size, 2);
});

test("storage enforces request body byte limits for buffers and streams", async () => {
  const runtime = createLocalRuntime({
    namespace: "storage-limits.app",
    limits: { max_request_body_bytes: 3 },
  });
  const storage = runtime.storage("files");

  await storage.put("small", new Uint8Array([1, 2, 3]));
  await assert.rejects(
    () => storage.put("large", new Uint8Array([1, 2, 3, 4])),
    (error) => error instanceof MudrockRuntimeError && error.code === "MUDROCK_RUNTIME_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    () => storage.put("stream", Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4])])),
    /max_request_body_bytes/,
  );
  assert.equal(await storage.get("large"), null);
  assert.equal(await storage.get("stream"), null);
});

test("sync exposes replay and change subscriptions for committed mutations", async () => {
  const runtime = createLocalRuntime({ namespace: "sync.app" });
  const db = runtime.db("store");
  const sync = runtime.sync("store");
  const seen = [];
  const unsubscribe = sync.on("change", (event) => seen.push(event));

  await db.put("one", { ok: true });
  await db.delete("one");
  await waitForMicrotasks();
  unsubscribe();
  await db.put("two", { ok: true });
  await waitForMicrotasks();

  assert.deepEqual(seen.map((event) => event.operation), ["put", "delete"]);

  const replayed = await sync.since(1);
  assert.deepEqual(
    replayed.map((event) => [event.sequence, event.operation, event.key]),
    [
      [2, "delete", "one"],
      [3, "put", "two"],
    ],
  );

  assert.deepEqual(await sync.list(2), [replayed[1]]);
});

test("Mudrock binding is frozen and exposes scoped primitive factories", () => {
  const runtime = createLocalRuntime({ namespace: "frozen.app" });

  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.db("store")), true);
  assert.equal(Object.isFrozen(runtime.storage("files")), true);
  assert.equal(Object.isFrozen(runtime.sync("store")), true);
});

test("auth binding exposes namespace-scoped users and sign-in routes", async () => {
  const runtime = createLocalRuntime({
    namespace: "auth.app",
    gatewayBaseUrl: "https://gateway.test",
    authContext: {
      user: {
        id: "user_ada",
        provider: "github",
      },
    },
  });

  assert.deepEqual(await runtime.auth.currentUser(), {
    id: "user_ada",
    provider: "github",
    namespace: "auth.app",
  });
  assert.equal((await runtime.auth.require()).id, "user_ada");
  assert.equal(
    await runtime.auth.signIn("github", { redirectPath: "/session" }),
    "https://gateway.test/a/auth.app/__mudrock/auth/start?provider=github&redirect_path=%2Fsession",
  );

  await assert.rejects(
    () => createLocalRuntime({ namespace: "auth.app" }).auth.require(),
    (error) => error instanceof MudrockRuntimeError && error.code === "MUDROCK_AUTH_REQUIRED",
  );
});

test("data plane snapshots restore records, storage bytes, and mutation logs", async () => {
  const originalPlane = new LocalDataPlane();
  const original = createLocalRuntime({
    namespace: "snapshot.app",
    dataPlane: originalPlane,
    gatewayBaseUrl: "https://gateway.test",
  });

  await original.db("notes").put("note:1", { title: "Persistent" });
  const storedObject = await original.storage("attachments").put("attachment:1", new TextEncoder().encode("hello"));

  const restoredPlane = new LocalDataPlane(originalPlane.snapshot());
  const restored = createLocalRuntime({
    namespace: "snapshot.app",
    dataPlane: restoredPlane,
    gatewayBaseUrl: "https://gateway.test",
  });

  assert.deepEqual(await restored.db("notes").get("note:1"), { title: "Persistent" });

  const restoredObject = await restored.storage("attachments").get("attachment:1");
  assert.equal(restoredObject.sha256, storedObject.sha256);
  assert.equal(new TextDecoder().decode(await restoredObject.arrayBuffer()), "hello");

  const restoredEvents = await restored.sync("attachments").events();
  assert.deepEqual(restoredEvents.map((event) => [event.sequence, event.operation, event.key]), [
    [2, "storage.put", "attachment:1"],
  ]);
});

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}
