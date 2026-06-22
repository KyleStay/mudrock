import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { LOCAL_MUDROCK_CAPABILITIES, buildOmdDocument } from "../omd/manifest.js";

const DEFAULT_BASE_URL = "https://local.mudrock.dev";
const JSON_HEADERS = Object.freeze({ "content-type": "application/json" });
const TEXT_HEADERS = Object.freeze({ "content-type": "text/plain; charset=utf-8" });
const OCTET_STREAM_HEADERS = Object.freeze({ "content-type": "application/octet-stream" });
const SSE_HEADERS = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive"
});

export class GatewayError extends Error {
  constructor(message, { statusCode = 500, headers = TEXT_HEADERS, body } = {}) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.headers = headers;
    this.body = body ?? message;
  }
}

export class LocalGateway {
  constructor({
    apiBase = DEFAULT_BASE_URL,
    authBase = DEFAULT_BASE_URL,
    controlPlane,
    callbacks = {},
    now = () => Date.now(),
    invocationTimeoutMs = 30_000,
    requireControlPlaneAuth = false,
    capabilities = LOCAL_MUDROCK_CAPABILITIES
  } = {}) {
    this.apiBase = normalizeBase(apiBase);
    this.authBase = normalizeBase(authBase);
    this.controlPlane = controlPlane;
    this.callbacks = callbacks;
    this.now = now;
    this.invocationTimeoutMs = invocationTimeoutMs;
    this.requireControlPlaneAuth = requireControlPlaneAuth;
    this.capabilities = [...capabilities];
  }

  async handle(request) {
    const normalized = normalizeGatewayRequest(request, this.apiBase);

    try {
      return await this.#route(normalized);
    } catch (error) {
      if (error instanceof GatewayError) return response(error.statusCode, error.headers, error.body);
      return response(500, TEXT_HEADERS, error?.message || "Internal gateway error");
    }
  }

  async handleNodeRequest(req, res) {
    const abortController = new AbortController();
    res.once("close", () => abortController.abort());
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));

    const result = await this.handle({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      signal: abortController.signal,
      streaming: true
    });

    res.writeHead(result.statusCode, result.headers);
    if (result.stream) {
      try {
        for await (const chunk of result.stream) {
          if (res.destroyed) break;
          res.write(chunk);
        }
      } finally {
        res.end();
      }
      return;
    }

    res.end(result.body);
  }

  async #route(request) {
    if (request.pathname === "/.well-known/omd.json") {
      requireMethod(request, "GET");
      return jsonResponse(await this.#omdDocument(request));
    }

    if (request.pathname === "/v1/apps") {
      requireMethod(request, "POST");
      await this.#authorizeControlPlane(request, "apps:create");
      const payload = validateCreateAppRequest(parseJsonBody(request.body));
      return jsonResponse(await callRequired(this.#createApp(), payload, requestContext(request)));
    }

    const deploymentMatch = matchDeploymentPath(request.pathname);
    if (deploymentMatch) {
      requireMethod(request, "POST");
      await this.#authorizeControlPlane(request, "apps:deploy");
      const payload = validateCreateDeploymentRequest(parseJsonBody(request.body));
      const deployment = await callRequired(
        this.#createDeployment(),
        deploymentMatch.appId,
        payload,
        requestContext(request)
      );
      return jsonResponse(deployment);
    }

    if (request.pathname === "/v1/agents/register") {
      requireMethod(request, "POST");
      const payload = validateAgentRegistrationRequest(parseJsonBody(request.body));
      return jsonResponse(await callRequired(this.#registerAgent(), payload, requestContext(request)));
    }

    if (request.pathname === "/oauth/token") {
      requireMethod(request, "POST");
      const payload = validateAgentTokenRequest(parseTokenBody(request));
      try {
        return jsonResponse(await callRequired(this.#issueToken(), payload, requestContext(request)));
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (error instanceof TypeError) {
          throw new GatewayError(error.message, { statusCode: 400 });
        }
        throw error;
      }
    }

    const oauthCallbackMatch = matchOAuthCallbackPath(request.pathname);
    if (oauthCallbackMatch) {
      requireMethod(request, "GET");
      try {
        return normalizeCallbackResponse(await callRequired(
          this.callbacks.authCallback,
          oauthCallbackMatch.provider,
          {
            code: request.url.searchParams.get("code"),
            state: request.url.searchParams.get("state")
          },
          requestContext(request)
        ));
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (error instanceof TypeError) {
          throw new GatewayError(error.message, { statusCode: 400 });
        }
        throw error;
      }
    }

    const logsMatch = matchLogsPath(request.pathname);
    if (logsMatch) {
      requireMethod(request, "GET");
      await this.#authorizeControlPlane(request, "logs:read");
      const logs = await callRequired(
        this.callbacks.logs,
        logsMatch.appId,
        {
          tail: parseOptionalInteger(request.url.searchParams.get("tail"))
        },
        requestContext(request)
      );
      return normalizeCallbackResponse(logs);
    }

    const appRoute = matchAppRoute(request.pathname);
    if (!appRoute) {
      return response(404, TEXT_HEADERS, "Not found");
    }

    if (appRoute.appPath === "/__mudrock/health") {
      requireMethod(request, "GET");
      return jsonResponse(await callOptional(
        this.callbacks.health,
        { ok: true, namespace: appRoute.namespace },
        appRoute.namespace,
        requestContext(request)
      ));
    }

    if (appRoute.appPath === "/__mudrock/manifest") {
      requireMethod(request, "GET");
      return jsonResponse(await callRequired(
        this.callbacks.manifest,
        appRoute.namespace,
        requestContext(request)
      ));
    }

    if (appRoute.appPath === "/__mudrock/sync") {
      requireMethod(request, "GET");
      if (isWebSocketUpgrade(request)) {
        throw new GatewayError("WebSocket sync is not supported by this local gateway", { statusCode: 501 });
      }
      const afterSequence = parseSyncAfterSequence(request);
      const events = await callRequired(
        this.callbacks.sync,
        appRoute.namespace,
        {
          primitive: request.url.searchParams.get("primitive") || "default",
          after_sequence: afterSequence
        },
        requestContext(request)
      );
      if (request.streaming && isLiveSyncSource(events)) {
        return streamingResponse(200, SSE_HEADERS, toSseStream(events, {
          retryMs: 1000,
          signal: request.signal
        }));
      }
      return response(200, SSE_HEADERS, await toSseText(events, { retryMs: 1000 }));
    }

    if (appRoute.appPath === "/__mudrock/auth/start") {
      requireMethod(request, "GET");
      const result = await callOptional(
        this.callbacks.authStart,
        {
          provider: request.url.searchParams.get("provider") || "github",
          redirect_path: request.url.searchParams.get("redirect_path") || "/",
          namespace: appRoute.namespace,
          status: "local-auth-started"
        },
        appRoute.namespace,
        {
          provider: request.url.searchParams.get("provider") || "github",
          redirect_path: request.url.searchParams.get("redirect_path") || "/"
        },
        requestContext(request)
      );
      return normalizeCallbackResponse(result);
    }

    const storageMatch = matchStoragePath(appRoute.appPath);
    if (storageMatch) {
      requireMethod(request, "GET");
      const object = await callRequired(
        this.callbacks.storageObject,
        appRoute.namespace,
        storageMatch,
        requestContext(request)
      );
      return normalizeStorageResponse(object);
    }

    const envelope = await this.#invocationEnvelope(request, appRoute);
    return normalizeCallbackResponse(await callRequired(
      this.callbacks.invoke,
      envelope,
      {
        ...requestContext(request),
        namespace: appRoute.namespace,
        path: appRoute.appPath,
        search: request.url.search
      }
    ));
  }

  #createApp() {
    return this.callbacks.createApp ?? this.controlPlane?.deploy?.bind(this.controlPlane);
  }

  #createDeployment() {
    return this.callbacks.createDeployment ?? (this.controlPlane && (async (appId, payload) => {
      const app = await this.controlPlane.getApp(appId);
      const name = app?.name ?? appId;
      const result = await this.controlPlane.deploy({ name, ...payload });
      return result.deployment;
    }));
  }

  #registerAgent() {
    return this.callbacks.registerAgent ?? (this.controlPlane && ((payload) => {
      return this.controlPlane.claimAgent(payload, {
        apiBase: this.apiBase,
        authBase: this.authBase
      });
    }));
  }

  #issueToken() {
    return this.callbacks.issueToken ?? (this.controlPlane && ((payload) => {
      return this.controlPlane.issueAgentToken(payload, {
        issuer: this.authBase,
        audience: this.apiBase
      });
    }));
  }

  async #authorizeControlPlane(request, requiredScope) {
    if (!this.requireControlPlaneAuth) return null;
    const accessToken = bearerToken(request.headers.authorization);
    if (!accessToken) {
      throw new GatewayError("Missing bearer token", { statusCode: 401 });
    }

    try {
      const verifier = this.callbacks.verifyToken
        ?? this.controlPlane?.verifyAgentToken?.bind(this.controlPlane);
      return await callRequired(verifier, accessToken, { required_scopes: [requiredScope] }, requestContext(request));
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error instanceof TypeError) {
        throw new GatewayError(error.message, { statusCode: 403 });
      }
      throw error;
    }
  }

  async #omdDocument(request) {
    if (this.callbacks.omd) {
      return this.callbacks.omd(requestContext(request));
    }

    return buildOmdDocument({
      apiBase: this.apiBase,
      authBase: this.authBase,
      capabilities: this.capabilities
    });
  }

  async #invocationEnvelope(request, appRoute) {
    const resolved = await callOptional(
      this.callbacks.resolveInvocation,
      {},
      appRoute.namespace,
      requestContext(request)
    ) ?? {};
    const url = new URL(appRoute.appPath + request.url.search, this.apiBase);

    return {
      invocation_id: resolved.invocation_id ?? `inv_${randomUUID()}`,
      app_id: resolved.app_id ?? appRoute.namespace,
      namespace: appRoute.namespace,
      build_id: resolved.build_id ?? "local",
      method: request.method,
      url: url.toString(),
      headers: headersToPairs(request.headers),
      deadline_unix_ms: resolved.deadline_unix_ms ?? this.now() + this.invocationTimeoutMs,
      ...(request.body === "" ? {} : { body: request.body })
    };
  }
}

export function createLocalGateway(options = {}) {
  return new LocalGateway(options);
}

function normalizeGatewayRequest(request, apiBase) {
  const method = String(request.method || "GET").toUpperCase();
  const path = request.path ?? request.url ?? "/";
  const url = new URL(path, apiBase);

  return {
    method,
    url,
    pathname: url.pathname,
    headers: normalizeHeaders(request.headers ?? {}),
    body: request.body === undefined || request.body === null ? "" : String(request.body),
    signal: request.signal,
    streaming: request.streaming === true
  };
}

function normalizeBase(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeHeaders(headers) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  }

  return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const headerValue = Array.isArray(value) ? value.join(", ") : value;
    return [key.toLowerCase(), String(headerValue)];
  }));
}

function headersToPairs(headers) {
  return Object.entries(headers).map(([key, value]) => [key, value]);
}

function requestContext(request) {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    streaming: request.streaming
  };
}

function bearerToken(value) {
  const match = /^Bearer\s+(.+)$/iu.exec(String(value || "").trim());
  return match?.[1];
}

function isWebSocketUpgrade(request) {
  return request.headers.upgrade?.toLowerCase() === "websocket";
}

function requireMethod(request, expected) {
  if (request.method !== expected) {
    throw new GatewayError("Method not allowed", {
      statusCode: 405,
      headers: { ...TEXT_HEADERS, allow: expected }
    });
  }
}

function parseJsonBody(body) {
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new GatewayError("Expected JSON request body", { statusCode: 400 });
  }
}

function parseTokenBody(request) {
  if (request.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(request.body));
  }
  return parseJsonBody(request.body);
}

function validateCreateAppRequest(payload) {
  requireObjectPayload(payload, "CreateAppRequest");
  rejectUnknownFields(payload, ["name", "entrypoint", "source", "runtime"]);
  requireString(payload, "name");
  requireString(payload, "entrypoint");
  requireString(payload, "source");
  validateAppName(payload.name);
  validateRuntime(payload.runtime);

  return {
    name: payload.name,
    entrypoint: payload.entrypoint,
    source: payload.source,
    ...(payload.runtime === undefined ? {} : { runtime: payload.runtime })
  };
}

function validateCreateDeploymentRequest(payload) {
  requireObjectPayload(payload, "CreateDeploymentRequest");
  rejectUnknownFields(payload, ["entrypoint", "source", "runtime"]);
  requireString(payload, "entrypoint");
  requireString(payload, "source");
  validateRuntime(payload.runtime);

  return {
    entrypoint: payload.entrypoint,
    source: payload.source,
    ...(payload.runtime === undefined ? {} : { runtime: payload.runtime })
  };
}

function validateAgentRegistrationRequest(payload) {
  requireObjectPayload(payload, "AgentRegistrationRequest");
  rejectUnknownFields(payload, ["agent_name", "jwks_uri", "requested_scopes"]);
  requireString(payload, "agent_name");
  requireString(payload, "jwks_uri");
  requireStringArray(payload, "requested_scopes");
  validateHttpUrl(payload.jwks_uri, "jwks_uri");

  return {
    agent_name: payload.agent_name,
    jwks_uri: payload.jwks_uri,
    requested_scopes: payload.requested_scopes
  };
}

function validateAgentTokenRequest(payload) {
  requireObjectPayload(payload, "AgentTokenRequest");
  rejectUnknownFields(payload, ["grant_type", "client_id", "scope"]);
  requireString(payload, "grant_type");
  requireString(payload, "client_id");
  if (payload.grant_type !== "client_credentials") {
    throw new GatewayError("grant_type must be client_credentials", { statusCode: 400 });
  }
  if (
    payload.scope !== undefined
    && typeof payload.scope !== "string"
    && !Array.isArray(payload.scope)
  ) {
    throw new GatewayError("scope must be a string or string array", { statusCode: 400 });
  }
  if (Array.isArray(payload.scope) && payload.scope.some((entry) => typeof entry !== "string")) {
    throw new GatewayError("scope must be a string or string array", { statusCode: 400 });
  }

  return {
    grant_type: payload.grant_type,
    client_id: payload.client_id,
    ...(payload.scope === undefined ? {} : { scope: payload.scope })
  };
}

function requireObjectPayload(payload, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GatewayError(`${label} must be a JSON object`, { statusCode: 400 });
  }
}

function requireString(payload, field) {
  if (typeof payload[field] !== "string" || payload[field].length === 0) {
    throw new GatewayError(`${field} is required`, { statusCode: 400 });
  }
}

function requireStringArray(payload, field) {
  if (
    !Array.isArray(payload[field])
    || payload[field].length === 0
    || payload[field].some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new GatewayError(`${field} must be a non-empty array of strings`, { statusCode: 400 });
  }
}

function validateAppName(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) {
    throw new GatewayError("name must match ^[a-z0-9][a-z0-9-]{0,62}$", { statusCode: 400 });
  }
}

function validateRuntime(runtime) {
  if (runtime === undefined) return;
  if (!["v8-isolate", "wasm-worker"].includes(runtime)) {
    throw new GatewayError("runtime must be v8-isolate or wasm-worker", { statusCode: 400 });
  }
}

function validateHttpUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError(`${field} must be an absolute URL`, { statusCode: 400 });
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new GatewayError(`${field} must use http or https`, { statusCode: 400 });
  }
}

function rejectUnknownFields(payload, allowedFields) {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(payload).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new GatewayError(`Unsupported configuration fields: ${unknown.join(", ")}`, { statusCode: 400 });
  }
}

function matchDeploymentPath(pathname) {
  const match = /^\/v1\/apps\/([^/]+)\/deployments$/u.exec(pathname);
  if (!match) return null;
  return { appId: decodeURIComponent(match[1]) };
}

function matchLogsPath(pathname) {
  const match = /^\/v1\/apps\/([^/]+)\/logs$/u.exec(pathname);
  if (!match) return null;
  return { appId: decodeURIComponent(match[1]) };
}

function matchOAuthCallbackPath(pathname) {
  const match = /^\/auth\/callback\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  return { provider: decodeURIComponent(match[1]) };
}

function matchAppRoute(pathname) {
  const match = /^\/a\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
  if (!match) return null;

  const namespace = decodeURIComponent(match[1]);
  const suffix = match[2] ?? "";
  return {
    namespace,
    appPath: `/${suffix}`
  };
}

function matchStoragePath(appPath) {
  const match = /^\/__mudrock\/storage\/([^/]+)\/(.+)$/u.exec(appPath);
  if (!match) return null;
  return {
    primitive: decodeURIComponent(match[1]),
    key: decodeURIComponent(match[2])
  };
}

async function callRequired(fn, ...args) {
  if (typeof fn !== "function") {
    throw new GatewayError("Gateway route is not configured", { statusCode: 501 });
  }

  return fn(...args);
}

async function callOptional(fn, fallback, ...args) {
  if (typeof fn !== "function") return fallback;
  return fn(...args);
}

function parseOptionalInteger(value) {
  if (value === null || value === "") return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new GatewayError("after_sequence must be a non-negative integer", { statusCode: 400 });
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new GatewayError("after_sequence must be a non-negative integer", { statusCode: 400 });
  }
  return parsed;
}

function parseSyncAfterSequence(request) {
  const queryValue = parseOptionalInteger(request.url.searchParams.get("after_sequence"));
  if (queryValue !== undefined) return queryValue;
  return parseLastEventId(request.headers["last-event-id"], request.pathname);
}

function parseLastEventId(value, pathname) {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  const separatorIndex = raw.lastIndexOf(":");
  const prefix = separatorIndex === -1 ? null : raw.slice(0, separatorIndex);
  const suffix = separatorIndex === -1 ? raw : raw.slice(separatorIndex + 1);
  if (prefix !== null && prefix !== matchAppRoute(pathname)?.namespace) {
    throw new GatewayError("Last-Event-ID namespace does not match this sync route", { statusCode: 400 });
  }
  if (!/^\d+$/u.test(suffix)) {
    throw new GatewayError("Last-Event-ID must end with a non-negative integer sequence", { statusCode: 400 });
  }
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new GatewayError("Last-Event-ID must end with a non-negative integer sequence", { statusCode: 400 });
  }
  return parsed;
}

async function toSseText(events, { retryMs } = {}) {
  if (typeof events === "string") return events;

  let text = retryMs === undefined ? "" : `retry: ${retryMs}\n\n`;
  for await (const event of toAsyncIterable(events)) {
    text += sseEventText(event);
  }
  return text;
}

async function* toSseStream(source, { retryMs, signal } = {}) {
  if (retryMs !== undefined) yield `retry: ${retryMs}\n\n`;
  for await (const event of toAsyncIterable(source.events)) {
    yield sseEventText(event);
  }
  if (typeof source.subscribe !== "function") return;

  const queue = createAsyncQueue({ signal });
  const unsubscribe = source.subscribe((event) => queue.push(event));
  try {
    for await (const event of queue) {
      yield sseEventText(event);
    }
  } finally {
    unsubscribe?.();
    queue.close();
  }
}

function isLiveSyncSource(value) {
  return value
    && typeof value === "object"
    && "events" in value
    && typeof value.subscribe === "function";
}

function createAsyncQueue({ signal } = {}) {
  const values = [];
  const waiters = [];
  let closed = false;

  const wake = () => {
    const waiter = waiters.shift();
    if (waiter) waiter();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) wake();
  };
  if (signal) {
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });
  }

  return {
    push(value) {
      if (closed) return;
      values.push(value);
      wake();
    },
    close,
    async *[Symbol.asyncIterator]() {
      while (!closed || values.length > 0) {
        if (values.length === 0) {
          await new Promise((resolve) => waiters.push(resolve));
          continue;
        }
        yield values.shift();
      }
    }
  };
}

function sseEventText(event) {
  const eventId = event?.event_id ?? event?.id;
  const lines = [];
  if (eventId !== undefined) lines.push(`id: ${sanitizeSseField(eventId)}`);
  lines.push("event: mutation");
  lines.push(...JSON.stringify(event).split(/\r?\n/u).map((line) => `data: ${line}`));
  return `${lines.join("\n")}\n\n`;
}

function sanitizeSseField(value) {
  return String(value).replace(/[\r\n]/gu, "");
}

function toAsyncIterable(value) {
  if (value?.[Symbol.asyncIterator]) return value;
  if (value?.[Symbol.iterator]) return value;
  if (value instanceof Readable) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

async function normalizeCallbackResponse(value) {
  if (value instanceof Response) {
    return response(value.status, Object.fromEntries(value.headers.entries()), await value.text());
  }

  if (isResponseEnvelope(value)) {
    const statusCode = value.statusCode ?? value.status ?? 200;
    const headers = normalizeHeaders(value.headers ?? TEXT_HEADERS);
    const body = value.body === undefined || value.body === null ? "" : String(value.body);
    return response(statusCode, headers, body);
  }

  if (value && typeof value === "object") return jsonResponse(value);
  return response(200, TEXT_HEADERS, value === undefined || value === null ? "" : String(value));
}

function isResponseEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  if ("statusCode" in value || "body" in value || "headers" in value) return true;
  return Number.isInteger(value.status);
}

async function normalizeStorageResponse(value) {
  if (!value) {
    throw new GatewayError("Storage object not found", { statusCode: 404 });
  }

  if (value instanceof Response) {
    return normalizeCallbackResponse(value);
  }

  const headers = {
    ...OCTET_STREAM_HEADERS,
    ...(value.content_type ? { "content-type": value.content_type } : {}),
    ...(value.sha256 ? { etag: `"${value.sha256}"` } : {}),
    ...(value.size !== undefined ? { "content-length": String(value.size) } : {})
  };

  if (typeof value.text === "string") {
    return response(200, headers, value.text);
  }

  if (value.bytes instanceof Uint8Array) {
    return response(200, headers, Buffer.from(value.bytes).toString("binary"));
  }

  if (typeof value.arrayBuffer === "function") {
    return response(200, headers, Buffer.from(await value.arrayBuffer()).toString("binary"));
  }

  return normalizeCallbackResponse(value);
}

function jsonResponse(value, statusCode = 200) {
  return response(statusCode, JSON_HEADERS, JSON.stringify(value));
}

function response(statusCode, headers, body) {
  return {
    statusCode,
    headers,
    body: body === undefined || body === null ? "" : String(body)
  };
}

function streamingResponse(statusCode, headers, stream) {
  return {
    statusCode,
    headers,
    body: "",
    stream
  };
}
