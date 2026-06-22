import { createHash, randomUUID } from "node:crypto";

const PRIMITIVE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

export function hashBytes(value, algorithm = "sha256") {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(String(value));
  return createHash(algorithm).update(bytes).digest("hex");
}

export function createAppId(name, ownerId = "local") {
  const seed = `${ownerId}:${name}:${randomUUID()}`;
  return `app_${hashBytes(seed).slice(0, 24)}`;
}

export function createNamespace({ ownerId = "local", appId }) {
  if (!appId) {
    throw new TypeError("createNamespace requires an appId");
  }

  return `ns_${hashBytes(`${ownerId}:${appId}`).slice(0, 32)}`;
}

export function createBuildId({ source, policyVersion = "local-v1", runtimeVersion = process.version }) {
  return `bld_${hashBytes(stableJson({ source, policyVersion, runtimeVersion })).slice(0, 32)}`;
}

export function normalizePrimitiveName(name = "default") {
  const normalized = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 63);

  if (!PRIMITIVE_NAME_PATTERN.test(normalized)) {
    throw new TypeError(`Invalid Mudrock primitive name: ${name}`);
  }

  return normalized;
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)])
    );
  }

  return value;
}
