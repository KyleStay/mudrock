import { createServer } from "node:http";

import { LocalStateConflictError, createLocalControlPlane } from "../control-plane/local-store.js";
import { DEFAULT_RUNTIME_LIMITS, LocalDataPlane } from "../runtime/index.mjs";
import { LocalInvocationTimeoutError } from "../runtime/local-invocation.js";
import { invokeLocalBundleInWorker } from "../runtime/worker-invocation.js";
import { GatewayError, createLocalGateway } from "./index.js";

export function createLocalPlatform({
  statePath,
  ownerId = "local",
  apiBase = "http://127.0.0.1:8787",
  authBase = apiBase,
  gatewayBaseUrl = apiBase,
  authContext,
  requireControlPlaneAuth = false
} = {}) {
  const controlPlane = createLocalControlPlane({ statePath, ownerId });
  const invocationQueue = createSerialQueue();
  const syncHub = createLocalSyncHub();

  const gateway = createLocalGateway({
    apiBase,
    authBase,
    requireControlPlaneAuth,
    callbacks: {
      async createApp(payload) {
        return controlPlane.deploy(payload);
      },
      async createDeployment(appId, payload) {
        const app = await controlPlane.getApp(appId);
        return (await controlPlane.deploy({ name: app.name, ...payload })).deployment;
      },
      async resolveInvocation(namespace) {
        const app = await findAppByNamespace(controlPlane, namespace);
        const deployment = app.deployments[app.active_deployment_id];
        return {
          app_id: app.app_id,
          build_id: deployment.build_id,
        };
      },
      async manifest(namespace) {
        const app = await findAppByNamespace(controlPlane, namespace);
        return {
          app_id: app.app_id,
          namespace: app.namespace,
          active_deployment_id: app.active_deployment_id,
          detected_primitives: app.detected_primitives,
        };
      },
      async sync(namespace, { primitive = "default", after_sequence } = {}, context = {}) {
        const app = await findAppByNamespace(controlPlane, namespace);
        const dataPlane = await controlPlane.dataPlaneForApp(app.app_id);
        const events = dataPlane.getEvents(namespace, primitive, { after_sequence });
        if (!context.streaming) return events;
        return {
          events,
          subscribe(listener) {
            return syncHub.subscribe(namespace, primitive, listener);
          }
        };
      },
      async logs(appId, { tail } = {}) {
        const rows = await controlPlane.logs(appId);
        return {
          statusCode: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: rows.slice(tail === undefined ? 0 : -tail)
            .map((row) => JSON.stringify(row))
            .join("\n") + (rows.length > 0 ? "\n" : "")
        };
      },
      async registerAgent(payload) {
        return controlPlane.claimAgent(payload, { apiBase, authBase });
      },
      async issueToken(payload) {
        return controlPlane.issueAgentToken(payload, {
          issuer: authBase,
          audience: apiBase
        });
      },
      async verifyToken(accessToken, options) {
        return controlPlane.verifyAgentToken(accessToken, options);
      },
      async authStart(namespace, { provider, redirect_path }) {
        const flow = await controlPlane.startOAuthFlow(namespace, { provider, redirect_path }, { authBase });
        return {
          statusCode: 302,
          headers: {
            location: flow.authorization_url,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...flow,
            status: "local-auth-redirect"
          })
        };
      },
      async authCallback(provider, query) {
        const session = await controlPlane.completeOAuthCallback(provider, query, { issuer: authBase });
        return {
          statusCode: 302,
          headers: {
            location: session.redirect_path,
            "content-type": "application/json",
            "set-cookie": localSessionCookie(session.access_token, session.expires_in)
          },
          body: JSON.stringify(session)
        };
      },
      async storageObject(namespace, { primitive, key }) {
        const app = await findAppByNamespace(controlPlane, namespace);
        const dataPlane = await controlPlane.dataPlaneForApp(app.app_id);
        return dataPlane.getObject(namespace, primitive, key);
      },
      async invoke(envelope) {
        return invocationQueue.run(() => invokeLocalBundle({
          authContext,
          controlPlane,
          envelope,
          gatewayBaseUrl,
          syncHub
        }));
      },
    }
  });

  return {
    controlPlane,
    gateway,
    async handle(request) {
      return gateway.handle(request);
    },
    createServer() {
      return createServer((req, res) => gateway.handleNodeRequest(req, res));
    },
  };
}

function createLocalSyncHub() {
  const subscribers = new Map();

  return {
    subscribe(namespace, primitive, listener) {
      const key = syncSubscriptionKey(namespace, primitive);
      let listeners = subscribers.get(key);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(key, listeners);
      }
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          subscribers.delete(key);
        }
      };
    },
    publish(events) {
      for (const event of events) {
        const listeners = subscribers.get(syncSubscriptionKey(event.namespace, event.primitive));
        if (!listeners) continue;
        for (const listener of listeners) {
          queueMicrotask(() => listener(structuredClone(event)));
        }
      }
    }
  };
}

function syncSubscriptionKey(namespace, primitive) {
  return `${namespace}\0${primitive}`;
}

function createSerialQueue() {
  let tail = Promise.resolve();

  return {
    run(task) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });

      return previous
        .then(task, task)
        .finally(release);
    }
  };
}

async function invokeLocalBundle({ authContext, controlPlane, envelope, gatewayBaseUrl, syncHub }) {
  try {
    const effectiveAuthContext = await resolveInvocationAuthContext({ authContext, controlPlane, envelope });
    const committed = await controlPlane.withMergedDataPlaneForNamespace(envelope.namespace, async ({
      app,
      dataPlane,
      baseSnapshot
    }) => {
      const deployment = app.deployments[app.active_deployment_id];
      const limits = runtimeLimitsForDeployment(deployment);
      const request = new Request(envelope.url, {
        method: envelope.method,
        headers: Object.fromEntries(envelope.headers ?? []),
        body: envelope.body,
      });
      const result = await invokeLocalBundleInWorker({
        authContext: effectiveAuthContext,
        buildId: deployment.build_id,
        bundleText: deployment.bundle_text,
        dataPlaneSnapshot: baseSnapshot,
        deploymentId: deployment.deployment_id,
        gatewayBaseUrl,
        limits,
        namespace: app.namespace,
        request,
        timeoutMs: effectiveInvocationTimeout(limits, envelope)
      });
      const limitedResponse = await materializeLimitedResponse(result.response, limits.max_response_body_bytes);
      const nextDataPlane = new LocalDataPlane(result.dataPlaneSnapshot);
      return {
        dataPlane: nextDataPlane,
        logs: [{
          app: app.name,
          namespace: app.namespace,
          deployment_id: app.active_deployment_id,
          event: "invocation.completed",
          invocation_id: envelope.invocation_id,
          method: envelope.method,
          path: new URL(envelope.url).pathname,
          status: limitedResponse.status
        }],
        value: { response: limitedResponse }
      };
    });

    syncHub.publish(committed.durableEvents);
    return committed.response;
  } catch (error) {
    const app = await findAppByNamespace(controlPlane, envelope.namespace);
    await controlPlane.appendLog({
      app: app.name,
      namespace: app.namespace,
      deployment_id: app.active_deployment_id,
      event: "invocation.failed",
      invocation_id: envelope.invocation_id,
      method: envelope.method,
      path: new URL(envelope.url).pathname,
      error: error?.message ?? String(error)
    });
    if (error instanceof LocalInvocationTimeoutError) {
      throw new GatewayError(error.message, { statusCode: 504 });
    }
    if (error instanceof LocalStateConflictError) {
      throw new GatewayError(error.message, { statusCode: 409 });
    }
    throw error;
  }
}

async function resolveInvocationAuthContext({ authContext, controlPlane, envelope }) {
  if (authContext !== undefined) return authContext;
  const token = bearerToken(Object.fromEntries(envelope.headers ?? []).authorization);
  if (!token) return undefined;
  try {
    return await controlPlane.verifyAppSessionToken(token, { namespace: envelope.namespace });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new GatewayError(error.message, { statusCode: 401 });
    }
    throw error;
  }
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/iu.exec(String(value || "").trim());
  return match?.[1];
}

function localSessionCookie(accessToken, expiresIn) {
  return [
    `mudrock_session=${accessToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${expiresIn}`
  ].join("; ");
}

function runtimeLimitsForDeployment(deployment) {
  return Object.freeze({
    ...DEFAULT_RUNTIME_LIMITS,
    ...(deployment.runtime_limits ?? {})
  });
}

function effectiveInvocationTimeout(limits, envelope) {
  const runtimeLimit = limits.max_wall_ms_per_request;
  if (!Number.isSafeInteger(envelope.deadline_unix_ms)) return runtimeLimit;

  const remaining = envelope.deadline_unix_ms - Date.now();
  if (remaining <= 0) return 1;
  return Math.min(runtimeLimit, remaining);
}

async function materializeLimitedResponse(response, maxBytes) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new GatewayError(
      `Invocation response exceeds max_response_body_bytes (${bytes.byteLength} bytes > ${maxBytes} bytes).`,
      { statusCode: 502 }
    );
  }

  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function findAppByNamespace(controlPlane, namespace) {
  const state = await controlPlane.read();
  const app = Object.values(state.apps).find((candidate) => candidate.namespace === namespace);
  if (!app) {
    throw new Error(`Unknown Mudrock namespace: ${namespace}`);
  }
  return app;
}
