# Mudrock

Mudrock is a zero-configuration runtime for small networked applications. A developer or coding agent submits source code, and the platform derives the build, runtime, storage, authentication, and sync topology from that code alone.

The design target is direct deployment from source text:

```ts
export default {
  async fetch(req: Request) {
    const db = Mudrock.db("store");
    const files = Mudrock.storage();

    if (new URL(req.url).pathname === "/upload") {
      const file = await files.put("asset", req.body);
      await db.put(`asset:${file.id}`, file);
      return Response.json(file);
    }

    return Response.json(await db.list({ prefix: "asset:" }));
  }
};
```

There is no project dashboard, bucket setup, database setup, Dockerfile, deployment YAML, or OAuth application registration. Code is the only deployment instruction.

## Quickstart

Run the local prototype directly from this checkout:

```bash
npm test
node bin/mudrock.js deploy examples/zero-config-notes/index.js --name notes
node bin/mudrock.js invoke notes /notes
node bin/mudrock.js serve
```

Deploy from stdin:

```bash
cat app.ts | node bin/mudrock.js deploy --stdin --name notes
```

Local deploys write control-plane metadata to `.mudrock/local-state.json` by default. Override that with `--state path` or `MUDROCK_STATE_PATH`.

Deploy through the HTTP API:

```bash
curl -X POST https://api.mudrock.dev/v1/apps \
  -H "Authorization: Bearer $MUDROCK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"notes","entrypoint":"index.ts","source":"export default { fetch(){ return new Response(\"ok\") } }"}'
```

Use implicit primitives:

```ts
const db = Mudrock.db("store");
await db.put("user:1", { name: "Ada" });

const files = Mudrock.storage();
await files.put("avatar", request.body);

const session = await Mudrock.auth.require(request);
```

Subscribe to state without user-managed infrastructure:

```ts
const stream = Mudrock.sync("store");
stream.on("change", event => console.log(event));
```

## CLI

```text
mudrock deploy <file> [--name app-name] [--stdin]
mudrock logs <app>
mudrock invoke <app> <path>
mudrock serve [--host 127.0.0.1] [--port 8787]
mudrock omd claim --manifest omd.json
mudrock omd token --client-id client_id [--scope "apps:create logs:read"]
```

The local CLI supports an offline prototype mode by default and a remote API mode when the command begins with `--api-base <url>`:

```bash
mudrock --api-base https://api.mudrock.dev deploy --stdin --name notes
mudrock --api-base https://api.mudrock.dev invoke notes /notes
```

## Current Implementation

This repository now contains a first executable slice:

- A memory-only compiler that transforms source into ESM bundle bytes, detects Mudrock primitives, computes content hashes, and rejects disallowed runtime APIs.
- A local control plane that derives namespace boundaries from owner identity and app id, stores active revisions, persists primitive state snapshots, records deployment logs, and supports deterministic local OMD agent claims.
- Atomic local state writes, advisory state locking, and validation/migration for older or partial state files.
- A local runtime/data plane with frozen `Mudrock.db`, `Mudrock.storage`, `Mudrock.sync`, and namespace-scoped auth bindings.
- Salted local bundle imports and an async-context Mudrock proxy that prevent module-scope host binding reuse across local apps.
- Runtime limit defaults and overrides for request body bytes and heap-sized primitive values.
- Worker-isolated local platform and CLI invocations with hard wall-clock termination for runaway synchronous app code.
- Commit-time merge of non-conflicting worker data-plane deltas, with same-record/object conflicts rejected instead of overwritten.
- Runtime-host response byte enforcement that prevents oversized responses from persisting staged local state.
- Transactional database writes that commit mutation events together and roll back cleanly on failure.
- A local gateway that handles OMD discovery, app/deployment API calls, app logs, reserved health/manifest/sync/auth/storage paths, and invocation envelopes.
- Local gateway discovery advertises executable live sync support (`sync.sse`); WebSocket upgrade requests fail explicitly until that transport lands.
- OMD agent registration through the advertised `/v1/agents/register` endpoint, backed by deterministic local client metadata.
- A local AuthKit `/oauth/token` endpoint for `client_credentials` tokens, with registered-client lookup, approved-scope checks, documented token claims, and opt-in control-plane scope enforcement.
- A standard-library-only CLI for deploy, invoke, logs, and OMD discovery/claim workflows.
- A local `serve` command that exposes the composed gateway/control-plane/runtime platform as an HTTP server.
- A zero-config notes example and integration harness covering database, storage, auth shape, sync events, and namespace derivation.

## Runtime Contract

Every deployment produces:

- A memory-only bundle generated by the compiler service.
- A content-addressed build record with no container image.
- An isolate or WASM worker namespace.
- A tenant-scoped embedded database namespace.
- A tenant-scoped binary block namespace.
- A default OAuth callback path through the Mudrock broker.
- A reactive sync channel keyed by app namespace.

## Repository Layout

- [bin/mudrock.js](bin/mudrock.js): executable CLI shim.
- [src/compiler](src/compiler): memory compiler and primitive detection.
- [src/control-plane](src/control-plane): local project store and remote API client.
- [src/runtime](src/runtime): local Mudrock host bindings and in-memory data plane.
- [src/gateway](src/gateway): local gateway routing, reserved path interception, and invocation envelopes.
- [src/cli](src/cli): command parsing, local mode, and remote API mode.
- [src/omd](src/omd): OMD/AuthKit discovery document generation.
- [examples/zero-config-notes](examples/zero-config-notes): source-only app example.
- [tests](tests): node:test coverage for compiler, CLI, runtime, OMD, and integration contracts.
- [docs/first-executable-slice.md](docs/first-executable-slice.md): executable slice walkthrough.
- [architecture/INFRASTRUCTURE.md](architecture/INFRASTRUCTURE.md): compiler, runtime isolation, request routing, lifecycle controls.
- [architecture/DATA_AND_AUTH.md](architecture/DATA_AND_AUTH.md): implicit database/storage APIs, OAuth broker, OMD/AuthKit, sync layer.
- [system-spec.json](system-spec.json): machine-readable integration matrix for generation agents.
