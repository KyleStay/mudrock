import { CliError } from "./errors.js";

export function parseArgv(argv) {
  const tokens = [...argv];
  const globals = parseLeadingOptions(tokens, new Set(["api-base", "token", "auth-scheme", "json", "help"]));
  const command = tokens.shift();

  if (globals.help || command === "help" || command === undefined) {
    return { command: "help", globals };
  }

  switch (command) {
    case "deploy":
      return parseDeploy(tokens, globals);
    case "invoke":
      return parseInvoke(tokens, globals);
    case "logs":
      return parseLogs(tokens, globals);
    case "omd":
      return parseOmd(tokens, globals);
    default:
      throw new CliError(`Unknown command: ${command}`);
  }
}

function parseLeadingOptions(tokens, allowed) {
  const options = {};

  while (tokens[0]?.startsWith("--")) {
    const token = tokens.shift();
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    if (!allowed.has(rawName)) {
      throw new CliError(`Unknown option: --${rawName}`);
    }

    if (isBooleanOption(rawName)) {
      options[toCamel(rawName)] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    const value = inlineValue === undefined ? tokens.shift() : inlineValue;
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Missing value for --${rawName}`);
    }

    options[toCamel(rawName)] = value;
  }

  return options;
}

function parseDeploy(tokens, globals) {
  const options = parseOptions(tokens, new Set(["name", "stdin", "runtime", "app", "entrypoint"]));
  const file = tokens.shift();
  ensureNoExtra(tokens);

  if (!options.stdin && !file) {
    throw new CliError("deploy requires a file path unless --stdin is set");
  }

  return {
    command: "deploy",
    globals,
    file,
    options
  };
}

function parseInvoke(tokens, globals) {
  const options = parseOptions(tokens, new Set(["method", "body", "body-file", "header"]));
  const app = tokens.shift();
  const path = tokens.shift();
  ensureNoExtra(tokens);

  if (!app || !path) {
    throw new CliError("invoke requires <app> and <path>");
  }

  return {
    command: "invoke",
    globals,
    app,
    path,
    options
  };
}

function parseLogs(tokens, globals) {
  const options = parseOptions(tokens, new Set(["tail"]));
  const app = tokens.shift();
  ensureNoExtra(tokens);

  if (!app) {
    throw new CliError("logs requires <app>");
  }

  return {
    command: "logs",
    globals,
    app,
    options
  };
}

function parseOmd(tokens, globals) {
  const subcommand = tokens.shift();
  if (!["claim", "token"].includes(subcommand)) {
    throw new CliError("omd requires the claim or token subcommand");
  }

  if (subcommand === "token") {
    const options = parseOptions(tokens, new Set(["client-id", "scope", "omd-url", "token-endpoint"]));
    ensureNoExtra(tokens);

    if (!options.clientId) {
      throw new CliError("omd token requires --client-id <id>");
    }

    return {
      command: "omd:token",
      globals,
      options
    };
  }

  const options = parseOptions(tokens, new Set(["manifest", "omd-url"]));
  ensureNoExtra(tokens);

  if (!options.manifest) {
    throw new CliError("omd claim requires --manifest <file>");
  }

  return {
    command: "omd:claim",
    globals,
    options
  };
}

function parseOptions(tokens, allowed) {
  const options = {};
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      index += 1;
      continue;
    }

    tokens.splice(index, 1);
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    if (!allowed.has(rawName)) {
      throw new CliError(`Unknown option: --${rawName}`);
    }

    if (isBooleanOption(rawName)) {
      options[toCamel(rawName)] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }

    const value = inlineValue === undefined ? tokens.splice(index, 1)[0] : inlineValue;
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Missing value for --${rawName}`);
    }

    const name = toCamel(rawName);
    if (name === "header") {
      options.header = [...(options.header || []), value];
    } else {
      options[name] = value;
    }
  }

  return options;
}

function ensureNoExtra(tokens) {
  if (tokens.length > 0) {
    throw new CliError(`Unexpected argument: ${tokens[0]}`);
  }
}

function isBooleanOption(name) {
  return name === "stdin" || name === "json" || name === "help";
}

function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
