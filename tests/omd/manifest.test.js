import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOCAL_MUDROCK_CAPABILITIES,
  buildOmdDocument
} from "../../src/omd/manifest.js";

test("buildOmdDocument emits the documented Mudrock discovery shape", () => {
  const document = buildOmdDocument();

  assert.equal(document.omd_version, "1.0");
  assert.equal(document.platform, "mudrock");
  assert.equal(document.api_base, "https://api.mudrock.dev");
  assert.equal(document.authkit.token_endpoint, "https://auth.mudrock.dev/oauth/token");
  assert.equal(document.authkit.registration_endpoint, "https://api.mudrock.dev/v1/agents/register");
  assert.deepEqual(document.authkit.proof_methods, ["dpop+jwt", "mtls"]);
  assert.ok(document.capabilities.includes("deploy.raw_source"));
  assert.ok(document.capabilities.includes("sync.websocket"));
});

test("buildOmdDocument supports local development endpoints", () => {
  const document = buildOmdDocument({
    apiBase: "http://127.0.0.1:8787/",
    authBase: "http://127.0.0.1:8788/",
    capabilities: LOCAL_MUDROCK_CAPABILITIES
  });

  assert.equal(document.api_base, "http://127.0.0.1:8787");
  assert.equal(document.authkit.token_endpoint, "http://127.0.0.1:8788/oauth/token");
  assert.ok(document.capabilities.includes("sync.sse"));
  assert.equal(document.capabilities.includes("sync.websocket"), false);
});

test("buildOmdDocument rejects non-URL bases", () => {
  assert.throws(() => buildOmdDocument({ apiBase: "/local" }), /absolute URL/u);
  assert.throws(() => buildOmdDocument({ apiBase: "localhost:8787" }), /http or https/u);
});
