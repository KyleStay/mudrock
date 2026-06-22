# Infrastructure Virtualization

## Goals

Mudrock accepts source code as data and returns a routable application namespace. The deployment path never writes user source, build intermediates, dependency graphs, or generated bundles to local disk. Durable state is stored only as normalized metadata and content-addressed records in the control database.

## Services

### `api-gateway`

Public HTTP edge for deployments, invocations, auth callbacks, and sync upgrades.

Endpoints:

- `POST /v1/apps`: accepts raw source deployment payload.
- `POST /v1/apps/{app_id}/deployments`: creates a new deployment for an existing namespace.
- `GET /a/{namespace}/{path...}`: invokes the active worker revision.
- `GET /a/{namespace}/__mudrock/sync`: opens SSE or WebSocket sync channel.
- `GET /auth/callback/{provider}`: receives brokered OAuth callback.

The gateway validates caller identity, computes a deployment namespace, attaches a request boundary token, and forwards compilation jobs over gRPC to `compilerd`.

### `compilerd`

Memory-only bundling service using an embedded esbuild or SWC binding. It does not shell out to build tools and does not mount user-controlled filesystems.

Module interface:

```ts
type CompileRequest = {
  request_id: string;
  app_id: string;
  namespace: string;
  entrypoint: string;
  source: string;
  runtime: "v8-isolate" | "wasm-worker";
  language_hint?: "ts" | "tsx" | "js" | "jsx";
  import_policy: ImportPolicy;
};

type CompileResult = {
  build_id: string;
  module_format: "esm";
  bundle_bytes: Uint8Array;
  source_map_bytes?: Uint8Array;
  static_routes: RouteHint[];
  detected_primitives: PrimitiveRef[];
  integrity: {
    source_sha256: string;
    bundle_sha256: string;
    dependency_lock_sha256: string;
  };
};
```

Bundler implementation:

- Uses esbuild `build({ stdin, write: false, bundle: true, format: "esm", platform: "neutral" })`.
- Uses a custom `mudrock-resolver` plugin.
- Resolves only approved built-ins: `mudrock:runtime`, `mudrock:db`, `mudrock:storage`, `mudrock:auth`, `mudrock:sync`.
- Resolves npm imports through a cached package graph stored in the control plane, addressed by package name, version, and SRI.
- Rejects dynamic filesystem reads, native modules, postinstall scripts, and bare Node process APIs.
- Stores compiled output in process memory until handed to `runtime-manager`.
- Persists only compile metadata and content hashes.

### `runtime-manager`

Owns worker placement, isolate pooling, lifecycle limits, and bundle activation.

Data structure:

```ts
type RuntimeRevision = {
  app_id: string;
  namespace: string;
  build_id: string;
  active_from_unix_ms: number;
  bundle_sha256: string;
  runtime: "v8-isolate" | "wasm-worker";
  limits: RuntimeLimits;
  routes: RouteHint[];
};

type RuntimeLimits = {
  max_cpu_ms_per_request: number;
  max_wall_ms_per_request: number;
  max_heap_bytes: number;
  max_request_body_bytes: number;
  max_response_body_bytes: number;
  max_open_sync_connections: number;
};
```

## V8 Isolate Runtime

The default runtime is a V8 isolate pool with per-app compartments.

Per isolate:

- One app revision.
- Frozen global object.
- No direct filesystem, process, TCP, UDP, child process, or clock mutation APIs.
- Web platform APIs: `Request`, `Response`, `URL`, `Headers`, `ReadableStream`, `WritableStream`, `TransformStream`, `crypto.subtle`.
- Mudrock APIs injected as immutable host bindings.

Invocation flow:

1. `api-gateway` receives request.
2. Gateway resolves `{host,path}` to `{namespace, build_id}` using `route-table`.
3. Gateway creates `InvocationEnvelope`.
4. `runtime-manager` leases a warm isolate or starts a fresh one.
5. Host converts the HTTP request to a WHATWG `Request`.
6. Worker default export `fetch(request, env, ctx)` is invoked.
7. Host enforces CPU, wall-clock, heap, input, and output limits.
8. Response streams back through the gateway.
9. Worker is returned to pool or destroyed based on taint/lifetime policy.

Local executable profile:

- The local prototype imports compiled bundles from memory-resident `data:` URLs salted by namespace and deployment id.
- Local platform and CLI invocations execute app code in a worker thread against a base data-plane snapshot, then merge non-conflicting worker deltas into the latest local state and append the completion log in one state update only after host response limits pass.
- The worker installs an async-context Mudrock proxy for the current invocation's frozen host binding without reusing another app's namespace.
- Local wall-clock enforcement terminates the invocation worker, so synchronous loops cannot pin the gateway or CLI process. Production isolate pooling, taint handling, and bytecode caching remain runtime-manager responsibilities.

Invocation envelope:

```ts
type InvocationEnvelope = {
  invocation_id: string;
  app_id: string;
  namespace: string;
  build_id: string;
  method: string;
  url: string;
  headers: [string, string][];
  body_stream_id?: string;
  client_ip_hash: string;
  auth_context?: AuthContext;
  deadline_unix_ms: number;
};
```

Cold-start controls:

- Keep one prewarmed isolate per active namespace while traffic is present.
- Snapshot common Mudrock host bindings into a base isolate snapshot.
- Cache compiled bytecode by `bundle_sha256`.
- Destroy isolates after 128 requests, 60 seconds idle, heap watermark breach, or capability violation.
- Preload new revision before route activation.

## WASM Worker Runtime

WASM is used when the compiler produces a WASI-compatible component.

Constraints:

- Component model ABI.
- WASI preview 2 style HTTP adapter.
- No host filesystem preopens.
- Host capabilities provided through explicit imports: `mudrock_db`, `mudrock_storage`, `mudrock_auth`, `mudrock_sync`.
- Fuel metering and linear-memory caps enforced by the host.

## Routing and Request Interception

`route-table` maps hostnames and path prefixes to active revisions:

```ts
type RouteRecord = {
  route_id: string;
  namespace: string;
  host: string;
  path_prefix: string;
  build_id: string;
  priority: number;
  created_at_unix_ms: number;
};
```

Static route hints are extracted at compile time when source exports a `routes` object. Dynamic routing remains inside the worker.

Reserved paths:

- `/__mudrock/sync`
- `/__mudrock/auth/start`
- `/__mudrock/auth/callback`
- `/__mudrock/health`
- `/__mudrock/manifest`

User code cannot override reserved paths. The gateway intercepts them before isolate invocation.

## Network Protocols

Internal protocols:

- Gateway to compiler: gRPC over mTLS, service `mudrock.compiler.v1.Compiler/Compile`.
- Gateway to runtime manager: gRPC over mTLS, service `mudrock.runtime.v1.Runtime/Invoke`.
- Runtime host to data plane: Unix domain socket when colocated, otherwise mTLS gRPC.
- Sync fanout: NATS JetStream-compatible subject model or Redis Streams-compatible backend behind `sync-router`.

External protocols:

- HTTP/1.1 and HTTP/2 for app traffic.
- WebSocket and SSE for reactive sync.
- OAuth 2.1 authorization code with PKCE through brokered callbacks.
- OMD/AuthKit JSON over HTTPS for machine-to-machine provisioning.

## Security Boundaries

Tenant isolation is enforced at every boundary:

- Namespace ID is derived from control-plane app ID and owner ID, not from user input.
- Host bindings receive a signed `CapabilityToken`.
- Every data-plane request validates token audience, namespace, primitive, operation, and expiry.
- Isolates cannot mint capability tokens.
- Bundle cache keys include runtime version and policy version.
- OAuth state is bound to namespace, provider, nonce, redirect path, and code verifier hash.

Known failure classes addressed:

- Cross-tenant data access: rejected by namespace-scoped capability tokens and database authorizers.
- V8 cold starts: bounded with bytecode cache, base snapshots, and pre-activation warming.
- OAuth token collision: prevented by namespaced state records, nonce uniqueness, PKCE verifier binding, and provider subject mapping.
- Bundle cache poisoning: prevented by source hash, dependency lock hash, runtime version, and policy version in the build key.
