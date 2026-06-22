# Integration Notes

## Ownership Boundary

The developer experience assets in this slice are intentionally limited to:

- `examples/**`
- `tests/integration/**`
- `docs/**`

They do not require changes to package metadata, CLI implementation, runtime implementation, README, or architecture files.

## Harness Shape

`tests/integration/zero-config-slice.test.mjs` provides a standard-library-only harness with four host bindings:

- `Mudrock.db(name)`: in-memory key-value records with `put`, `patch`, `get`, and `list`.
- `Mudrock.storage(name)`: in-memory binary objects with content hashes, block metadata, and gateway-style URLs.
- `Mudrock.auth.currentUser()`: a namespace-bound brokered identity stub.
- `Mudrock.sync(name)`: a read-only view over committed mutation-log events.

The harness imports the example app from an in-memory `data:` URL to preserve the source-only deployment model. The composed local platform and CLI use salted module URLs plus an async-context `Mudrock` proxy so module-scope caches and overlapping local calls do not reuse another app's runtime binding.

## Local Gateway Composition

`examples/zero-config-notes/local-gateway-server.js` is the runnable DX example for the local gateway story. It intentionally composes current source modules directly:

- `createLocalPlatform` wires the local gateway, project store, runtime bindings, and Node HTTP server adapter.
- `LocalGateway` handles OMD discovery, `/v1/apps`, `/v1/apps/{app_id}/deployments`, `/a/{namespace}/__mudrock/*`, and app invocation envelopes.
- `LocalProjectStore` stores deployed apps, active deployment metadata, logs, and the serialized local data plane at `MUDROCK_STATE_PATH`.
- `createLocalRuntime` recreates namespace-scoped `Mudrock.db`, `Mudrock.storage`, `Mudrock.auth`, and `Mudrock.sync` bindings for each invocation.

The composition contract is:

- Deploy through `POST /v1/apps` or by bootstrapping the notes example at server start.
- Resolve app traffic by namespace from `/a/{namespace}/...`.
- Import the active compiled bundle from persisted deployment state.
- Salt local bundle imports by namespace/deployment so identical source in different apps gets distinct module instances.
- Run app code in a worker with an async-context Mudrock host binding and a fresh data-plane snapshot.
- At commit time, merge non-conflicting worker data-plane deltas into the latest local state, remap mutation event ids to durable sequence numbers, and append the completion log in the same state update after host-side response-limit checks.
- Serve sync events from the persisted data-plane mutation log.

This keeps the example and integration test focused on visible HTTP and state behavior while the helper implementation evolves.

## API Validation Contract

The gateway request validation behavior is pinned by the gateway unit contract and exercised through the local integration slice:

- `POST /v1/apps` requires `name`, `entrypoint`, and `source`.
- `POST /v1/apps/{app_id}/deployments` requires `entrypoint` and `source`.
- `POST /v1/agents/register` requires `agent_name`, an absolute HTTP(S) `jwks_uri`, and a non-empty `requested_scopes` array.
- `POST /oauth/token` supports the local `client_credentials` AuthKit grant with `client_id` and optional space-delimited `scope`.
- `runtime`, when present, must be `v8-isolate` or `wasm-worker`.
- app names must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- request payloads must not include user-managed platform config such as `bucket`, `database`, `oauth_client`, or any other undeclared field.

These checks are intentionally stricter than a blocklist: unknown fields must be rejected before control-plane callbacks run. Within this ownership slice, `tests/integration/zero-config-slice.test.mjs` keeps the deploy request free of user-managed infrastructure config, while the runnable gateway example in `examples/zero-config-notes/error-behavior.md` shows the visible local failure shape.

The composed local platform serves the OMD registration and token endpoints advertised in `/.well-known/omd.json`; successful registrations persist deterministic local agent/client metadata and append an `agent.claimed` log entry. Local AuthKit token issuance validates registered `client_id` values, rejects scopes outside the agent's approved set, emits the documented core claims, and can optionally enforce `apps:create`, `apps:deploy`, and `logs:read` on control-plane routes.

This local slice models the AuthKit contract without full proof-of-possession verification. Production DPoP/mTLS proof validation remains an auth-broker responsibility.

## Sync Replay Contract

The local gateway emits committed mutation-log events as SSE. In-process `handle()` calls materialize finite replay responses for tests and SDK-style callers; Node HTTP requests keep the SSE stream open and receive live fanout after successful data-plane snapshot commits. Each frame includes:

- a stable `id` field equal to the mutation `event_id`;
- `event: mutation`;
- JSON `data` containing the complete mutation event;
- a `retry: 1000` hint for reconnecting clients.

Clients can resume with either `after_sequence=<n>` or `Last-Event-ID: <event_id>`. Query cursors take precedence when both are present. `Last-Event-ID` can be a bare sequence or a route-namespace-prefixed event id, and mismatched namespaces are rejected before the sync callback runs. Replayed and live events come only from committed data-plane mutations; oversized responses, thrown handlers, and timed-out invocations do not publish staged worker snapshots.

Local OMD discovery reflects that executable surface: `LocalGateway` advertises live `sync.sse` but not `sync.websocket`, and direct WebSocket upgrade attempts on `/__mudrock/sync` return an explicit unsupported response.

## Runtime Limit Contract

`tests/integration/platform-limits-error-behavior.test.mjs` covers the app-facing runtime contract that now has source support:

- oversized `Mudrock.db().put` values fail with `MUDROCK_RUNTIME_LIMIT_EXCEEDED` before records or sync events commit;
- oversized `Mudrock.storage().put` bodies fail with `MUDROCK_RUNTIME_LIMIT_EXCEEDED` before objects or sync events commit;
- `Mudrock.db().transaction` publishes no staged writes when a later staged mutation fails a limit;
- handlers that exceed `max_wall_ms_per_request` fail before local data-plane snapshots are saved, including synchronous CPU loops in the worker-backed invocation path;
- invalid primitive names and empty keys use stable Mudrock error codes.

The default local limits are visible through `Mudrock.limits`; tests tighten those limits to keep coverage fast and standard-library-only. Local wall-clock enforcement runs app code in a worker thread and terminates the worker on deadline, while production isolate pooling remains future runtime-manager work.

## Runtime Integration Checklist

Use the current test as a handoff contract when executable runtime work begins:

- Accept the example deployment request and inline the referenced source file into `source`.
- Return `CreateAppResponse` with `app_id`, `namespace`, and an active `Deployment`.
- Preserve owner-derived namespace behavior; display names must not decide tenant boundaries.
- Invoke `examples/zero-config-notes/index.js` without Node filesystem or process APIs.
- Intercept reserved paths before user code, especially `/__mudrock/sync` and `/__mudrock/auth/start`.
- Emit sync events from committed data-plane mutations, not from user-published events.
- Keep object storage URLs gateway-relative or signed gateway URLs, never provider bucket URLs.

## Suggested CI Command

Until package scripts exist, CI can run the integration contract directly:

```bash
node --test tests/integration/zero-config-slice.test.mjs
node --test tests/integration/local-gateway-composition.test.mjs
node --test tests/integration/platform-limits-error-behavior.test.mjs
```
