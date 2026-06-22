# Data, Authentication, and Reactive Sync

## Runtime API

Mudrock injects a frozen global:

```ts
declare const Mudrock: {
  db(name?: string): MudrockDatabase;
  storage(name?: string): MudrockStorage;
  auth: MudrockAuth;
  sync(name?: string): MudrockSync;
};
```

Database API:

```ts
interface MudrockDatabase {
  get<T = unknown>(key: string): Promise<T | null>;
  put<T = unknown>(key: string, value: T, options?: PutOptions): Promise<MutationReceipt>;
  patch<T = unknown>(key: string, patch: Partial<T>): Promise<MutationReceipt>;
  delete(key: string): Promise<MutationReceipt>;
  list<T = unknown>(query?: ListQuery): Promise<Array<{ key: string; value: T; version: string }>>;
  transaction<T>(fn: (tx: MudrockTransaction) => Promise<T>): Promise<T>;
}

interface MudrockStorage {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, options?: StoragePutOptions): Promise<StorageObject>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<MutationReceipt>;
}
```

Primitive references are compile-time detectable from `Mudrock.db("name")`, `Mudrock.storage("name")`, and `Mudrock.sync("name")`. Runtime-created names are allowed but limited to the caller namespace and normalized with `^[a-z0-9][a-z0-9_-]{0,62}$`.

## Persistence Layer

Mudrock supports two backend profiles behind the same host-binding API.

### SQLite WAL Profile

Default for small deployments and single-region tenants.

Layout:

```text
tenant_root/
  control.sqlite
  apps/
    {namespace_hash_prefix}/
      {namespace}.sqlite
      {namespace}.sqlite-wal
      {namespace}.sqlite-shm
```

Logical tables:

```sql
CREATE TABLE kv_records (
  primitive TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  value_json BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (primitive, key)
);

CREATE TABLE binary_blocks (
  primitive TEXT NOT NULL,
  object_key TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  block_sha256 BLOB NOT NULL,
  content_type TEXT,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (primitive, object_key, block_index)
);

CREATE TABLE mutation_log (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  primitive TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json BLOB,
  created_at INTEGER NOT NULL
);
```

SQLite settings:

- `PRAGMA journal_mode=WAL`
- `PRAGMA synchronous=NORMAL`
- `PRAGMA busy_timeout=250`
- `PRAGMA foreign_keys=ON`
- `PRAGMA trusted_schema=OFF`

Each namespace has a distinct SQLite file. App code never receives a file path or SQL handle. Host bindings call prepared statements only.

### RocksDB/Keyv Cluster Profile

Used for high write volume or multi-region replication. Key format:

```text
mr/{namespace}/kv/{primitive}/{escaped_key}
mr/{namespace}/blob/{primitive}/{object_key}/{block_index}
mr/{namespace}/log/{sequence}
```

Values use MessagePack:

```ts
type EncodedRecord = {
  version: string;
  value: unknown;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  content_type?: string;
  block_sha256?: Uint8Array;
};
```

## Streaming Binary Handler

Agents and applications can pipe binary request bodies directly to storage without configuring object storage.

Flow:

1. Worker calls `Mudrock.storage().put(key, request.body)`.
2. Host binding validates namespace capability.
3. Stream is chunked into 1 MiB blocks.
4. Each block is hashed with SHA-256 while streaming.
5. Blocks are written in a transaction with object manifest metadata.
6. A mutation event is appended to `mutation_log`.
7. `sync-router` multicasts object metadata to subscribers.

Object manifest:

```ts
type StorageObject = {
  id: string;
  primitive: string;
  key: string;
  size: number;
  content_type: string | null;
  sha256: string;
  block_size: number;
  block_count: number;
  version: string;
  created_at: string;
  updated_at: string;
  url: string;
};
```

`url` is a signed, namespace-bound route through the Mudrock gateway. It is not a bucket URL.

## Reactive Synchronization

Every mutation emitted by database or storage primitives produces a sync event.

Event:

```ts
type SyncEvent = {
  event_id: string;
  namespace: string;
  primitive: string;
  key: string;
  operation: "put" | "patch" | "delete" | "storage.put" | "storage.delete";
  version: string;
  sequence: number;
  payload?: unknown;
  occurred_at: string;
};
```

SSE endpoint:

```text
GET /a/{namespace}/__mudrock/sync?primitive=store
Accept: text/event-stream
Authorization: Bearer <session-or-agent-token>
```

WebSocket endpoint:

```text
GET /a/{namespace}/__mudrock/sync
Upgrade: websocket
Sec-WebSocket-Protocol: mudrock.sync.v1
```

Subscribe frame:

```json
{
  "type": "subscribe",
  "primitive": "store",
  "after_sequence": 0
}
```

Publish is not exposed to user code. Only successful host-binding mutations create sync events.

Fanout:

- `data-plane` writes mutation log in the same transaction as the mutation.
- `sync-router` tails namespace logs.
- Active connections are grouped by `{namespace, primitive}`.
- Events are multicast only after durable commit.
- SSE events carry `id: <event_id>`, `event: mutation`, and JSON `data`; clients resume with `Last-Event-ID`.
- WebSocket clients resume with `after_sequence`.

## OAuth Broker

Mudrock owns one platform OAuth client per provider. Applications use brokered sessions.

Client SDK:

```ts
await Mudrock.auth.signIn("github");
const user = await Mudrock.auth.currentUser();
```

Broker flow:

1. SDK redirects to `/__mudrock/auth/start?provider=github`.
2. Gateway creates `OAuthStateRecord`.
3. Gateway redirects to provider using Mudrock platform client ID and PKCE.
4. Provider redirects to `/auth/callback/{provider}`.
5. Broker validates state, nonce, PKCE verifier hash, and provider issuer.
6. Broker exchanges authorization code server-side.
7. Broker maps provider subject to namespace-scoped identity.
8. Broker issues app session token with audience `{namespace}`.
9. Gateway redirects to app callback path.

State record:

```ts
type OAuthStateRecord = {
  state_id: string;
  provider: "github" | "google";
  namespace: string;
  redirect_path: string;
  nonce_sha256: string;
  code_verifier_sha256: string;
  created_at_unix_ms: number;
  expires_at_unix_ms: number;
  consumed_at_unix_ms?: number;
};
```

Token structure:

```ts
type AppSessionTokenClaims = {
  iss: "https://auth.mudrock.dev";
  aud: string;
  sub: string;
  provider: "github" | "google" | "agent";
  provider_subject_hash: string;
  namespace: string;
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
};
```

Provider access tokens are encrypted in the broker vault and are never exposed to worker code unless a narrow provider API scope is explicitly requested by source-level annotation and approved by policy.

## OMD and AuthKit

Open Model Directory (OMD) lets autonomous agents discover platform capabilities and register applications without a dashboard.

Discovery:

```text
GET /.well-known/omd.json
```

OMD document:

```json
{
  "omd_version": "1.0",
  "platform": "mudrock",
  "api_base": "https://api.mudrock.dev",
  "authkit": {
    "token_endpoint": "https://auth.mudrock.dev/oauth/token",
    "registration_endpoint": "https://api.mudrock.dev/v1/agents/register",
    "supported_grants": ["client_credentials", "urn:ietf:params:oauth:grant-type:token-exchange"],
    "proof_methods": ["dpop+jwt", "mtls"]
  },
  "capabilities": ["deploy.raw_source", "runtime.v8", "runtime.wasm", "db.implicit", "storage.streaming", "sync.sse", "sync.websocket"]
}
```

Agent registration:

```text
POST /v1/agents/register
Content-Type: application/json
```

```json
{
  "agent_name": "example-codegen-agent",
  "jwks_uri": "https://agent.example/.well-known/jwks.json",
  "requested_scopes": ["apps:create", "apps:deploy", "logs:read"]
}
```

AuthKit token claims:

```ts
type AgentTokenClaims = {
  iss: string;
  aud: "https://api.mudrock.dev";
  sub: string;
  agent_id: string;
  owner_id: string;
  scope: string[];
  cnf: { jkt?: string; "x5t#S256"?: string };
  iat: number;
  exp: number;
  jti: string;
};
```

Local development profile:

- `POST /oauth/token` accepts the `client_credentials` grant for a registered `client_id`.
- Requested scopes must be a subset of the registration's approved scopes.
- Local tokens are structured development tokens with the same core claims as production agent tokens and a `cnf.method` value of `local-development`.
- Local gateway instances can enforce `apps:create`, `apps:deploy`, and `logs:read` scopes on control-plane routes; production still requires DPoP or mTLS proof verification.

Machine deployment:

```text
POST /v1/apps
Authorization: DPoP <agent-token>
DPoP: <proof-jwt>
```

The API verifies proof-of-possession before creating namespaces. Agent accounts cannot access user OAuth provider tokens unless the user explicitly delegates that scope through token exchange.

## Configuration Invariants

- Namespace is the primary security boundary.
- User code cannot select a physical database, bucket, OAuth client, or sync backend.
- All primitive names are logical and namespace-scoped.
- All writes append a mutation log event.
- All sync delivery is derived from committed mutations.
- OAuth state is single-use and expires in five minutes.
- Agent tokens require proof-of-possession and expire in fifteen minutes by default.
