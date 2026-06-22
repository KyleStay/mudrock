export const DEFAULT_MUDROCK_CAPABILITIES = Object.freeze([
  "deploy.raw_source",
  "runtime.v8",
  "runtime.wasm",
  "db.implicit",
  "storage.streaming",
  "sync.sse",
  "sync.websocket"
]);

export const LOCAL_MUDROCK_CAPABILITIES = Object.freeze(
  DEFAULT_MUDROCK_CAPABILITIES.filter((capability) => capability !== "sync.websocket")
);

export function buildOmdDocument({
  apiBase = "https://api.mudrock.dev",
  authBase = "https://auth.mudrock.dev",
  registrationPath = "/v1/agents/register",
  platform = "mudrock",
  omdVersion = "1.0",
  capabilities = DEFAULT_MUDROCK_CAPABILITIES
} = {}) {
  const normalizedApiBase = normalizeBaseUrl(apiBase, "apiBase");
  const normalizedAuthBase = normalizeBaseUrl(authBase, "authBase");

  return {
    omd_version: omdVersion,
    platform,
    api_base: normalizedApiBase,
    authkit: {
      token_endpoint: `${normalizedAuthBase}/oauth/token`,
      registration_endpoint: `${normalizedApiBase}${normalizePath(registrationPath)}`,
      supported_grants: [
        "client_credentials",
        "urn:ietf:params:oauth:grant-type:token-exchange"
      ],
      proof_methods: ["dpop+jwt", "mtls"]
    },
    capabilities: [...capabilities]
  };
}

function normalizeBaseUrl(value, fieldName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${fieldName} must be an absolute URL`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`${fieldName} must use http or https`);
  }

  return url.toString().replace(/\/$/u, "");
}

function normalizePath(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/")) {
    return `/${path}`;
  }

  return path;
}
