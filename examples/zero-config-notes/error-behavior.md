# Zero-Config Notes Error Behavior

This example intentionally avoids database, bucket, OAuth, queue, Docker, and build configuration. Mudrock owns those platform concerns and rejects user-managed infrastructure fields at the local gateway boundary.

## Deployment Request Errors

The gateway accepts only `name`, `entrypoint`, `source`, and `runtime` on `POST /v1/apps`. Use the checked-in request as metadata and inline the source file when sending the API request:

```bash
node -e 'const fs = require("node:fs"); const request = JSON.parse(fs.readFileSync("examples/zero-config-notes/deploy-request.json", "utf8")); request.source = fs.readFileSync(request.source_file, "utf8"); delete request.source_file; console.log(JSON.stringify(request));' \
  | curl -s -X POST http://127.0.0.1:8787/v1/apps \
    -H 'content-type: application/json' \
    -d @-
```

These requests should fail before app code runs:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/apps \
  -H 'content-type: application/json' \
  -d '{"name":"notes","entrypoint":"index.js","source":"export default {}","bucket":"my-bucket"}'

curl -i -X POST http://127.0.0.1:8787/v1/apps \
  -H 'content-type: application/json' \
  -d '{"name":"Notes","entrypoint":"index.js","source":"export default {}"}'

curl -i -X POST http://127.0.0.1:8787/v1/apps \
  -H 'content-type: application/json' \
  -d '{"name":"notes","entrypoint":"index.js","source":"export default {}","runtime":"node"}'
```

Expected local gateway behavior:

- unknown platform configuration fields return `400` with `Unsupported configuration fields: ...`;
- invalid app names return `400` with the app-name pattern;
- unsupported runtimes return `400` and name the allowed runtimes.

## Runtime Limit Errors

The local runtime enforces these default limits for app-visible platform behavior:

- `max_heap_bytes`: database values and patch results;
- `max_request_body_bytes`: storage upload bodies;
- `max_response_body_bytes`: materialized invocation responses;
- `max_open_sync_connections`: sync connection budget for host implementations.

Database and storage writes reject oversized values before committing the record, object, or sync event. Database transactions stage all writes and publish mutation-log events only after the transaction function completes successfully.

Current local invocation error shape:

- gateway validation errors are plain-text `4xx` responses;
- runtime binding failures during app invocation are logged as `invocation.failed` and surface as plain-text `500` responses;
- oversized invocation responses fail as `502` with a `max_response_body_bytes` message.
