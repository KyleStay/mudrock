import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";

import { LocalDataPlane, createLocalRuntime } from "./index.mjs";
import { importLocalBundle, runWithMudrockRuntime } from "./local-invocation.js";

try {
  sanitizeAppGlobals();

  const dataPlane = new LocalDataPlane(workerData.data_plane_snapshot);
  const runtime = createLocalRuntime({
    namespace: workerData.namespace,
    dataPlane,
    gatewayBaseUrl: workerData.gateway_base_url,
    authContext: workerData.auth_context,
    limits: workerData.limits,
  });
  const module = await importLocalBundle(workerData.bundle_text, {
    namespace: workerData.namespace,
    buildId: workerData.build_id,
    deploymentId: workerData.deployment_id,
  });
  const response = await runWithMudrockRuntime(
    runtime,
    () => module.default.fetch(materializeRequest(workerData.request), {}, {}),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());

  parentPort.postMessage({
    ok: true,
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body_base64: Buffer.from(bytes).toString("base64"),
    },
    data_plane_snapshot: dataPlane.snapshot(),
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name,
      message: error?.message ?? String(error),
      code: error?.code,
      stack: error?.stack,
    },
  });
}

function materializeRequest(request) {
  const body = request.body_base64 === undefined
    ? undefined
    : Buffer.from(request.body_base64, "base64");

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function sanitizeAppGlobals() {
  for (const name of ["WebAssembly", "eval", "fetch", "module", "process", "require"]) {
    try {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: false,
        value: undefined,
        writable: false,
      });
    } catch {
      // Some host globals may not be configurable on future runtimes.
    }
  }
}
