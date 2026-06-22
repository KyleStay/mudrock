import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "../../src/cli/main.js";
import { ioFor, json, withServer } from "./helpers.js";

test("remote omd token discovers AuthKit and posts a form token request", async () => {
  await withServer(async (req, res, body) => {
    if (req.method === "GET" && req.url === "/.well-known/omd.json") {
      const baseUrl = `mock://${req.headers.host}`;
      json(res, 200, {
        omd_version: "1.0",
        platform: "mudrock",
        api_base: baseUrl,
        authkit: {
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/v1/agents/register`,
          supported_grants: ["client_credentials"],
          proof_methods: ["dpop+jwt"]
        },
        capabilities: ["deploy.raw_source"]
      });
      return;
    }

    if (req.method === "POST" && req.url === "/oauth/token") {
      assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(body, "grant_type=client_credentials&client_id=client_123&scope=apps%3Acreate+logs%3Aread");
      json(res, 200, {
        access_token: "mrt_remote",
        token_type: "Bearer",
        expires_in: 900,
        scope: "apps:create logs:read"
      });
      return;
    }

    json(res, 404, { error: "unexpected request" });
  }, async ({ baseUrl, requests }) => {
    const io = ioFor();
    await main([
      "--api-base",
      baseUrl,
      "omd",
      "token",
      "--client-id",
      "client_123",
      "--scope",
      "apps:create logs:read"
    ], io);

    assert.deepEqual(JSON.parse(io.stdout.text()), {
      access_token: "mrt_remote",
      token_type: "Bearer",
      expires_in: 900,
      scope: "apps:create logs:read"
    });
    assert.deepEqual(requests.map((request) => [request.method, request.url]), [
      ["GET", "/.well-known/omd.json"],
      ["POST", "/oauth/token"]
    ]);
  });
});
