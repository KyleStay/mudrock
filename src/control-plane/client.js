import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export class ApiError extends Error {
  constructor(message, { statusCode, responseBody, headers } = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.headers = headers || {};
  }
}

export class ControlPlaneClient {
  constructor({ apiBase = "https://api.mudrock.dev", token, authScheme = "Bearer" } = {}) {
    this.apiBase = normalizeApiBase(apiBase);
    this.token = token;
    this.authScheme = authScheme;
  }

  async createApp({ name, entrypoint, source, runtime }) {
    return this.requestJson("POST", "/v1/apps", {
      body: compactObject({ name, entrypoint, source, runtime })
    });
  }

  async createDeployment(appId, { entrypoint, source, runtime }) {
    return this.requestJson("POST", `/v1/apps/${encodeURIComponent(appId)}/deployments`, {
      body: compactObject({ entrypoint, source, runtime })
    });
  }

  async invoke(app, path, { method = "GET", headers = {}, body } = {}) {
    const requestPath = `/a/${encodeURIComponent(app)}${normalizeInvokePath(path)}`;
    return this.requestRaw(method, requestPath, { headers, body });
  }

  async logs(app, { tail } = {}) {
    const params = new URLSearchParams();
    if (tail !== undefined) params.set("tail", String(tail));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.requestRaw("GET", `/v1/apps/${encodeURIComponent(app)}/logs${suffix}`);
  }

  async discoverOmd(omdUrl) {
    const url = omdUrl ? new URL(omdUrl) : new URL("/.well-known/omd.json", this.apiBase);
    return requestJsonUrl(url, "GET", { headers: this.authHeaders() });
  }

  async registerAgent(registrationEndpoint, manifest) {
    return requestJsonUrl(new URL(registrationEndpoint), "POST", {
      headers: {
        ...this.authHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify(manifest)
    });
  }

  async requestAgentToken(tokenEndpoint, { client_id, scope, grant_type = "client_credentials" }) {
    const body = new URLSearchParams(compactObject({
      grant_type,
      client_id,
      scope: Array.isArray(scope) ? scope.join(" ") : scope
    }));
    return requestJsonUrl(new URL(tokenEndpoint), "POST", {
      headers: {
        ...this.authHeaders(),
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
  }

  async requestJson(method, path, { body, headers } = {}) {
    return requestJsonUrl(new URL(path, this.apiBase), method, {
      headers: {
        ...this.authHeaders(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  async requestRaw(method, path, { body, headers = {} } = {}) {
    return requestRawUrl(new URL(path, this.apiBase), method, {
      headers: {
        ...this.authHeaders(),
        ...headers
      },
      body
    });
  }

  authHeaders() {
    if (!this.token) return {};
    return { authorization: `${this.authScheme} ${this.token}` };
  }
}

async function requestJsonUrl(url, method, options = {}) {
  const response = await requestRawUrl(url, method, options);
  if (response.body.length === 0) return null;

  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new ApiError(`Expected JSON response from ${url.pathname}`, {
      statusCode: response.statusCode,
      responseBody: response.body,
      headers: response.headers
    });
  }
}

function requestRawUrl(url, method, { headers = {}, body } = {}) {
  if (url.protocol === "mock:") {
    return requestMockUrl(url, method, { headers, body });
  }

  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const requestBody = body === undefined ? undefined : Buffer.from(String(body));
    const requestHeaders = { ...headers };
    if (requestBody && requestHeaders["content-length"] === undefined) {
      requestHeaders["content-length"] = String(requestBody.byteLength);
    }

    const req = transport.request(
      url,
      {
        method,
        headers: requestHeaders
      },
      (res) => {
        const chunks = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = chunks.join("");
          const result = {
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: responseBody
          };

          if (result.statusCode < 200 || result.statusCode >= 300) {
            reject(new ApiError(`Mudrock API request failed with HTTP ${result.statusCode}`, result));
            return;
          }

          resolve(result);
        });
      }
    );

    req.on("error", reject);
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

async function requestMockUrl(url, method, { headers = {}, body } = {}) {
  const transport = globalThis.__MUDROCK_MOCK_TRANSPORTS?.get(url.host);
  if (!transport) {
    throw new ApiError(`No mock Mudrock transport registered for ${url.host}`);
  }

  const result = await transport.handle({
    method,
    path: `${url.pathname}${url.search}`,
    headers,
    body: body === undefined ? "" : String(body)
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new ApiError(`Mudrock API request failed with HTTP ${result.statusCode}`, result);
  }

  return result;
}

function normalizeApiBase(apiBase) {
  const parsed = new URL(apiBase);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeInvokePath(path) {
  const value = path || "/";
  return value.startsWith("/") ? value : `/${value}`;
}

export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
