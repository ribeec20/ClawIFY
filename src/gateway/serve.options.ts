import type {
  GatewayAuthMode,
  GatewayBindMode,
  GatewayProfileMode,
  GatewayTailscaleMode,
} from "../config/config.js";
import {
  GATEWAY_AUTH_MODES,
  GATEWAY_BIND_MODES,
  GATEWAY_PROFILE_MODES,
  GATEWAY_TAILSCALE_MODES,
} from "../config/config.js";
import type { GatewayServerOptions } from "./server.js";

export const DEFAULT_SERVE_PORT = 18789;

export type ServeAuthOptions = {
  mode?: GatewayAuthMode;
  token?: string;
  password?: string;
};

export type ServeTailscaleOptions = {
  mode?: GatewayTailscaleMode;
  resetOnExit?: boolean;
};

export type ServeOptions = {
  port?: number;
  profile?: GatewayProfileMode;
  bind?: GatewayBindMode;
  host?: string;
  auth?: ServeAuthOptions;
  tailscale?: ServeTailscaleOptions;
  managementApiEnabled?: boolean;
  allowUnconfigured?: boolean;
  startupStartedAt?: number;
};

export type ResolvedServeOptions = {
  port: number;
  serverOpts: GatewayServerOptions;
};

export class ServeOptionsError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ServeOptionsError";
    this.field = field;
  }
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function formatAllowed(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

function validatePort(raw: number | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SERVE_PORT;
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new ServeOptionsError(
      `port must be an integer in 1..65535 (got ${raw})`,
      "port",
    );
  }
  return raw;
}

export function resolveServeOptions(opts: ServeOptions = {}): ResolvedServeOptions {
  const port = validatePort(opts.port);

  if (opts.profile !== undefined && !isMember(opts.profile, GATEWAY_PROFILE_MODES)) {
    throw new ServeOptionsError(
      `profile must be one of ${formatAllowed(GATEWAY_PROFILE_MODES)} (got "${opts.profile}")`,
      "profile",
    );
  }

  if (opts.bind !== undefined && !isMember(opts.bind, GATEWAY_BIND_MODES)) {
    throw new ServeOptionsError(
      `bind must be one of ${formatAllowed(GATEWAY_BIND_MODES)} (got "${opts.bind}")`,
      "bind",
    );
  }

  if (opts.tailscale?.mode !== undefined && !isMember(opts.tailscale.mode, GATEWAY_TAILSCALE_MODES)) {
    throw new ServeOptionsError(
      `tailscale.mode must be one of ${formatAllowed(GATEWAY_TAILSCALE_MODES)} (got "${opts.tailscale.mode}")`,
      "tailscale.mode",
    );
  }

  const auth = opts.auth;
  if (auth?.mode !== undefined && !isMember(auth.mode, GATEWAY_AUTH_MODES)) {
    throw new ServeOptionsError(
      `auth.mode must be one of ${formatAllowed(GATEWAY_AUTH_MODES)} (got "${auth.mode}")`,
      "auth.mode",
    );
  }

  if (auth?.mode === "password" && !(auth.password && auth.password.length > 0)) {
    throw new ServeOptionsError(
      "auth.mode='password' requires a non-empty auth.password",
      "auth.password",
    );
  }

  if (opts.bind !== undefined && opts.bind !== "loopback") {
    const mode = auth?.mode;
    const hasToken = mode === "token" && typeof auth?.token === "string" && auth.token.length > 0;
    const hasPassword =
      mode === "password" && typeof auth?.password === "string" && auth.password.length > 0;
    const isTrustedProxy = mode === "trusted-proxy";
    if (!hasToken && !hasPassword && !isTrustedProxy) {
      throw new ServeOptionsError(
        `bind="${opts.bind}" requires authentication: pass auth.token, auth.password, or auth.mode="trusted-proxy", or set bind="loopback"`,
        "bind",
      );
    }
  }

  const serverOpts: GatewayServerOptions = {};
  if (opts.profile !== undefined) {
    serverOpts.profile = opts.profile;
  }
  if (opts.bind !== undefined) {
    serverOpts.bind = opts.bind;
  }
  if (opts.host !== undefined) {
    serverOpts.host = opts.host;
  }
  if (opts.managementApiEnabled !== undefined) {
    serverOpts.managementApiEnabled = opts.managementApiEnabled;
  }
  if (opts.startupStartedAt !== undefined) {
    serverOpts.startupStartedAt = opts.startupStartedAt;
  }
  if (auth !== undefined) {
    const authOverride: NonNullable<GatewayServerOptions["auth"]> = {};
    if (auth.mode !== undefined) {
      authOverride.mode = auth.mode;
    }
    if (auth.token !== undefined) {
      authOverride.token = auth.token;
    }
    if (auth.password !== undefined) {
      authOverride.password = auth.password;
    }
    if (Object.keys(authOverride).length > 0) {
      serverOpts.auth = authOverride;
    }
  }
  if (opts.tailscale !== undefined) {
    const tsOverride: NonNullable<GatewayServerOptions["tailscale"]> = {};
    if (opts.tailscale.mode !== undefined) {
      tsOverride.mode = opts.tailscale.mode;
    }
    if (opts.tailscale.resetOnExit !== undefined) {
      tsOverride.resetOnExit = opts.tailscale.resetOnExit;
    }
    if (Object.keys(tsOverride).length > 0) {
      serverOpts.tailscale = tsOverride;
    }
  }

  return { port, serverOpts };
}
