# First Executable Slice

This slice exercises Mudrock from the developer's point of view before the runtime is fully implemented. It keeps the contract centered on source-only deployment:

1. Submit one source file as the deployment instruction.
2. Derive the app id, namespace, runtime revision, and primitive shape from that source.
3. Invoke the app through a WHATWG `Request`.
4. Persist database records, storage bytes, and mutation logs across local invocations.
5. Use `Mudrock.db`, `Mudrock.storage`, `Mudrock.auth`, and mutation-driven sync without user-managed infrastructure.

## Example App

The example app lives at `examples/zero-config-notes/index.js`.

It exposes:

- `POST /notes`: writes a note to `Mudrock.db("notes")`.
- `GET /notes`: lists notes and returns the reserved sync endpoint hint.
- `POST /attachments?note_id=<id>`: streams the request body into `Mudrock.storage("attachments")` and patches the note with object metadata.
- `GET /attachments?note_id=<id>`: reads the stored object back through the host binding.
- `GET /session`: reads the brokered user through `Mudrock.auth.currentUser`.
- `GET /limits`: returns the host-provided `Mudrock.limits` object and the example operations each limit protects.

The deployment request metadata is in `examples/zero-config-notes/deploy-request.json`. It intentionally contains no database, bucket, OAuth client, pub-sub, Docker, or build configuration.

## Run the Contract Test

The integration test uses only Node.js standard library modules:

```bash
node --test tests/integration/zero-config-slice.test.mjs
node --test tests/integration/local-gateway-composition.test.mjs
```

The local CLI exercises the same shape with persisted state:

```bash
node bin/mudrock.js deploy examples/zero-config-notes/index.js --name notes
node bin/mudrock.js invoke notes /notes
node bin/mudrock.js invoke notes /notes --method POST --body '{"id":"first","title":"Hello"}'
node bin/mudrock.js invoke notes /notes
node bin/mudrock.js omd token --client-id <client_id> --scope "apps:create logs:read"
```

The local gateway can also serve the same platform surface:

```bash
node bin/mudrock.js serve --port 8787
curl http://127.0.0.1:8787/.well-known/omd.json
curl -X POST http://127.0.0.1:8787/v1/apps \
  -H "content-type: application/json" \
  -d @examples/zero-config-notes/deploy-request.json
```

The local gateway example runs the same notes app behind HTTP routes and stores project state on disk:

```bash
node examples/zero-config-notes/local-gateway-server.js
curl -s http://127.0.0.1:8787/.well-known/omd.json
curl -s -X POST http://127.0.0.1:8787/a/<namespace>/notes \
  -H 'content-type: application/json' \
  -d '{"id":"first","title":"Hello"}'
curl -s http://127.0.0.1:8787/a/<namespace>/notes
curl -s http://127.0.0.1:8787/a/<namespace>/__mudrock/sync?primitive=notes
```

The server prints the bootstrapped namespace at startup. It uses `.mudrock/zero-config-notes.json` by default; override that with `MUDROCK_STATE_PATH` when you want an isolated run.

See `examples/zero-config-notes/error-behavior.md` for curl examples that exercise rejected deployment payloads and the current local runtime error shape.

The test harness is not a production runtime. It is a small executable contract that validates the first platform slice expected by the architecture:

- deployment request shape matches `system-spec.json#/$defs/CreateAppRequest`;
- app/deployment APIs reject missing required fields, invalid runtimes, invalid app names, and explicit database/bucket/OAuth configuration;
- OMD discovery advertises `/v1/agents/register` and `/oauth/token`; the local platform persists successful agent registrations and issues scoped local AuthKit tokens;
- namespace is derived from owner identity and app id;
- local control-plane state writes are atomic and validated on read;
- primitives are detected from literal `Mudrock.*` calls;
- local invocation salts in-memory module imports per namespace/deployment to prevent module-scope binding reuse across apps;
- local platform invocations are serialized while the async-context Mudrock proxy is installed;
- invocation can create and list notes;
- invocation completions are recorded in app logs;
- gateway routes intercept reserved health, manifest, sync, auth, and storage paths before app code;
- storage writes return gateway-style object URLs rather than bucket URLs;
- gateway storage URLs read back persisted object bytes;
- storage bytes can be read back after a later local invocation;
- auth is brokered through a namespace-bound user;
- sync events are emitted only from committed database and storage mutations.
- sync SSE responses include stable event ids and can resume from `Last-Event-ID`.
- worker-isolated wall-clock timeouts reject local invocations before saving data-plane snapshots, including synchronous CPU loops.
- worker invocation results travel over a private host-owned message port, so app code cannot forge successful worker responses through `parentPort`.
- runtime limits reject oversized database values and storage request bodies before committing mutations.
- runtime host response limits reject oversized app responses before saving local data-plane snapshots.
- database transactions stage writes, commit mutation-log events together, and leave no partial state on failure.
- local OAuth start creates a durable namespace-bound state record, `/auth/callback/{provider}` consumes it once, and verified app session tokens populate `Mudrock.auth.currentUser()`.

## Platform Limits and Errors

The local runtime exposes conservative platform limits through `Mudrock.limits`:

- `max_cpu_ms_per_request`: CPU budget reserved for isolate/worker host runtimes.
- `max_wall_ms_per_request`: wall-clock request budget enforced by local platform and CLI worker invocation.
- `max_heap_bytes`: maximum serialized database value or patch result.
- `max_request_body_bytes`: maximum body accepted by `Mudrock.storage().put`.
- `max_response_body_bytes`: maximum materialized invocation response.
- `max_open_sync_connections`: sync connection budget reserved for host runtimes.

Database and storage limit failures reject before committing records, objects, or sync events. `Mudrock.db().transaction` stages writes, then commits the record changes and mutation-log events together only after the transaction function succeeds. Primitive names normalize to lower-case platform names when possible; names that cannot normalize to `^[a-z0-9][a-z0-9_-]{0,62}$` fail with `MUDROCK_INVALID_PRIMITIVE_NAME`, and empty primitive keys fail with `MUDROCK_INVALID_KEY`.

The local default wall-clock limit is intentionally conservative at 1000 ms for fast feedback; production runtime lifecycle policy in `system-spec.json` can use a larger isolate/worker limit. Local app code now runs inside a worker thread so timed-out synchronous loops can be terminated without blocking the host event loop, while production isolate pooling and bytecode caching remain future runtime-manager work.

Gateway request validation rejects invalid deployment requests before control-plane callbacks run. Unknown infrastructure fields such as `bucket`, `database`, and `oauth_client` are rejected instead of silently ignored, keeping the zero-config contract explicit.

Agent registration uses the same strict gateway boundary: `agent_name`, `jwks_uri`, and `requested_scopes` are the only accepted fields, the JWKS URI must be absolute HTTP(S), and successful local registrations store deterministic agent/client identifiers for OMD/AuthKit development flows. The local token endpoint supports `client_credentials` requests for registered `client_id` values, rejects unapproved scopes, returns `access_token`, `token_type`, `expires_in`, and `scope`, and can enforce `apps:create`, `apps:deploy`, and `logs:read` on control-plane routes when authenticated mode is enabled. The local app-session flow keeps provider exchange offline for the prototype while preserving the important broker semantics: state is durable, callback consumption is one-time, tokens are namespace-bound, and app code receives only the brokered user shape.

## Expected Platform Behavior

The current local pieces compose through `createLocalPlatform`, which wires `LocalGateway` + `LocalProjectStore` + worker-backed `createLocalRuntime` invocation. The gateway owns HTTP routing and reserved Mudrock paths, the project store owns deployment metadata plus persisted data-plane snapshots, and the runtime owns the `Mudrock.*` host bindings used by app code.

As the helper grows, this example should continue to work without adding configuration files. Platform internals can change behind the same visible behavior:

- compiler detects `Mudrock.db("notes")`, `Mudrock.storage("attachments")`, and `Mudrock.auth`;
- runtime exposes frozen host bindings inside an invocation worker before invoking `default.fetch(request, env, ctx)`;
- data plane commits the primitive mutation and appends a mutation-log event in the same transaction;
- sync router exposes committed events at `/a/{namespace}/__mudrock/sync?primitive=notes` with SSE `id`, `event`, `data`, resume behavior, and live fanout after durable snapshot commits;
- auth broker intercepts `/__mudrock/auth/start` and issues an app session token scoped to the namespace.
