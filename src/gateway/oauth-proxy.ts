import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";

// ---------------------------------------------------------------------------
// Pending OAuth state store (in-memory, TTL-based)
// ---------------------------------------------------------------------------

type PendingOAuthEntry = {
  provider: string;
  verifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  userinfoUrl?: string;
  profileId?: string;
  createdAt: number;
};

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_ENTRIES = 100;
const pendingOAuthStates = new Map<string, PendingOAuthEntry>();

function purgeStalePendingEntries(): void {
  const now = Date.now();
  for (const [state, entry] of pendingOAuthStates) {
    if (now - entry.createdAt > PENDING_TTL_MS) {
      pendingOAuthStates.delete(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider registry — describes how to build OAuth URLs per provider
// ---------------------------------------------------------------------------

export type OAuthProviderConfig = {
  /** Unique provider identifier (e.g., "google-gemini", "chutes"). */
  provider: string;
  /** OAuth authorization endpoint. */
  authorizeUrl: string;
  /** OAuth token exchange endpoint. */
  tokenUrl: string;
  /** Client ID (can come from config/env). */
  clientId: string;
  /** Client secret (optional, for confidential clients). */
  clientSecret?: string;
  /** Scopes to request. */
  scopes: string[];
  /** Redirect URI the frontend will handle. */
  redirectUri: string;
  /** Userinfo endpoint for identity resolution (optional). */
  userinfoUrl?: string;
  /** Default auth profile ID prefix. */
  profilePrefix?: string;
};

/**
 * Registered OAuth providers. Plugins/extensions can register at startup.
 * Alternatively, providers can be configured via settings.
 */
const oauthProviderRegistry = new Map<string, OAuthProviderConfig>();

export function registerOAuthProvider(config: OAuthProviderConfig): void {
  oauthProviderRegistry.set(config.provider, config);
}

export function unregisterOAuthProvider(provider: string): void {
  oauthProviderRegistry.delete(provider);
}

export function getRegisteredOAuthProviders(): string[] {
  return [...oauthProviderRegistry.keys()];
}

/**
 * Resolve provider config from registry, or from an inline config in the
 * request body (for dynamic/ad-hoc providers not pre-registered).
 */
function resolveProviderConfig(
  provider: string,
  inline?: Partial<OAuthProviderConfig>,
): OAuthProviderConfig | null {
  const registered = oauthProviderRegistry.get(provider);
  if (registered) {
    // Allow the request to override redirectUri (frontend may differ per deployment).
    return inline?.redirectUri ? { ...registered, redirectUri: inline.redirectUri } : registered;
  }
  // Ad-hoc provider: all required fields must be supplied inline.
  if (
    inline &&
    inline.authorizeUrl &&
    inline.tokenUrl &&
    inline.clientId &&
    inline.redirectUri &&
    inline.scopes &&
    inline.scopes.length > 0
  ) {
    return {
      provider,
      authorizeUrl: inline.authorizeUrl,
      tokenUrl: inline.tokenUrl,
      clientId: inline.clientId,
      clientSecret: inline.clientSecret,
      scopes: inline.scopes,
      redirectUri: inline.redirectUri,
      userinfoUrl: inline.userinfoUrl,
      profilePrefix: inline.profilePrefix,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// POST /v1/management/oauth/start
// ---------------------------------------------------------------------------

export async function handleOAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBodyOrError(req, res, 64 * 1024);
  if (body === undefined) return;

  const parsed = body as Record<string, unknown>;
  const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
  if (!provider) {
    sendJson(res, 400, {
      ok: false,
      error: { code: "invalid_request", message: "missing required field: provider" },
    });
    return;
  }

  const providerConfig = resolveProviderConfig(provider, parsed as Partial<OAuthProviderConfig>);
  if (!providerConfig) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "unknown_provider",
        message: `OAuth provider "${provider}" is not registered and inline config is incomplete. ` +
          "Required inline fields: authorizeUrl, tokenUrl, clientId, redirectUri, scopes.",
      },
    });
    return;
  }

  // Allow frontend to override redirectUri per-request.
  const redirectUri =
    typeof parsed.redirectUri === "string" && parsed.redirectUri.trim().length > 0
      ? parsed.redirectUri.trim()
      : providerConfig.redirectUri;

  purgeStalePendingEntries();
  if (pendingOAuthStates.size >= MAX_PENDING_ENTRIES) {
    // Force-purge oldest entries if we hit the cap.
    const oldest = [...pendingOAuthStates.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, Math.floor(MAX_PENDING_ENTRIES / 2));
    for (const [key] of oldest) {
      pendingOAuthStates.delete(key);
    }
  }

  const { verifier, challenge } = generatePkce();
  const state = generateState();

  pendingOAuthStates.set(state, {
    provider,
    verifier,
    redirectUri,
    tokenUrl: providerConfig.tokenUrl,
    clientId: providerConfig.clientId,
    clientSecret: providerConfig.clientSecret,
    scopes: providerConfig.scopes,
    userinfoUrl: providerConfig.userinfoUrl,
    profileId: typeof parsed.profileId === "string" ? parsed.profileId : undefined,
    createdAt: Date.now(),
  });

  const authParams = new URLSearchParams({
    client_id: providerConfig.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: providerConfig.scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });

  sendJson(res, 200, {
    ok: true,
    result: {
      authUrl: `${providerConfig.authorizeUrl}?${authParams.toString()}`,
      state,
      provider,
      redirectUri,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /v1/management/oauth/callback
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;

function coerceExpiresAt(expiresInSeconds: number, now: number): number {
  const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1000 - DEFAULT_EXPIRES_BUFFER_MS;
  return Math.max(value, now + 30_000);
}

async function fetchUserinfo(
  url: string,
  accessToken: string,
): Promise<{ email?: string; sub?: string } | null> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    return {
      email: typeof data.email === "string" ? data.email : undefined,
      sub: typeof data.sub === "string" ? data.sub : undefined,
    };
  } catch {
    return null;
  }
}

export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBodyOrError(req, res, 64 * 1024);
  if (body === undefined) return;

  const parsed = body as Record<string, unknown>;
  const state = typeof parsed.state === "string" ? parsed.state.trim() : "";
  const code = typeof parsed.code === "string" ? parsed.code.trim() : "";

  if (!state || !code) {
    sendJson(res, 400, {
      ok: false,
      error: { code: "invalid_request", message: "missing required fields: state, code" },
    });
    return;
  }

  purgeStalePendingEntries();
  const pending = pendingOAuthStates.get(state);
  if (!pending) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "invalid_state",
        message: "OAuth state not found or expired. Please restart the OAuth flow.",
      },
    });
    return;
  }

  // One-time use: delete immediately.
  pendingOAuthStates.delete(state);

  // Exchange authorization code for tokens.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: pending.clientId,
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
  });
  if (pending.clientSecret) {
    tokenBody.set("client_secret", pending.clientSecret);
  }

  let tokenData: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  try {
    const tokenResponse = await fetch(pending.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      sendJson(res, 502, {
        ok: false,
        error: {
          code: "token_exchange_failed",
          message: `Token exchange failed: ${errorText}`,
        },
      });
      return;
    }
    tokenData = (await tokenResponse.json()) as typeof tokenData;
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "token_exchange_error",
        message: `Token exchange request failed: ${formatErrorMessage(err)}`,
      },
    });
    return;
  }

  const accessToken = tokenData.access_token?.trim();
  const refreshToken = tokenData.refresh_token?.trim();
  const expiresIn = tokenData.expires_in ?? 0;

  if (!accessToken) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "no_access_token", message: "Token exchange returned no access_token." },
    });
    return;
  }

  // Resolve identity if userinfo URL is configured.
  let email: string | undefined;
  if (pending.userinfoUrl) {
    const info = await fetchUserinfo(pending.userinfoUrl, accessToken);
    email = info?.email;
  }

  // Build credential and persist.
  const now = Date.now();
  const credential: OAuthCredential = {
    type: "oauth",
    provider: pending.provider,
    access: accessToken,
    refresh: refreshToken ?? "",
    expires: coerceExpiresAt(expiresIn, now),
    email,
  };

  const profileId =
    pending.profileId ??
    `${pending.provider}${email ? `-${email.replace(/@/g, "-at-").replace(/[^a-z0-9-]/gi, "-")}` : ""}`;

  try {
    await upsertAuthProfileWithLock({
      profileId,
      credential,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: {
        code: "profile_save_failed",
        message: `Failed to save auth profile: ${formatErrorMessage(err)}`,
      },
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    result: {
      provider: pending.provider,
      profileId,
      email: email ?? null,
      expiresAt: credential.expires,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /v1/management/oauth/providers
// ---------------------------------------------------------------------------

export function handleOAuthProvidersList(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const providers = [...oauthProviderRegistry.entries()].map(([id, config]) => ({
    provider: id,
    authorizeUrl: config.authorizeUrl,
    scopes: config.scopes,
    redirectUri: config.redirectUri,
    userinfoUrl: config.userinfoUrl ?? null,
  }));

  sendJson(res, 200, {
    ok: true,
    result: { providers },
  });
}
