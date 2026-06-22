import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

export function memoryStream() {
  let value = "";
  return {
    write(chunk) {
      value += chunk;
    },
    text() {
      return value;
    }
  };
}

export function stdinFrom(text) {
  return Readable.from([text]);
}

export function ioFor({ statePath, stdin = "" } = {}) {
  return {
    stdin: stdinFrom(stdin),
    stdout: memoryStream(),
    stderr: memoryStream(),
    env: {
      MUDROCK_STATE_PATH: statePath,
      MUDROCK_OWNER_ID: "test-owner"
    }
  };
}

export async function withServer(handler, testFn) {
  const requests = [];
  const id = `mudrock-${randomUUID()}`;
  const transports = globalThis.__MUDROCK_MOCK_TRANSPORTS ?? new Map();
  globalThis.__MUDROCK_MOCK_TRANSPORTS = transports;
  transports.set(id, {
    async handle({ method, path, headers, body }) {
      const req = {
        method,
        url: path,
        headers: {
          host: id,
          ...headers
        }
      };
      const res = createMockResponse();
      requests.push({ method, url: path, headers: req.headers, body });
      await handler(req, res, body);
      return res.result();
    }
  });

  try {
    await testFn({
      baseUrl: `mock://${id}`,
      requests
    });
  } finally {
    transports.delete(id);
  }
}

export function json(res, statusCode, value) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export function text(res, statusCode, value) {
  res.writeHead(statusCode, { "content-type": "text/plain" });
  res.end(value);
}

function createMockResponse() {
  let statusCode = 200;
  let headers = {};
  let body = "";

  return {
    writeHead(nextStatusCode, nextHeaders = {}) {
      statusCode = nextStatusCode;
      headers = nextHeaders;
    },
    end(value = "") {
      body += value;
    },
    result() {
      return { statusCode, headers, body };
    }
  };
}
