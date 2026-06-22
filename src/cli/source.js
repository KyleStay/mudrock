import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";

export async function loadDeploymentSource({ file, useStdin, stdin }) {
  if (useStdin) {
    return {
      entrypoint: "stdin",
      source: await readStream(stdin)
    };
  }

  const source = await fs.readFile(file, "utf8");
  return {
    entrypoint: path.basename(file),
    source
  };
}

export async function loadBody({ body, bodyFile }) {
  if (body !== undefined && bodyFile !== undefined) {
    throw new CliError("Use either --body or --body-file, not both");
  }

  if (body !== undefined) return body;
  if (bodyFile !== undefined) return fs.readFile(bodyFile, "utf8");
  return undefined;
}

export async function loadJsonFile(file) {
  const text = await fs.readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`Invalid JSON in ${file}: ${error.message}`);
  }
}

export function deriveAppName(file) {
  if (!file) return undefined;
  const name = path.basename(file, path.extname(file)).toLowerCase();
  const normalized = name.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(chunks.join("")));
  });
}
