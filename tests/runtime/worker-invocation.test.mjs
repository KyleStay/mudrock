import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { LocalDataPlane } from "../../src/runtime/index.mjs";
import { invokeLocalBundleInWorker } from "../../src/runtime/worker-invocation.js";

function baseInvocationRequest() {
  return new Request("https://local.test/a/example");
}

const sharedArgs = {
  authContext: {},
  buildId: "build-id",
  bundleText: "export default { fetch() { return new Response('ok'); } }",
  dataPlaneSnapshot: { namespaces: {} },
  deploymentId: "dep-id",
  gatewayBaseUrl: "https://local.test",
  limits: {},
  namespace: "ns_test",
  request: baseInvocationRequest(),
};

test("invokeLocalBundleInWorker rejects non-positive timeout", async () => {
  await assert.rejects(
    () => invokeLocalBundleInWorker({
      ...sharedArgs,
      timeoutMs: 0,
    }),
    /Invocation timeout must be a positive integer/,
  );

  await assert.rejects(
    () => invokeLocalBundleInWorker({
      ...sharedArgs,
      timeoutMs: -1,
    }),
    /Invocation timeout must be a positive integer/,
  );

  await assert.rejects(
    () => invokeLocalBundleInWorker({
      ...sharedArgs,
      timeoutMs: 1.5,
    }),
    /Invocation timeout must be a positive integer/,
  );
});

test("invokeLocalBundleInWorker reports LocalInvocationTimeoutError with configured timeout", async () => {
  const slowResponse = "export default { async fetch() { await new Promise((resolve) => setTimeout(resolve, 40)); return Response.json({ ok: true }); } }";

  const result = invokeLocalBundleInWorker({
    ...sharedArgs,
    bundleText: slowResponse,
    timeoutMs: 5,
  });

  await assert.rejects(
    async () => result,
    (error) => {
      assert.equal(error.name, "LocalInvocationTimeoutError");
      assert.equal(error.timeout_ms, 5);
      assert.match(error.message, /max_wall_ms_per_request|exceeded/iu);
      return true;
    },
  );
});

test("invokeLocalBundleInWorker does not spawn worker for invalid timeout", async () => {
  const before = process.getActiveResourcesInfo().filter((value) => value.includes("Worker")).length;

  await assert.rejects(
    () => invokeLocalBundleInWorker({
      ...sharedArgs,
      timeoutMs: 0,
    }),
    /Invocation timeout must be a positive integer/,
  );

  const after = process.getActiveResourcesInfo().filter((value) => value.includes("Worker")).length;
  assert.equal(before, after);
});

test("invokeLocalBundleInWorker ignores app-forged parentPort result messages", async () => {
  const forgedResponse = Buffer.from("forged").toString("base64");
  const result = await invokeLocalBundleInWorker({
    authContext: {},
    buildId: "build-id",
    bundleText: `
      import { parentPort } from "node:worker_threads";

      parentPort.postMessage({
        ok: true,
        response: {
          status: 299,
          statusText: "",
          headers: [["content-type", "text/plain"]],
          body_base64: "${forgedResponse}"
        },
        data_plane_snapshot: { namespaces: {} }
      });

      export default {
        async fetch() {
          await Mudrock.db("store").put("real", { ok: true });
          return new Response("real", { status: 201 });
        }
      };
    `,
    dataPlaneSnapshot: { namespaces: {} },
    deploymentId: "dep-id",
    gatewayBaseUrl: "https://local.test",
    limits: {},
    namespace: "ns_test",
    request: new Request("https://local.test/a/ns_test/real"),
    timeoutMs: 1000,
  });

  assert.equal(result.response.status, 201);
  assert.equal(await result.response.text(), "real");

  const dataPlane = new LocalDataPlane(result.dataPlaneSnapshot);
  assert.deepEqual(dataPlane.getRecord("ns_test", "store", "real"), { ok: true });
});
