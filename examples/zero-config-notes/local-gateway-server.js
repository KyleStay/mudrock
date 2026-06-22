import { readFile } from "node:fs/promises";

import { createLocalPlatform } from "../../src/gateway/local-platform.js";

const port = Number.parseInt(process.env.MUDROCK_PORT || "8787", 10);
const host = process.env.MUDROCK_HOST || "127.0.0.1";
const baseUrl = process.env.MUDROCK_BASE_URL || `http://${host}:${port}`;
const statePath = process.env.MUDROCK_STATE_PATH || ".mudrock/zero-config-notes.json";
const ownerId = process.env.MUDROCK_OWNER_ID || "local-dev";
const appName = process.env.MUDROCK_APP_NAME || "zero-config-notes";
const platform = createLocalPlatform({
  statePath,
  ownerId,
  apiBase: baseUrl,
  authBase: baseUrl,
  gatewayBaseUrl: baseUrl
});

const deployed = await ensureExampleDeployment();
const server = platform.createServer();

server.listen(port, host, () => {
  console.log(`Mudrock local gateway listening at ${baseUrl}`);
  console.log(`State: ${statePath}`);
  console.log(`Example namespace: ${deployed.namespace}`);
  console.log(`Try: curl -s ${baseUrl}/a/${deployed.namespace}/notes`);
});

async function ensureExampleDeployment() {
  try {
    return await platform.controlPlane.getApp(appName);
  } catch (error) {
    if (!/Unknown Mudrock app/u.test(error.message)) throw error;
  }

  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const result = await platform.controlPlane.deploy({
    name: appName,
    entrypoint: "examples/zero-config-notes/index.js",
    source,
    runtime: "v8-isolate"
  });
  return platform.controlPlane.getApp(result.app_id);
}
