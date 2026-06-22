import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main } from "../../src/cli/main.js";
import { ioFor } from "./helpers.js";

test("omd claim stores an agent registration from a manifest", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mudrock-cli-"));
  const statePath = path.join(tmp, "state.json");
  const manifestPath = path.join(tmp, "agent.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    agent_name: "example-codegen-agent",
    jwks_uri: "https://agent.example/.well-known/jwks.json",
    requested_scopes: ["apps:create", "apps:deploy", "logs:read"]
  }));

  const io = ioFor({ statePath });
  await main(["omd", "claim", "--manifest", manifestPath], io);

  const output = JSON.parse(io.stdout.text());
  assert.match(output.agent_id, /^agent_/);
  assert.match(output.client_id, /^client_/);
  assert.equal(output.token_endpoint, "https://auth.mudrock.dev/oauth/token");
  assert.deepEqual(output.approved_scopes, ["apps:create", "apps:deploy", "logs:read"]);

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(Object.keys(state.agents).length, 1);
  assert.equal(state.logs[0].event, "agent.claimed");
});

test("omd token issues a local AuthKit client credentials token", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mudrock-cli-"));
  const statePath = path.join(tmp, "state.json");
  const manifestPath = path.join(tmp, "agent.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    agent_name: "example-codegen-agent",
    jwks_uri: "https://agent.example/.well-known/jwks.json",
    requested_scopes: ["apps:create", "logs:read"]
  }));

  const claimIo = ioFor({ statePath });
  await main(["omd", "claim", "--manifest", manifestPath], claimIo);
  const registration = JSON.parse(claimIo.stdout.text());

  const tokenIo = ioFor({ statePath });
  await main([
    "omd",
    "token",
    "--client-id",
    registration.client_id,
    "--scope",
    "apps:create logs:read"
  ], tokenIo);

  const token = JSON.parse(tokenIo.stdout.text());
  assert.match(token.access_token, /^mrt_/u);
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.expires_in, 900);
  assert.equal(token.scope, "apps:create logs:read");

  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(state.logs.at(-1).event, "agent.token_issued");
});
