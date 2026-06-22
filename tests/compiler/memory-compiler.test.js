import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MemoryCompiler,
  compileSource,
  detectPrimitives,
  stripTypeScriptSyntax
} from "../../src/compiler/memory-compiler.js";

test("compileSource returns a content-addressed in-memory ESM bundle", () => {
  const result = compileSource({
    app_id: "app_test",
    namespace: "ns_test",
    entrypoint: "index.ts",
    source: `
      export default {
        async fetch(req: Request) {
          const db = Mudrock.db("Store");
          await db.put("hello", { ok: true });
          return Response.json(await db.list());
        }
      };
    `
  });

  assert.equal(result.module_format, "esm");
  assert.equal(result.runtime, "v8-isolate");
  assert.ok(result.build_id.startsWith("bld_"));
  assert.ok(Buffer.isBuffer(result.bundle_bytes));
  assert.deepEqual(result.detected_primitives, [{ kind: "db", name: "store" }]);
  assert.match(result.integrity.source_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.integrity.bundle_sha256, /^[a-f0-9]{64}$/u);
});

test("MemoryCompiler produces stable build ids for the same policy and source", () => {
  const compiler = new MemoryCompiler({ runtimeVersion: "test-node", policyVersion: "policy-a" });
  const request = {
    app_id: "app_test",
    namespace: "ns_test",
    source: "export default { fetch(){ return new Response('ok') } }"
  };

  assert.equal(compiler.compile(request).build_id, compiler.compile(request).build_id);
});

test("detectPrimitives normalizes db, storage, and sync references", () => {
  assert.deepEqual(
    detectPrimitives(`
      Mudrock.storage();
      Mudrock.db("User Profiles");
      Mudrock.sync('User Profiles');
      await Mudrock.auth.currentUser();
    `),
    [
      { kind: "auth", name: "default" },
      { kind: "db", name: "user-profiles" },
      { kind: "storage", name: "default" },
      { kind: "sync", name: "user-profiles" }
    ]
  );
});

test("compileSource rejects disallowed runtime APIs and imports", () => {
  const rejectedSources = [
    ["import fs from 'node:fs'; export default { fetch(){} }", /outside the Mudrock runtime policy|Node built-in/u],
    ["import 'fs/promises'; export default { fetch(){} }", /Node built-in/u],
    ["export default { async fetch(){ return import(globalThis.name) } }", /Dynamic imports/u],
    ["import auth from 'mudrock:internal-auth'; export default { fetch(){} }", /Unapproved Mudrock import/u],
    ["export default { fetch(){ return new Response(process.version) } }", /outside the Mudrock runtime policy/u],
    ["export default { fetch(){ return new Response(eval('1')) } }", /outside the Mudrock runtime policy/u],
    ["export default { fetch(){ return new Response(Buffer.from('x')) } }", /outside the Mudrock runtime policy/u],
    ["export default { fetch(){ return Function('return 1')() } }", /outside the Mudrock runtime policy/u],
    ["export default { fetch(){ return new Function('return 1')() } }", /outside the Mudrock runtime policy/u],
    ["export default { fetch(){ return WebAssembly.compile(new Uint8Array()) } }", /outside the Mudrock runtime policy/u],
    ["export default { fetch(){ return globalThis.constructor.constructor('return process')() } }", /outside the Mudrock runtime policy/u]
  ];

  for (const [source, message] of rejectedSources) {
    assert.throws(
      () => compileSource({ app_id: "app_test", namespace: "ns_test", source }),
      message,
    );
  }
});

test("compileSource ignores policy-looking text in comments and strings", () => {
  const result = compileSource({
    app_id: "app_test",
    namespace: "ns_test",
    source: `
      // import fs from "node:fs";
      const note = "process.env and require('fs') are just text here";
      export default { fetch(){ return new Response(note) } };
    `
  });

  assert.equal(result.runtime, "v8-isolate");
});

test("compileSource allows Mudrock auth require primitive usage", () => {
  const result = compileSource({
    app_id: "app_test",
    namespace: "ns_test",
    source: `
      export default {
        async fetch(request) {
          return Response.json(await Mudrock.auth.require(request));
        }
      };
    `
  });

  assert.deepEqual(result.detected_primitives, [{ kind: "auth", name: "default" }]);
});

test("compileSource extracts nested and re-exported static route declarations", () => {
  const nestedRoutes = compileSource({
    app_id: "app_test",
    namespace: "ns_test",
    source: `
      export const routes = [
        { path: "/notes", children: [{ path: "/notes/:id" }] },
        { path: "/attachments" }
      ];
      export default { fetch(){} };
    `
  });

  assert.equal(nestedRoutes.static_routes.length, 1);
  assert.match(nestedRoutes.static_routes[0].declaration, /"\/notes\/:id"/u);
  assert.match(nestedRoutes.static_routes[0].declaration, /"\/attachments"/u);

  const reexportedRoutes = compileSource({
    app_id: "app_test",
    namespace: "ns_test",
    source: `
      const appRoutes = { prefixes: ["/notes", "/session"] };
      export { appRoutes as routes };
      export default { fetch(){} };
    `
  });

  assert.deepEqual(
    reexportedRoutes.static_routes,
    [{ kind: "source-export", declaration: "{ prefixes: [\"/notes\", \"/session\"] }" }]
  );
});

test("stripTypeScriptSyntax handles the README-style request annotation", () => {
  assert.equal(
    stripTypeScriptSyntax("async fetch(req: Request) { return new Response(req.url); }"),
    "async fetch(req) { return new Response(req.url); }"
  );
});
