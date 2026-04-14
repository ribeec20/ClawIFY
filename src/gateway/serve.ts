import type { GatewayBindMode } from "../config/config.js";
import { defaultGatewayBindMode } from "./net.js";
import {
  type ResolvedServeOptions,
  type ServeOptions,
  resolveServeOptions,
} from "./serve.options.js";

export { DEFAULT_SERVE_PORT, ServeOptionsError } from "./serve.options.js";
export type {
  ServeOptions,
  ServeAuthOptions,
  ServeTailscaleOptions,
} from "./serve.options.js";

export type ProgressEvent =
  | { phase: "loading-modules" }
  | { phase: "starting-server"; port: number; bind: GatewayBindMode }
  | { phase: "ready"; port: number; address: GatewayAddress };

export type GatewayAddress = {
  host: string;
  port: number;
};

export type GatewayHandle = {
  readonly port: number;
  readonly address: GatewayAddress;
  stop(opts?: { reason?: string }): Promise<void>;
};

export type ServeCallOptions = ServeOptions & {
  onProgress?: (event: ProgressEvent) => void;
};

function applyServeDefaults(opts: ServeCallOptions): ServeOptions {
  const withDefaults: ServeOptions = { ...opts };
  if (withDefaults.profile === undefined) {
    withDefaults.profile = "api-only";
  }
  if (withDefaults.managementApiEnabled === undefined) {
    withDefaults.managementApiEnabled = true;
  }
  return withDefaults;
}

function resolvedBindMode(opts: ResolvedServeOptions): GatewayBindMode {
  if (opts.serverOpts.bind !== undefined) {
    return opts.serverOpts.bind;
  }
  const tailscaleMode = opts.serverOpts.tailscale?.mode;
  return defaultGatewayBindMode(tailscaleMode);
}

function resolveAddress(opts: ResolvedServeOptions): GatewayAddress {
  const port = opts.port;
  if (opts.serverOpts.host) {
    return { host: opts.serverOpts.host, port };
  }
  const bind = resolvedBindMode(opts);
  switch (bind) {
    case "loopback":
      return { host: "127.0.0.1", port };
    case "lan":
    case "auto":
      return { host: "0.0.0.0", port };
    case "custom":
    case "tailnet":
      // Real host is resolved internally by the gateway; we don't have access here.
      return { host: "0.0.0.0", port };
  }
}

function emit(onProgress: ((event: ProgressEvent) => void) | undefined, event: ProgressEvent) {
  if (!onProgress) {
    return;
  }
  try {
    onProgress(event);
  } catch {
    // onProgress is fire-and-forget; a throwing callback must not crash startup.
  }
}

export async function serve(opts: ServeCallOptions = {}): Promise<GatewayHandle> {
  const { onProgress, ...rest } = opts;
  const resolved = resolveServeOptions(applyServeDefaults(rest));

  emit(onProgress, { phase: "loading-modules" });
  const { startGatewayServer } = await import("./server.js");

  const bind = resolvedBindMode(resolved);
  emit(onProgress, { phase: "starting-server", port: resolved.port, bind });

  const server = await startGatewayServer(resolved.port, resolved.serverOpts);

  const address = resolveAddress(resolved);
  emit(onProgress, { phase: "ready", port: resolved.port, address });

  let closed = false;
  const handle: GatewayHandle = {
    port: resolved.port,
    address,
    async stop(stopOpts) {
      if (closed) {
        return;
      }
      closed = true;
      await server.close(stopOpts);
    },
  };
  return handle;
}
