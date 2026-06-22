import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { ControlPlaneClient } from "../control-plane/client.js";
import { DEFAULT_RUNTIME_LIMITS, LocalDataPlane } from "../runtime/index.mjs";
import { LocalInvocationTimeoutError } from "../runtime/local-invocation.js";
import { invokeLocalBundleInWorker } from "../runtime/worker-invocation.js";
import { LOCAL_MUDROCK_CAPABILITIES, buildOmdDocument } from "../omd/manifest.js";
import { createLocalControlPlane } from "../control-plane/local-store.js";
import { createLocalPlatform } from "../gateway/local-platform.js";
import { parseArgv } from "./args.js";
import { CliError } from "./errors.js";
import { writeDeployment, writeJson, writeRegistration } from "./output.js";
import { deriveAppName, loadBody, loadDeploymentSource, loadJsonFile } from "./source.js";

export async function main(argv, io = defaultIo()) {
  if (hasRemoteApiBase(argv)) {
    await remoteMain(argv, io);
    return;
  }

  await localMain(argv, io);
}

export async function runCli(argv, env = {}, streams = {}) {
  const io = {
    stdin: streams.stdin ?? process.stdin,
    stdout: streams.stdout ?? process.stdout,
    stderr: streams.stderr ?? process.stderr,
    env: { ...process.env, ...env }
  };

  try {
    await main(argv, io);
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    io.stderr.write(`${error.message}\n`);
    return exitCode;
  }
}

async function remoteMain(argv, io) {
  const parsed = parseArgv(argv);

  if (parsed.command === "help") {
    io.stdout.write(helpText());
    return;
  }

  const client = new ControlPlaneClient({
    apiBase: parsed.globals.apiBase,
    token: parsed.globals.token ?? io.env.MUDROCK_TOKEN,
    authScheme: parsed.globals.authScheme ?? "Bearer"
  });

  if (parsed.command === "deploy") {
    const source = await loadDeploymentSource({
      file: parsed.file,
      useStdin: parsed.options.stdin,
      stdin: io.stdin
    });
    const result = parsed.options.app
      ? await client.createDeployment(parsed.options.app, {
        ...source,
        runtime: parsed.options.runtime
      })
      : await client.createApp({
        name: parsed.options.name ?? deriveAppName(parsed.file),
        ...source,
        runtime: parsed.options.runtime
      });

    parsed.globals.json ? writeJson(io.stdout, result) : writeDeployment(io.stdout, result);
    return;
  }

  if (parsed.command === "invoke") {
    const body = await loadBody(parsed.options);
    const headers = parseHeaders(parsed.options.header ?? []);
    const response = await client.invoke(parsed.app, parsed.path, {
      method: parsed.options.method ?? "GET",
      headers,
      body
    });
    io.stdout.write(response.body.endsWith("\n") ? response.body : `${response.body}\n`);
    return;
  }

  if (parsed.command === "logs") {
    const response = await client.logs(parsed.app, { tail: parsed.options.tail });
    io.stdout.write(response.body);
    return;
  }

  if (parsed.command === "omd:claim") {
    const discovery = await client.discoverOmd(parsed.options.omdUrl);
    const manifest = await loadJsonFile(parsed.options.manifest);
    const result = await client.registerAgent(discovery.authkit.registration_endpoint, manifest);
    parsed.globals.json ? writeJson(io.stdout, result) : writeRegistration(io.stdout, result);
    return;
  }

  if (parsed.command === "omd:token") {
    const discovery = parsed.options.tokenEndpoint
      ? null
      : await client.discoverOmd(parsed.options.omdUrl);
    const tokenEndpoint = parsed.options.tokenEndpoint ?? discovery.authkit.token_endpoint;
    writeJson(io.stdout, await client.requestAgentToken(tokenEndpoint, {
      client_id: parsed.options.clientId,
      scope: parsed.options.scope
    }));
    return;
  }

  throw new CliError(`Unsupported command: ${parsed.command}`);
}

async function localMain(argv, io) {
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout.write(helpText());
    return;
  }

  if (command === "deploy") {
    await localDeployCommand(argv.slice(1), io);
    return;
  }

  if (command === "invoke") {
    await localInvokeCommand(argv.slice(1), io);
    return;
  }

  if (command === "logs") {
    await localLogsCommand(argv.slice(1), io);
    return;
  }

  if (command === "serve") {
    await localServeCommand(argv.slice(1), io);
    return;
  }

  if (command === "omd" && argv[1] === "claim") {
    await localOmdClaimCommand(argv.slice(2), io);
    return;
  }

  if (command === "omd" && argv[1] === "token") {
    await localOmdTokenCommand(argv.slice(2), io);
    return;
  }

  throw new CliError(`Unknown command: ${argv.join(" ")}`);
}

async function localDeployCommand(argv, io) {
  const options = parseLocalOptions(argv);
  const file = options.positionals[0];
  const source = options.stdin
    ? await readAll(io.stdin)
    : await readFile(requireValue(file, "deploy requires a file or --stdin"), "utf8");
  const name = options.name ?? inferName(file) ?? "app";
  const entrypoint = options.entrypoint ?? file ?? "stdin.js";
  const controlPlane = createStore(options, io);
  const result = await controlPlane.deploy({
    name,
    entrypoint,
    source,
    runtime: options.runtime ?? "v8-isolate"
  });

  writeJson(io.stdout, result);
}

async function localInvokeCommand(argv, io) {
  const options = parseLocalOptions(argv);
  const [appName, path = "/"] = options.positionals;
  const controlPlane = createStore(options, io);
  const requiredAppName = requireValue(appName, "invoke requires an app name");

  let committed;
  try {
    committed = await controlPlane.withMergedDataPlaneForApp(requiredAppName, async ({
      app,
      dataPlane,
      baseSnapshot
    }) => {
      const deployment = app.deployments[app.active_deployment_id];
      const limits = runtimeLimitsForDeployment(deployment);
      const request = new Request(new URL(path, options.origin ?? "https://local.mudrock.dev"), {
        method: options.method ?? "GET",
        body: options.body,
        headers: options.body ? { "content-type": options.contentType ?? "text/plain" } : undefined
      });
      const result = await invokeLocalBundleInWorker({
        buildId: deployment.build_id,
        bundleText: deployment.bundle_text,
        dataPlaneSnapshot: baseSnapshot,
        deploymentId: deployment.deployment_id,
        gatewayBaseUrl: options.gatewayBaseUrl ?? "https://local.mudrock.dev",
        limits,
        namespace: app.namespace,
        request,
        timeoutMs: limits.max_wall_ms_per_request
      });
      const text = await limitedResponseText(result.response, limits.max_response_body_bytes);
      return {
        dataPlane: new LocalDataPlane(result.dataPlaneSnapshot),
        logs: [{
          app: app.name,
          namespace: app.namespace,
          deployment_id: app.active_deployment_id,
          event: "invocation.completed",
          method: request.method,
          path: new URL(request.url).pathname,
          status: result.response.status
        }],
        value: { text }
      };
    });
  } catch (error) {
    if (error instanceof LocalInvocationTimeoutError) {
      throw new CliError(error.message);
    }
    throw error;
  }
  const { text } = committed;
  io.stdout.write(text);
  if (text && !text.endsWith("\n")) io.stdout.write("\n");
}

function runtimeLimitsForDeployment(deployment) {
  return Object.freeze({
    ...DEFAULT_RUNTIME_LIMITS,
    ...(deployment.runtime_limits ?? {})
  });
}

async function limitedResponseText(response, maxBytes) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new CliError(`Invocation response exceeds max_response_body_bytes (${bytes.byteLength} bytes > ${maxBytes} bytes).`);
  }
  return new TextDecoder().decode(bytes);
}

async function localLogsCommand(argv, io) {
  const options = parseLocalOptions(argv);
  const controlPlane = createStore(options, io);
  writeJson(io.stdout, await controlPlane.logs(options.positionals[0]));
}

async function localServeCommand(argv, io) {
  const options = parseLocalOptions(argv);
  const port = Number.parseInt(options.port ?? "8787", 10);
  const host = options.host ?? "127.0.0.1";
  const { server, url } = createServeCommandServer({ options, io, port, host });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  io.stdout.write(`Mudrock local gateway listening at ${url}\n`);
}

export function createServeCommandServer({ options = {}, io = defaultIo(), port = 8787, host = "127.0.0.1" } = {}) {
  const apiBase = options.apiBase ?? `http://${host}:${port}`;
  const platform = createLocalPlatform({
    statePath: options.state ?? io.env.MUDROCK_STATE_PATH ?? ".mudrock/local-state.json",
    ownerId: options.owner ?? io.env.MUDROCK_OWNER_ID ?? "local",
    apiBase,
    authBase: options.authBase ?? apiBase,
    gatewayBaseUrl: options.gatewayBaseUrl ?? apiBase,
    authContext: options.userId ? {
      user: {
        id: options.userId,
        provider: options.provider ?? "local",
      },
    } : undefined,
  });

  return {
    platform,
    server: platform.createServer(),
    url: apiBase,
  };
}

async function localOmdClaimCommand(argv, io) {
  const options = parseLocalOptions(argv);
  if (options.manifest) {
    const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
    const controlPlane = createStore(options, io);
    writeJson(io.stdout, await controlPlane.claimAgent(manifest, {
      apiBase: options.apiBase ?? "https://api.mudrock.dev",
      authBase: options.authBase ?? "https://auth.mudrock.dev"
    }));
    return;
  }

  writeJson(io.stdout, buildOmdDocument({
    apiBase: options.apiBase ?? "https://api.mudrock.dev",
    authBase: options.authBase ?? "https://auth.mudrock.dev",
    capabilities: LOCAL_MUDROCK_CAPABILITIES
  }));
}

async function localOmdTokenCommand(argv, io) {
  const options = parseLocalOptions(argv);
  const controlPlane = createStore(options, io);
  const clientId = requireValue(options.clientId, "omd token requires --client-id <id>");

  writeJson(io.stdout, await controlPlane.issueAgentToken({
    grant_type: "client_credentials",
    client_id: clientId,
    scope: options.scope
  }, {
    issuer: options.authBase ?? "https://auth.mudrock.dev",
    audience: options.apiBase ?? "https://api.mudrock.dev"
  }));
}

function parseLocalOptions(argv) {
  const options = { positionals: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      options.positionals.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (["stdin", "json"].includes(key)) {
      options[key] = true;
      continue;
    }

    options[key] = inlineValue ?? argv[++index];
  }

  return options;
}

function createStore(options, io) {
  return createLocalControlPlane({
    statePath: options.state ?? io.env.MUDROCK_STATE_PATH ?? ".mudrock/local-state.json",
    ownerId: options.owner ?? io.env.MUDROCK_OWNER_ID ?? "local"
  });
}

function parseHeaders(values) {
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf(":");
    if (separator === -1) {
      throw new CliError(`Invalid header, expected "name: value": ${value}`);
    }

    return [value.slice(0, separator).trim().toLowerCase(), value.slice(separator + 1).trim()];
  }));
}

function hasRemoteApiBase(argv) {
  return argv[0] === "--api-base" || argv[0]?.startsWith("--api-base=");
}

function inferName(file) {
  if (!file) return null;
  return basename(file, extname(file)).toLowerCase().replace(/[^a-z0-9_-]+/gu, "-");
}

function requireValue(value, message) {
  if (!value) throw new CliError(message);
  return value;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function helpText() {
  return `Mudrock local prototype

Usage:
  mudrock deploy <file> [--name app-name] [--state path]
  mudrock deploy --stdin --name app-name [--state path]
  mudrock invoke <app> <path> [--method GET] [--body text] [--state path]
  mudrock logs [app] [--state path]
  mudrock serve [--host 127.0.0.1] [--port 8787] [--state path]
  mudrock omd claim [--manifest manifest.json]
  mudrock omd token --client-id client_id [--scope "apps:create logs:read"]

Remote API mode:
  mudrock --api-base <url> deploy --stdin --name app-name
  mudrock --api-base <url> invoke <app> <path>
`;
}

function defaultIo() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}
