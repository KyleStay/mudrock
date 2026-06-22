import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

const mudrockStorage = new AsyncLocalStorage();
const proxyStateSymbol = Symbol.for("mudrock.localInvocation.proxyState");

export class LocalInvocationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Invocation exceeded max_wall_ms_per_request (${timeoutMs} ms).`);
    this.name = "LocalInvocationTimeoutError";
    this.code = "MUDROCK_INVOCATION_TIMEOUT";
    this.timeout_ms = timeoutMs;
  }
}

export async function importLocalBundle(bundleText, { namespace, buildId, deploymentId } = {}) {
  const salt = encodeURIComponent([namespace, buildId, deploymentId].filter(Boolean).join(":"));
  const encoded = Buffer.from(bundleText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#mudrock=${salt}`);
}

export async function runWithMudrockRuntime(runtime, task, { timeoutMs } = {}) {
  const state = installMudrockProxy();
  state.active += 1;

  try {
    const invocation = mudrockStorage.run(runtime, task);
    return await withTimeout(invocation, timeoutMs);
  } finally {
    state.active -= 1;
    if (state.active === 0) {
      restoreMudrockGlobal(state);
    }
  }
}

function withTimeout(invocation, timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return invocation;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Invocation timeout must be a positive integer.");
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LocalInvocationTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([invocation, timeout])
    .finally(() => clearTimeout(timer));
}

function installMudrockProxy() {
  const existing = globalThis[proxyStateSymbol];
  if (existing) {
    globalThis.Mudrock = existing.proxy;
    return existing;
  }

  const state = {
    active: 0,
    hadPrevious: Object.hasOwn(globalThis, "Mudrock"),
    previous: globalThis.Mudrock,
    proxy: createMudrockProxy()
  };
  globalThis[proxyStateSymbol] = state;
  globalThis.Mudrock = state.proxy;
  return state;
}

function restoreMudrockGlobal(state) {
  if (state.hadPrevious) {
    globalThis.Mudrock = state.previous;
  } else {
    delete globalThis.Mudrock;
  }
  delete globalThis[proxyStateSymbol];
}

function createMudrockProxy() {
  return new Proxy(Object.freeze({}), {
    get(_target, property) {
      const runtime = currentMudrockRuntime();
      const value = runtime[property];
      return typeof value === "function" ? value.bind(runtime) : value;
    },
    has(_target, property) {
      return property in currentMudrockRuntime();
    },
    ownKeys() {
      return Reflect.ownKeys(currentMudrockRuntime());
    },
    getOwnPropertyDescriptor(_target, property) {
      const runtime = currentMudrockRuntime();
      const descriptor = Object.getOwnPropertyDescriptor(runtime, property);
      return descriptor && { ...descriptor, configurable: true };
    },
    set() {
      return false;
    },
    deleteProperty() {
      return false;
    }
  });
}

function currentMudrockRuntime() {
  const runtime = mudrockStorage.getStore();
  if (!runtime) {
    throw new ReferenceError("Mudrock runtime is only available during local invocation.");
  }
  return runtime;
}
