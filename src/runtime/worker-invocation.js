import { Worker } from "node:worker_threads";

import { LocalInvocationTimeoutError } from "./local-invocation.js";

export async function invokeLocalBundleInWorker({
  authContext,
  buildId,
  bundleText,
  dataPlaneSnapshot,
  deploymentId,
  gatewayBaseUrl,
  limits,
  namespace,
  request,
  timeoutMs,
}) {
  const resourceLimits = workerResourceLimits(limits);
  const worker = new Worker(new URL("./invocation-worker.mjs", import.meta.url), {
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
    workerData: {
      auth_context: authContext,
      build_id: buildId,
      bundle_text: bundleText,
      data_plane_snapshot: dataPlaneSnapshot,
      deployment_id: deploymentId,
      gateway_base_url: gatewayBaseUrl,
      limits,
      namespace,
      request: await serializeRequest(request),
    },
  });

  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", (message) => {
        if (message.ok) {
          resolve({
            response: materializeResponse(message.response),
            dataPlaneSnapshot: message.data_plane_snapshot,
          });
          return;
        }

        reject(materializeError(message.error));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`Mudrock invocation worker exited with code ${code}.`));
        }
      });

      if (timeoutMs !== undefined && timeoutMs !== null) {
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          reject(new TypeError("Invocation timeout must be a positive integer."));
          return;
        }
        timeout = setTimeout(() => {
          worker.terminate()
            .finally(() => reject(new LocalInvocationTimeoutError(timeoutMs)));
        }, timeoutMs);
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function workerResourceLimits(limits = {}) {
  if (!Number.isSafeInteger(limits.max_heap_bytes) || limits.max_heap_bytes <= 0) {
    return undefined;
  }
  const maxOldGenerationSizeMb = Math.max(1, Math.ceil((limits.max_heap_bytes ?? 0) / (1024 * 1024)));
  return { maxOldGenerationSizeMb };
}

async function serializeRequest(request) {
  const bytes = request.body === null
    ? undefined
    : new Uint8Array(await request.arrayBuffer());

  return {
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    ...(bytes === undefined ? {} : { body_base64: Buffer.from(bytes).toString("base64") }),
  };
}

function materializeResponse(response) {
  return new Response(Buffer.from(response.body_base64 ?? "", "base64"), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function materializeError(error) {
  const materialized = new Error(error?.message ?? "Mudrock invocation worker failed.");
  materialized.name = error?.name ?? "Error";
  if (error?.code) materialized.code = error.code;
  if (error?.stack) materialized.stack = error.stack;
  return materialized;
}
