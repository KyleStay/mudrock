import assert from "node:assert/strict";
import { test } from "node:test";

import * as mudrock from "../../src/index.js";

test("root module exports the executable platform surface", () => {
  for (const name of [
    "MemoryCompiler",
    "compileSource",
    "LocalProjectStore",
    "LocalStateConflictError",
    "LocalDataPlane",
    "DEFAULT_RUNTIME_LIMITS",
    "createLocalRuntime",
    "createLocalGateway",
    "createLocalPlatform",
    "buildOmdDocument",
    "LOCAL_MUDROCK_CAPABILITIES",
    "createNamespace",
  ]) {
    assert.notEqual(mudrock[name], undefined, `${name} should be exported`);
  }
});
