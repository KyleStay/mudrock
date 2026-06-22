import { Buffer } from "node:buffer";
import { builtinModules } from "node:module";
import { createBuildId, hashBytes, normalizePrimitiveName, stableJson } from "../shared/index.js";

const APPROVED_MUDROCK_IMPORTS = new Set([
  "mudrock:runtime",
  "mudrock:db",
  "mudrock:storage",
  "mudrock:auth",
  "mudrock:sync"
]);

const REJECTED_RUNTIME_APIS = [
  /(?<![\w$.])process\b/u,
  /\bglobalThis\s*\.\s*process\b/u,
  /\bglobalThis\s*\.\s*constructor\s*\.\s*constructor\b/u,
  /(?<![\w$.])eval\s*\(/u,
  /(?<![\w$.])Buffer\b/u,
  /(?<![\w$.])Function\s*\(/u,
  /\bnew\s+Function\s*\(/u,
  /\bWebAssembly\b/u,
  /\b(?:Deno|Bun)\s*\./u,
  /\bmodule\s*\.\s*exports\b/u,
  /\bimport\s*\.\s*meta\s*\.\s*resolve\b/u
];

const NODE_BUILTIN_IMPORTS = new Set(
  builtinModules.flatMap((specifier) => {
    const withoutPrefix = specifier.replace(/^node:/u, "");
    return [specifier, withoutPrefix];
  })
);

export class MemoryCompiler {
  constructor({
    runtimeVersion = process.version,
    policyVersion = "local-v1",
    approvedMudrockImports = APPROVED_MUDROCK_IMPORTS
  } = {}) {
    this.runtimeVersion = runtimeVersion;
    this.policyVersion = policyVersion;
    this.approvedMudrockImports = approvedMudrockImports;
  }

  compile(request) {
    return compileSource(request, {
      runtimeVersion: this.runtimeVersion,
      policyVersion: this.policyVersion,
      approvedMudrockImports: this.approvedMudrockImports
    });
  }
}

export function compileSource(request, options = {}) {
  const {
    app_id: appId,
    namespace,
    entrypoint = "index.ts",
    source,
    runtime = "v8-isolate",
    language_hint: languageHint = inferLanguage(entrypoint)
  } = request ?? {};

  if (!source || typeof source !== "string") {
    throw new TypeError("compileSource requires a source string");
  }

  if (!appId || !namespace) {
    throw new TypeError("compileSource requires app_id and namespace");
  }

  if (!["v8-isolate", "wasm-worker"].includes(runtime)) {
    throw new TypeError(`Unsupported runtime: ${runtime}`);
  }

  enforceDependencyPolicy(source, options.approvedMudrockImports ?? APPROVED_MUDROCK_IMPORTS);

  const transformedSource = ["ts", "tsx"].includes(languageHint)
    ? stripTypeScriptSyntax(source)
    : source;
  const bundledSource = rewriteMudrockImports(transformedSource);
  const buildId = createBuildId({
    source,
    policyVersion: options.policyVersion ?? "local-v1",
    runtimeVersion: options.runtimeVersion ?? process.version
  });
  const bundleBytes = Buffer.from(bundledSource, "utf8");
  const primitives = detectPrimitives(source);

  return {
    build_id: buildId,
    app_id: appId,
    namespace,
    entrypoint,
    module_format: "esm",
    runtime,
    bundle_bytes: bundleBytes,
    bundle_text: bundledSource,
    static_routes: detectStaticRoutes(source),
    detected_primitives: primitives,
    integrity: {
      source_sha256: hashBytes(source),
      bundle_sha256: hashBytes(bundleBytes),
      dependency_lock_sha256: hashBytes(stableJson({
        mudrock_imports: [...findImportSpecifiers(source)]
          .filter((specifier) => specifier.startsWith("mudrock:"))
          .sort()
      }))
    }
  };
}

export function detectPrimitives(source) {
  const primitives = new Map();
  const patterns = [
    ["db", /\bMudrock\.db\((?:"([^"]*)"|'([^']*)')?\)/gu],
    ["storage", /\bMudrock\.storage\((?:"([^"]*)"|'([^']*)')?\)/gu],
    ["sync", /\bMudrock\.sync\((?:"([^"]*)"|'([^']*)')?\)/gu],
    ["auth", /\bMudrock\.auth\b/gu]
  ];

  for (const [kind, pattern] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = normalizePrimitiveName(match[1] || match[2] || "default");
      primitives.set(`${kind}:${name}`, { kind, name });
    }
  }

  return [...primitives.values()].sort((left, right) =>
    `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
  );
}

export function rewriteMudrockImports(source) {
  return source
    .replace(/^\s*import\s+[^;]*\s+from\s+["']mudrock:[^"']+["'];?\s*$/gmu, "")
    .replace(/^\s*import\s+["']mudrock:[^"']+["'];?\s*$/gmu, "");
}

export function stripTypeScriptSyntax(source) {
  return source
    .replace(/^\s*export\s+type\s+[^;]+;?\s*$/gmu, "")
    .replace(/^\s*type\s+[^;]+;?\s*$/gmu, "")
    .replace(/^\s*interface\s+\w+\s*\{[\s\S]*?^\}\s*$/gmu, "")
    .replace(/\s+as\s+const\b/gu, "")
    .replace(/:\s*(?:Promise<[^>]+>|ReadonlyArray<[^>]+>|Array<[^>]+>|[A-Z_a-z][\w.$<>[\], ?|&]*)\s*(?=[,)=;{])/gu, "");
}

function enforceDependencyPolicy(source, approvedMudrockImports) {
  const approvedImports = new Set(approvedMudrockImports);
  const sourceWithoutNonCode = maskNonCode(source);

  for (const pattern of REJECTED_RUNTIME_APIS) {
    if (pattern.test(sourceWithoutNonCode)) {
      throw new TypeError("Source uses an API that is outside the Mudrock runtime policy");
    }
  }

  if (hasBareRequireCall(sourceWithoutNonCode)) {
    throw new TypeError("Source uses an API that is outside the Mudrock runtime policy");
  }

  if (hasNonLiteralDynamicImport(source)) {
    throw new TypeError("Dynamic imports inside Mudrock workers must use string literal specifiers");
  }

  for (const specifier of findImportSpecifiers(source)) {
    if (specifier.startsWith("mudrock:") && !approvedImports.has(specifier)) {
      throw new TypeError(`Unapproved Mudrock import: ${specifier}`);
    }

    if (isNodeBuiltinSpecifier(specifier)) {
      throw new TypeError(`Node built-in imports are not available inside Mudrock workers: ${specifier}`);
    }
  }
}

function findImportSpecifiers(source) {
  const specifiers = new Set();
  const maskedSource = maskNonCode(source);
  const patterns = [
    /\bimport\b(?!\s*\()\s+[\s\S]*?\bfrom\s*(["'])/gu,
    /\bimport\s*(["'])/gu,
    /\bimport\s*\(\s*(["'])/gu,
    /\bexport\b[\s\S]*?\bfrom\s*(["'])/gu,
    /(?<![\w$.])require\s*\(\s*(["'])/gu
  ];

  for (const pattern of patterns) {
    for (const match of maskedSource.matchAll(pattern)) {
      const quoteIndex = match.index + match[0].lastIndexOf(match[1]);
      const specifier = readStringLiteral(source, quoteIndex);
      if (specifier) {
        specifiers.add(specifier);
      }
    }
  }

  return specifiers;
}

function detectStaticRoutes(source) {
  const maskedSource = maskNonCode(source);
  const directExport = /\bexport\s+(?:const|let|var)\s+routes\s*=/gu.exec(maskedSource);
  if (directExport) {
    const declaration = extractAssignedLiteral(source, directExport.index + directExport[0].length);
    return declaration ? [{ kind: "source-export", declaration: declaration.slice(0, 1_000) }] : [];
  }

  for (const exportMatch of maskedSource.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    const localName = findRoutesExportLocalName(exportMatch[1]);
    if (!localName) {
      continue;
    }

    const declaration = findLocalRoutesDeclaration(source, maskedSource, localName, exportMatch.index);
    if (declaration) {
      return [{ kind: "source-export", declaration: declaration.slice(0, 1_000) }];
    }
  }

  return [];
}

function inferLanguage(entrypoint) {
  if (entrypoint.endsWith(".tsx")) return "tsx";
  if (entrypoint.endsWith(".jsx")) return "jsx";
  if (entrypoint.endsWith(".ts")) return "ts";
  return "js";
}

function isNodeBuiltinSpecifier(specifier) {
  if (specifier.startsWith("node:")) {
    return true;
  }

  const [root, ...rest] = specifier.split("/");
  if (NODE_BUILTIN_IMPORTS.has(specifier) || NODE_BUILTIN_IMPORTS.has(root)) {
    return true;
  }

  return rest.length > 0 && NODE_BUILTIN_IMPORTS.has(`${root}/${rest[0]}`);
}

function hasNonLiteralDynamicImport(source) {
  const maskedSource = maskNonCode(source);

  for (const match of maskedSource.matchAll(/\bimport\s*\(/gu)) {
    const cursor = match.index + match[0].length;
    if (!/^\s*["']/u.test(maskedSource.slice(cursor))) {
      return true;
    }
  }

  return false;
}

function hasBareRequireCall(maskedSource) {
  return /(?<![\w$.])require\s*\(/u.test(maskedSource);
}

function readStringLiteral(source, quoteIndex) {
  const quote = source[quoteIndex];
  if (quote !== "\"" && quote !== "'") {
    return "";
  }

  let value = "";
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      value += source[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (character === quote) {
      return value;
    }

    value += character;
  }

  return "";
}

function extractAssignedLiteral(source, startIndex) {
  let start = startIndex;
  while (/\s/u.test(source[start] ?? "")) {
    start += 1;
  }

  const opening = source[start];
  if (opening !== "{" && opening !== "[") {
    return "";
  }

  const end = findBalancedLiteralEnd(source, start);
  return end === -1 ? "" : source.slice(start, end);
}

function findBalancedLiteralEnd(source, startIndex) {
  const closingByOpening = new Map([
    ["{", "}"],
    ["[", "]"],
    ["(", ")"]
  ]);
  const stack = [closingByOpening.get(source[startIndex])];

  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "\"" || character === "'" || character === "`") {
      index = skipStringLike(source, index, character);
      continue;
    }

    if (character === "/" && next === "/") {
      index = skipLineComment(source, index);
      continue;
    }

    if (character === "/" && next === "*") {
      index = skipBlockComment(source, index);
      continue;
    }

    if (closingByOpening.has(character)) {
      stack.push(closingByOpening.get(character));
      continue;
    }

    if (character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

function findRoutesExportLocalName(exportBody) {
  for (const rawPart of exportBody.split(",")) {
    const part = rawPart.trim();
    const aliasMatch = /^(?<local>[A-Z_a-z][$\w]*)\s+as\s+(?<exported>[A-Z_a-z][$\w]*)$/u.exec(part);
    if (aliasMatch?.groups.exported === "routes") {
      return aliasMatch.groups.local;
    }

    if (part === "routes") {
      return "routes";
    }
  }

  return "";
}

function findLocalRoutesDeclaration(source, maskedSource, localName, beforeIndex) {
  const declarationPattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(localName)}\\s*=`, "gu");
  let declaration = null;

  for (const match of maskedSource.matchAll(declarationPattern)) {
    if (match.index > beforeIndex) {
      break;
    }

    declaration = extractAssignedLiteral(source, match.index + match[0].length);
  }

  return declaration ?? "";
}

function maskNonCode(source) {
  const output = Array.from(source);
  const maskRange = (start, end, preserve = new Set()) => {
    for (let index = start; index < end; index += 1) {
      if (source[index] !== "\n" && !preserve.has(index)) {
        output[index] = " ";
      }
    }
  };

  const scanCode = (startIndex, stopCharacter = "") => {
    for (let index = startIndex; index < source.length; index += 1) {
      const character = source[index];
      const next = source[index + 1];

      if (stopCharacter && character === stopCharacter) {
        return index;
      }

      if (character === "/" && next === "/") {
        const end = skipLineComment(source, index);
        maskRange(index, end + 1);
        index = end;
        continue;
      }

      if (character === "/" && next === "*") {
        const end = skipBlockComment(source, index);
        maskRange(index, end + 1);
        index = end;
        continue;
      }

      if (character === "\"" || character === "'") {
        const end = skipStringLike(source, index, character);
        maskRange(index, end + 1, new Set([index, end]));
        index = end;
        continue;
      }

      if (character === "`") {
        index = maskTemplateLiteral(source, output, index, scanCode);
      }
    }

    return source.length;
  };

  scanCode(0);
  return output.join("");
}

function maskTemplateLiteral(source, output, startIndex, scanCode) {
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "\\") {
      if (source[index] !== "\n") output[index] = " ";
      if (next && next !== "\n") output[index + 1] = " ";
      index += 1;
      continue;
    }

    if (character === "`") {
      return index;
    }

    if (character === "$" && next === "{") {
      const expressionEnd = scanCode(index + 2, "}");
      index = expressionEnd;
      continue;
    }

    if (character !== "\n") {
      output[index] = " ";
    }
  }

  return source.length - 1;
}

function skipStringLike(source, startIndex, quote) {
  for (let index = startIndex + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }

    if (source[index] === quote) {
      return index;
    }
  }

  return source.length - 1;
}

function skipLineComment(source, startIndex) {
  const end = source.indexOf("\n", startIndex + 2);
  return end === -1 ? source.length - 1 : end - 1;
}

function skipBlockComment(source, startIndex) {
  const end = source.indexOf("*/", startIndex + 2);
  return end === -1 ? source.length - 1 : end + 1;
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
