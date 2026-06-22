import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createLocalGateway } from "../../src/gateway/index.js";

const spec = JSON.parse(readFileSync(new URL("../../system-spec.json", import.meta.url), "utf8"));
const createAppSpec = spec.$defs.CreateAppRequest;
const createDeploymentSpec = spec.$defs.CreateDeploymentRequest;
const agentRegistrationSpec = spec.$defs.AgentRegistrationRequest;
const agentTokenSpec = spec.$defs.AgentTokenRequest;

const VALID_APP_REQUEST = Object.freeze({
  name: "notes",
  entrypoint: "index.js",
  source: "export default {}",
  runtime: "v8-isolate"
});

const VALID_DEPLOYMENT_REQUEST = Object.freeze({
  entrypoint: "index.js",
  source: "export default {}",
  runtime: "wasm-worker"
});

const VALID_AGENT_REGISTRATION_REQUEST = Object.freeze({
  agent_name: "builder",
  jwks_uri: "https://agent.test/jwks.json",
  requested_scopes: ["apps:create"]
});

const VALID_AGENT_TOKEN_REQUEST = Object.freeze({
  grant_type: "client_credentials",
  client_id: "client_123",
  scope: "apps:create"
});

test("POST /v1/apps validates required fields, name pattern, runtime enum, and extra config", async (t) => {
  assert.deepEqual(createAppSpec.required, ["name", "entrypoint", "source"]);
  assert.equal(createAppSpec.additionalProperties, false);
  assert.deepEqual(createAppSpec.properties.runtime.enum, ["v8-isolate", "wasm-worker"]);
  assert.equal(createAppSpec.properties.runtime_limits, undefined);

  const cases = [
    ...createAppSpec.required.map((field) => ({
      name: `missing ${field}`,
      payload: withoutField(VALID_APP_REQUEST, field),
      bodyPattern: new RegExp(`${field} is required`, "u")
    })),
    {
      name: "name starts with uppercase letter",
      payload: { ...VALID_APP_REQUEST, name: "Notes" },
      bodyPattern: /name must match/u
    },
    {
      name: "name contains underscore forbidden by spec",
      payload: { ...VALID_APP_REQUEST, name: "notes_api" },
      bodyPattern: /name must match/u
    },
    {
      name: "runtime outside enum",
      payload: { ...VALID_APP_REQUEST, runtime: "nodejs20" },
      bodyPattern: /runtime must be/u
    },
    ...["bucket", "database", "oauth_client", "region", "runtime_limits"].map((field) => ({
      name: `extra field ${field}`,
      payload: { ...VALID_APP_REQUEST, [field]: { name: "user-managed" } },
      bodyPattern: /Unsupported|additional|unknown|not allowed/u
    }))
  ];

  for (const validationCase of cases) {
    await t.test(validationCase.name, async () => {
      await assertRejectedBeforeCreateApp(validationCase.payload, validationCase.bodyPattern);
    });
  }
});

test("POST /v1/apps/{app_id}/deployments validates required fields, runtime enum, and extra config", async (t) => {
  assert.deepEqual(createDeploymentSpec.required, ["entrypoint", "source"]);
  assert.equal(createDeploymentSpec.additionalProperties, false);
  assert.deepEqual(createDeploymentSpec.properties.runtime.enum, ["v8-isolate", "wasm-worker"]);
  assert.equal(createDeploymentSpec.properties.runtime_limits, undefined);

  const cases = [
    ...createDeploymentSpec.required.map((field) => ({
      name: `missing ${field}`,
      payload: withoutField(VALID_DEPLOYMENT_REQUEST, field),
      bodyPattern: new RegExp(`${field} is required`, "u")
    })),
    {
      name: "runtime outside enum",
      payload: { ...VALID_DEPLOYMENT_REQUEST, runtime: "nodejs20" },
      bodyPattern: /runtime must be/u
    },
    ...["bucket", "database", "oauth_client", "region", "runtime_limits"].map((field) => ({
      name: `extra field ${field}`,
      payload: { ...VALID_DEPLOYMENT_REQUEST, [field]: { name: "user-managed" } },
      bodyPattern: /Unsupported|additional|unknown|not allowed/u
    }))
  ];

  for (const validationCase of cases) {
    await t.test(validationCase.name, async () => {
      await assertRejectedBeforeCreateDeployment(validationCase.payload, validationCase.bodyPattern);
    });
  }
});

test("POST /v1/agents/register validates required fields, JWKS URL, scopes, and extra config", async (t) => {
  assert.deepEqual(agentRegistrationSpec.required, ["agent_name", "jwks_uri", "requested_scopes"]);
  assert.equal(agentRegistrationSpec.additionalProperties, false);

  const cases = [
    ...agentRegistrationSpec.required.map((field) => ({
      name: `missing ${field}`,
      payload: withoutField(VALID_AGENT_REGISTRATION_REQUEST, field),
      bodyPattern: field === "requested_scopes"
        ? /requested_scopes must be/u
        : new RegExp(`${field} is required`, "u")
    })),
    {
      name: "jwks_uri is not absolute",
      payload: { ...VALID_AGENT_REGISTRATION_REQUEST, jwks_uri: "/jwks.json" },
      bodyPattern: /jwks_uri must be an absolute URL/u
    },
    {
      name: "jwks_uri uses a non-http protocol",
      payload: { ...VALID_AGENT_REGISTRATION_REQUEST, jwks_uri: "file:///tmp/jwks.json" },
      bodyPattern: /jwks_uri must use http or https/u
    },
    {
      name: "requested_scopes is empty",
      payload: { ...VALID_AGENT_REGISTRATION_REQUEST, requested_scopes: [] },
      bodyPattern: /requested_scopes must be/u
    },
    {
      name: "requested_scopes contains a non-string",
      payload: { ...VALID_AGENT_REGISTRATION_REQUEST, requested_scopes: ["apps:create", 1] },
      bodyPattern: /requested_scopes must be/u
    },
    {
      name: "extra field",
      payload: { ...VALID_AGENT_REGISTRATION_REQUEST, redirect_uri: "https://agent.test/callback" },
      bodyPattern: /Unsupported|additional|unknown|not allowed/u
    }
  ];

  for (const validationCase of cases) {
    await t.test(validationCase.name, async () => {
      await assertRejectedBeforeRegisterAgent(validationCase.payload, validationCase.bodyPattern);
    });
  }
});

test("POST /oauth/token validates grant, client id, scope, and extra config", async (t) => {
  assert.deepEqual(agentTokenSpec.required, ["grant_type", "client_id"]);
  assert.equal(agentTokenSpec.additionalProperties, false);
  assert.equal(agentTokenSpec.properties.grant_type.const, "client_credentials");

  const cases = [
    ...agentTokenSpec.required.map((field) => ({
      name: `missing ${field}`,
      payload: withoutField(VALID_AGENT_TOKEN_REQUEST, field),
      bodyPattern: new RegExp(`${field} is required`, "u")
    })),
    {
      name: "unsupported grant",
      payload: { ...VALID_AGENT_TOKEN_REQUEST, grant_type: "authorization_code" },
      bodyPattern: /grant_type must be client_credentials/u
    },
    {
      name: "scope is an object",
      payload: { ...VALID_AGENT_TOKEN_REQUEST, scope: { value: "apps:create" } },
      bodyPattern: /scope must be/u
    },
    {
      name: "extra field",
      payload: { ...VALID_AGENT_TOKEN_REQUEST, client_secret: "not-local" },
      bodyPattern: /Unsupported|additional|unknown|not allowed/u
    }
  ];

  for (const validationCase of cases) {
    await t.test(validationCase.name, async () => {
      await assertRejectedBeforeIssueToken(validationCase.payload, validationCase.bodyPattern);
    });
  }
});

async function assertRejectedBeforeCreateApp(payload, bodyPattern) {
  let createAppCalls = 0;
  const gateway = createLocalGateway({
    callbacks: {
      createApp() {
        createAppCalls += 1;
        return {
          app_id: "app_notes",
          namespace: "ns_notes",
          deployment: deploymentResponse("v8-isolate")
        };
      }
    }
  });

  const response = await gateway.handle({
    method: "POST",
    path: "/v1/apps",
    body: JSON.stringify(payload)
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, bodyPattern);
  assert.equal(createAppCalls, 0);
}

async function assertRejectedBeforeCreateDeployment(payload, bodyPattern) {
  let createDeploymentCalls = 0;
  const gateway = createLocalGateway({
    callbacks: {
      createDeployment() {
        createDeploymentCalls += 1;
        return deploymentResponse("v8-isolate");
      }
    }
  });

  const response = await gateway.handle({
    method: "POST",
    path: "/v1/apps/app_notes/deployments",
    body: JSON.stringify(payload)
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, bodyPattern);
  assert.equal(createDeploymentCalls, 0);
}

async function assertRejectedBeforeRegisterAgent(payload, bodyPattern) {
  let registerAgentCalls = 0;
  const gateway = createLocalGateway({
    callbacks: {
      registerAgent() {
        registerAgentCalls += 1;
        return {
          agent_id: "agent_1",
          client_id: "client_1",
          token_endpoint: "https://auth.test/oauth/token",
          approved_scopes: []
        };
      }
    }
  });

  const response = await gateway.handle({
    method: "POST",
    path: "/v1/agents/register",
    body: JSON.stringify(payload)
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, bodyPattern);
  assert.equal(registerAgentCalls, 0);
}

async function assertRejectedBeforeIssueToken(payload, bodyPattern) {
  let issueTokenCalls = 0;
  const gateway = createLocalGateway({
    callbacks: {
      issueToken() {
        issueTokenCalls += 1;
        return {
          access_token: "mrt_test",
          token_type: "Bearer",
          expires_in: 900,
          scope: ""
        };
      }
    }
  });

  const response = await gateway.handle({
    method: "POST",
    path: "/oauth/token",
    body: JSON.stringify(payload)
  });

  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, bodyPattern);
  assert.equal(issueTokenCalls, 0);
}

function withoutField(payload, field) {
  const copy = { ...payload };
  delete copy[field];
  return copy;
}

function deploymentResponse(runtime) {
  return {
    deployment_id: "dep_1",
    build_id: "bld_1",
    bundle_sha256: "abc",
    runtime,
    status: "active"
  };
}
