import assert from "node:assert/strict";
import { test } from "node:test";

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
