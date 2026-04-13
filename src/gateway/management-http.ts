import type { IncomingMessage, ServerResponse } from "node:http";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { GatewayClient } from "./client.js";
import {
  readJsonBodyOrError,
  sendJson,
  setSseHeaders,
  watchClientDisconnect,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  getBearerToken,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import {
  handleOAuthCallback,
  handleOAuthProvidersList,
  handleOAuthStart,
} from "./oauth-proxy.js";
import {
  authorizeOperatorScopesForMethod,
  resolveRequiredOperatorScopeForMethod,
} from "./method-scopes.js";
import type { HostManagerLifecycleAdapter } from "./management-host.js";

const MANAGEMENT_API_PREFIX = "/v1/management";
const MANAGEMENT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;

type GatewayInvokeResult = {
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

export type GatewayManagementMethodInvoker = (params: {
  method: string;
  params?: Record<string, unknown>;
  scopes: string[];
  req: IncomingMessage;
}) => Promise<GatewayInvokeResult>;

type ManagementGatewayRoute = {
  kind: "gateway";
  id: string;
  method: "GET" | "POST";
  path: string;
  gatewayMethod: string;
  body: "none" | "optional" | "required";
  scopeMethod?: string;
};

type ManagementHostRoute = {
  kind: "host";
  id: string;
  method: "GET" | "POST";
  path: string;
  hostAction: keyof HostManagerLifecycleAdapter;
  body: "none" | "optional";
  scopeMethod: string;
};

type ManagementRoute = ManagementGatewayRoute | ManagementHostRoute;

type RouteResult = {
  routeId: string;
  path: string;
  method: string;
  gatewayMethod?: string;
  scope: string;
};

const MANAGEMENT_GATEWAY_ROUTES: readonly ManagementGatewayRoute[] = [
  { kind: "gateway", id: "health", method: "GET", path: "/v1/management/health", gatewayMethod: "health", body: "none" },
  { kind: "gateway", id: "status", method: "GET", path: "/v1/management/status", gatewayMethod: "status", body: "none" },
  { kind: "gateway", id: "identity", method: "GET", path: "/v1/management/identity", gatewayMethod: "gateway.identity.get", body: "none" },
  { kind: "gateway", id: "version", method: "GET", path: "/v1/management/version", gatewayMethod: "status", body: "none" },
  { kind: "gateway", id: "logs-tail", method: "POST", path: "/v1/management/logs/tail", gatewayMethod: "logs.tail", body: "optional" },
  { kind: "gateway", id: "usage-status", method: "GET", path: "/v1/management/usage/status", gatewayMethod: "usage.status", body: "none" },
  { kind: "gateway", id: "usage-cost", method: "POST", path: "/v1/management/usage/cost", gatewayMethod: "usage.cost", body: "optional" },
  { kind: "gateway", id: "config-get", method: "GET", path: "/v1/management/config/get", gatewayMethod: "config.get", body: "none" },
  { kind: "gateway", id: "credentials", method: "GET", path: "/v1/management/credentials", gatewayMethod: "config.get", body: "none", scopeMethod: "config.get" },
  { kind: "gateway", id: "config-schema", method: "GET", path: "/v1/management/config/schema", gatewayMethod: "config.schema", body: "none" },
  { kind: "gateway", id: "config-schema-lookup", method: "POST", path: "/v1/management/config/schema/lookup", gatewayMethod: "config.schema.lookup", body: "required" },
  { kind: "gateway", id: "config-patch", method: "POST", path: "/v1/management/config/patch", gatewayMethod: "config.patch", body: "required" },
  { kind: "gateway", id: "config-apply", method: "POST", path: "/v1/management/config/apply", gatewayMethod: "config.apply", body: "required" },
  { kind: "gateway", id: "providers-models", method: "GET", path: "/v1/management/providers/models", gatewayMethod: "models.list", body: "none" },
  { kind: "gateway", id: "providers-auth-test", method: "POST", path: "/v1/management/providers/auth-test", gatewayMethod: "models.list", body: "optional", scopeMethod: "health" },
  { kind: "gateway", id: "agents-list", method: "GET", path: "/v1/management/agents/list", gatewayMethod: "agents.list", body: "none" },
  { kind: "gateway", id: "agents-create", method: "POST", path: "/v1/management/agents/create", gatewayMethod: "agents.create", body: "required" },
  { kind: "gateway", id: "agents-update", method: "POST", path: "/v1/management/agents/update", gatewayMethod: "agents.update", body: "required" },
  { kind: "gateway", id: "agents-delete", method: "POST", path: "/v1/management/agents/delete", gatewayMethod: "agents.delete", body: "required" },
  { kind: "gateway", id: "sessions-list", method: "GET", path: "/v1/management/sessions/list", gatewayMethod: "sessions.list", body: "none" },
  { kind: "gateway", id: "sessions-create", method: "POST", path: "/v1/management/sessions/create", gatewayMethod: "sessions.create", body: "optional" },
  { kind: "gateway", id: "sessions-send", method: "POST", path: "/v1/management/sessions/send", gatewayMethod: "sessions.send", body: "required" },
  { kind: "gateway", id: "sessions-abort", method: "POST", path: "/v1/management/sessions/abort", gatewayMethod: "sessions.abort", body: "required" },
  { kind: "gateway", id: "sessions-delete", method: "POST", path: "/v1/management/sessions/delete", gatewayMethod: "sessions.delete", body: "required" },
  { kind: "gateway", id: "tools-catalog", method: "GET", path: "/v1/management/tools/catalog", gatewayMethod: "tools.catalog", body: "none" },
  { kind: "gateway", id: "tools-effective", method: "GET", path: "/v1/management/tools/effective", gatewayMethod: "tools.effective", body: "none" },
  { kind: "gateway", id: "tools-update", method: "POST", path: "/v1/management/tools/update", gatewayMethod: "tools.update", body: "required" },
  { kind: "gateway", id: "clawify-instances-list", method: "GET", path: "/v1/management/clawify/instances/list", gatewayMethod: "clawify.instances.list", body: "none" },
  { kind: "gateway", id: "clawify-instance-get", method: "GET", path: "/v1/management/clawify/instances/get", gatewayMethod: "clawify.instance.get", body: "none" },
  { kind: "gateway", id: "clawify-instance-upsert", method: "POST", path: "/v1/management/clawify/instances/upsert", gatewayMethod: "clawify.instance.upsert", body: "required" },
  { kind: "gateway", id: "clawify-instance-delete", method: "POST", path: "/v1/management/clawify/instances/delete", gatewayMethod: "clawify.instance.delete", body: "required" },
  { kind: "gateway", id: "clawify-user-get", method: "GET", path: "/v1/management/clawify/users/get", gatewayMethod: "clawify.user.get", body: "none" },
  { kind: "gateway", id: "clawify-user-upsert", method: "POST", path: "/v1/management/clawify/users/upsert", gatewayMethod: "clawify.user.upsert", body: "required" },
  { kind: "gateway", id: "clawify-user-delete", method: "POST", path: "/v1/management/clawify/users/delete", gatewayMethod: "clawify.user.delete", body: "required" },
  { kind: "gateway", id: "cron-list", method: "GET", path: "/v1/management/cron/list", gatewayMethod: "cron.list", body: "none" },
  { kind: "gateway", id: "cron-status", method: "GET", path: "/v1/management/cron/status", gatewayMethod: "cron.status", body: "none" },
  { kind: "gateway", id: "cron-add", method: "POST", path: "/v1/management/cron/add", gatewayMethod: "cron.add", body: "required" },
  { kind: "gateway", id: "cron-update", method: "POST", path: "/v1/management/cron/update", gatewayMethod: "cron.update", body: "required" },
  { kind: "gateway", id: "cron-remove", method: "POST", path: "/v1/management/cron/remove", gatewayMethod: "cron.remove", body: "required" },
  { kind: "gateway", id: "cron-run", method: "POST", path: "/v1/management/cron/run", gatewayMethod: "cron.run", body: "required" },
  { kind: "gateway", id: "cron-runs", method: "GET", path: "/v1/management/cron/runs", gatewayMethod: "cron.runs", body: "none" },
  { kind: "gateway", id: "channels-status", method: "GET", path: "/v1/management/channels/status", gatewayMethod: "channels.status", body: "none" },
  { kind: "gateway", id: "channels-logout", method: "POST", path: "/v1/management/channels/logout", gatewayMethod: "channels.logout", body: "required" },
  { kind: "gateway", id: "nodes-list", method: "GET", path: "/v1/management/nodes/list", gatewayMethod: "node.list", body: "none" },
  { kind: "gateway", id: "nodes-describe", method: "POST", path: "/v1/management/nodes/describe", gatewayMethod: "node.describe", body: "required" },
  { kind: "gateway", id: "nodes-invoke", method: "POST", path: "/v1/management/nodes/invoke", gatewayMethod: "node.invoke", body: "required" },
  { kind: "gateway", id: "nodes-pair-list", method: "GET", path: "/v1/management/nodes/pair/list", gatewayMethod: "node.pair.list", body: "none" },
  { kind: "gateway", id: "nodes-pair-approve", method: "POST", path: "/v1/management/nodes/pair/approve", gatewayMethod: "node.pair.approve", body: "required" },
  { kind: "gateway", id: "nodes-pair-reject", method: "POST", path: "/v1/management/nodes/pair/reject", gatewayMethod: "node.pair.reject", body: "required" },
  { kind: "gateway", id: "devices-pair-list", method: "GET", path: "/v1/management/devices/pair/list", gatewayMethod: "device.pair.list", body: "none" },
  { kind: "gateway", id: "devices-pair-approve", method: "POST", path: "/v1/management/devices/pair/approve", gatewayMethod: "device.pair.approve", body: "required" },
  { kind: "gateway", id: "devices-pair-reject", method: "POST", path: "/v1/management/devices/pair/reject", gatewayMethod: "device.pair.reject", body: "required" },
  { kind: "gateway", id: "devices-pair-remove", method: "POST", path: "/v1/management/devices/pair/remove", gatewayMethod: "device.pair.remove", body: "required" },
  { kind: "gateway", id: "skills-status", method: "GET", path: "/v1/management/plugins/skills/status", gatewayMethod: "skills.status", body: "none" },
  { kind: "gateway", id: "skills-search", method: "POST", path: "/v1/management/plugins/skills/search", gatewayMethod: "skills.search", body: "required" },
  { kind: "gateway", id: "skills-detail", method: "POST", path: "/v1/management/plugins/skills/detail", gatewayMethod: "skills.detail", body: "required" },
  { kind: "gateway", id: "skills-install", method: "POST", path: "/v1/management/plugins/skills/install", gatewayMethod: "skills.install", body: "required" },
  { kind: "gateway", id: "skills-update", method: "POST", path: "/v1/management/plugins/skills/update", gatewayMethod: "skills.update", body: "optional" },
  { kind: "gateway", id: "exec-approval-list", method: "GET", path: "/v1/management/approvals/exec/list", gatewayMethod: "exec.approval.list", body: "none" },
  { kind: "gateway", id: "exec-approval-request", method: "POST", path: "/v1/management/approvals/exec/request", gatewayMethod: "exec.approval.request", body: "required" },
  { kind: "gateway", id: "exec-approval-resolve", method: "POST", path: "/v1/management/approvals/exec/resolve", gatewayMethod: "exec.approval.resolve", body: "required" },
  { kind: "gateway", id: "plugin-approval-list", method: "GET", path: "/v1/management/approvals/plugin/list", gatewayMethod: "plugin.approval.list", body: "none" },
  { kind: "gateway", id: "plugin-approval-request", method: "POST", path: "/v1/management/approvals/plugin/request", gatewayMethod: "plugin.approval.request", body: "required" },
  { kind: "gateway", id: "plugin-approval-resolve", method: "POST", path: "/v1/management/approvals/plugin/resolve", gatewayMethod: "plugin.approval.resolve", body: "required" },
  { kind: "gateway", id: "update-run", method: "POST", path: "/v1/management/updates/run", gatewayMethod: "update.run", body: "optional" },
];

const MANAGEMENT_HOST_ROUTES: readonly ManagementHostRoute[] = [
  { kind: "host", id: "host-status", method: "GET", path: "/v1/management/host/status", hostAction: "status", body: "none", scopeMethod: "health" },
  { kind: "host", id: "host-probe", method: "GET", path: "/v1/management/host/probe", hostAction: "probe", body: "none", scopeMethod: "health" },
  { kind: "host", id: "host-install", method: "POST", path: "/v1/management/host/install", hostAction: "install", body: "optional", scopeMethod: "config.apply" },
  { kind: "host", id: "host-start", method: "POST", path: "/v1/management/host/start", hostAction: "start", body: "optional", scopeMethod: "config.apply" },
  { kind: "host", id: "host-stop", method: "POST", path: "/v1/management/host/stop", hostAction: "stop", body: "optional", scopeMethod: "config.apply" },
  { kind: "host", id: "host-restart", method: "POST", path: "/v1/management/host/restart", hostAction: "restart", body: "optional", scopeMethod: "config.apply" },
  { kind: "host", id: "host-uninstall", method: "POST", path: "/v1/management/host/uninstall", hostAction: "uninstall", body: "optional", scopeMethod: "config.apply" },
];

const MANAGEMENT_ROUTES: readonly ManagementRoute[] = [
  ...MANAGEMENT_GATEWAY_ROUTES,
  ...MANAGEMENT_HOST_ROUTES,
];

function normalizeRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`).pathname;
}

function routeScopeLabel(method: string): string {
  return resolveRequiredOperatorScopeForMethod(method) ?? "operator.admin";
}

function routeResultFromGatewayRoute(route: ManagementGatewayRoute): RouteResult {
  const scopeMethod = route.scopeMethod ?? route.gatewayMethod;
  return {
    routeId: route.id,
    path: route.path,
    method: route.method,
    gatewayMethod: route.gatewayMethod,
    scope: routeScopeLabel(scopeMethod),
  };
}

function routeResultFromHostRoute(route: ManagementHostRoute): RouteResult {
  return {
    routeId: route.id,
    path: route.path,
    method: route.method,
    scope: routeScopeLabel(route.scopeMethod),
  };
}

function sendManagementResult(res: ServerResponse, status: number, route: RouteResult, result: unknown) {
  sendJson(res, status, {
    ok: true,
    result,
    route,
  });
}

function sendManagementError(
  res: ServerResponse,
  status: number,
  route: RouteResult,
  code: string,
  message: string,
  details?: unknown,
) {
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      details,
    },
    route,
  });
}

function collectQueryParams(req: IncomingMessage): Record<string, unknown> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = params[key];
    if (existing === undefined) {
      params[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    params[key] = [existing, value];
  }
  return params;
}

type CredentialStatusRecord = {
  key: string;
  configured: boolean;
  source: string;
  lastValidatedAt: null;
  status: "configured";
  errors: string[];
};

function isSecretRefShape(value: unknown): value is { source: string; provider?: string; id?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { source?: unknown; provider?: unknown };
  return typeof candidate.source === "string" && (candidate.provider === undefined || typeof candidate.provider === "string");
}

function collectCredentialStatuses(
  value: unknown,
  path: string,
  result: CredentialStatusRecord[],
): void {
  if (value === REDACTED_SENTINEL) {
    result.push({
      key: path || "<root>",
      configured: true,
      source: "config",
      lastValidatedAt: null,
      status: "configured",
      errors: [],
    });
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\$\{[^}]+\}$/.test(trimmed)) {
      result.push({
        key: path || "<root>",
        configured: true,
        source: "env",
        lastValidatedAt: null,
        status: "configured",
        errors: [],
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectCredentialStatuses(value[index], `${path}[${index}]`, result);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (isSecretRefShape(value)) {
    const provider = typeof value.provider === "string" ? value.provider : "default";
    result.push({
      key: path || "<root>",
      configured: true,
      source: `${value.source}:${provider}`,
      lastValidatedAt: null,
      status: "configured",
      errors: [],
    });
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    collectCredentialStatuses(nested, path ? `${path}.${key}` : key, result);
  }
}

function dedupeCredentialStatuses(items: CredentialStatusRecord[]): CredentialStatusRecord[] {
  const seen = new Set<string>();
  const unique: CredentialStatusRecord[] = [];
  for (const item of items) {
    const dedupeKey = `${item.key}|${item.source}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    unique.push(item);
  }
  return unique;
}

async function resolveCredentialsSummary(params: {
  invokeGatewayMethod: GatewayManagementMethodInvoker;
  scopes: string[];
  req: IncomingMessage;
}): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; code: string; message: string; details?: unknown }> {
  const configResponse = await params.invokeGatewayMethod({
    method: "config.get",
    params: {},
    scopes: params.scopes,
    req: params.req,
  });
  if (!configResponse.ok) {
    return {
      ok: false,
      status: 502,
      code: configResponse.error?.code ?? "upstream_error",
      message: configResponse.error?.message ?? "failed to load redacted config",
      details: configResponse.error?.details,
    };
  }

  const snapshot =
    configResponse.payload && typeof configResponse.payload === "object"
      ? (configResponse.payload as Record<string, unknown>)
      : {};
  const config = snapshot.config;
  const collected: CredentialStatusRecord[] = [];
  collectCredentialStatuses(config, "", collected);
  const credentials = dedupeCredentialStatuses(collected);
  return {
    ok: true,
    payload: {
      count: credentials.length,
      credentials,
    },
  };
}

function resolveRoute(method: string, path: string): ManagementRoute | null {
  const normalizedMethod = method.toUpperCase();
  for (const route of MANAGEMENT_ROUTES) {
    if (route.path === path && route.method === normalizedMethod) {
      return route;
    }
  }
  return null;
}

function hasAnyRouteForPath(path: string): boolean {
  return MANAGEMENT_ROUTES.some((route) => route.path === path);
}

async function parseRouteBody(
  req: IncomingMessage,
  res: ServerResponse,
  bodyMode: ManagementRoute["body"],
): Promise<Record<string, unknown> | null> {
  if (bodyMode === "none") {
    return {};
  }
  if (
    bodyMode === "optional" &&
    req.headers["content-length"] === undefined &&
    req.headers["transfer-encoding"] === undefined
  ) {
    return {};
  }
  const parsed = await readJsonBodyOrError(req, res, MANAGEMENT_MAX_BODY_BYTES);
  if (parsed === undefined) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (bodyMode === "required") {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: "invalid_request",
          message: "request body must be an object",
        },
      });
      return null;
    }
    return {};
  }
  return parsed as Record<string, unknown>;
}

async function handleManagementEventsSse(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  scopes: string[];
}): Promise<void> {
  const { req, res, auth, scopes } = params;
  const bearer = getBearerToken(req);
  const token = bearer ?? auth.token;
  const password = bearer ?? auth.password;
  if (auth.mode !== "none" && !token && !password) {
    sendJson(res, 503, {
      ok: false,
      error: {
        code: "unavailable",
        message:
          "management event streaming requires shared-secret auth credentials",
      },
    });
    return;
  }

  setSseHeaders(res);
  const abortController = new AbortController();
  const detachDisconnect = watchClientDisconnect(req, res, abortController);
  let finished = false;
  let heartbeat: NodeJS.Timeout | null = null;

  const writeEvent = (event: string, payload: unknown) => {
    if (finished || res.writableEnded) {
      return;
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const stop = () => {
    if (finished) {
      return;
    }
    finished = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    detachDisconnect();
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    client.stop();
    if (!res.writableEnded) {
      res.end();
    }
  };

  const client = new GatewayClient({
    token,
    password,
    role: "operator",
    scopes,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "OpenClaw Management SSE",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    onHelloOk: () => {
      writeEvent("management.ready", {
        connectedAt: new Date().toISOString(),
      });
    },
    onEvent: (evt) => {
      writeEvent(evt.event, {
        seq: evt.seq,
        payload: evt.payload,
      });
    },
    onConnectError: (error) => {
      writeEvent("management.error", { message: String(error) });
      stop();
    },
    onClose: (code, reason) => {
      writeEvent("management.closed", { code, reason });
      stop();
    },
  });

  heartbeat = setInterval(() => {
    writeEvent("management.heartbeat", {
      ts: Date.now(),
    });
  }, SSE_HEARTBEAT_MS);

  writeEvent("management.open", {
    ts: Date.now(),
  });
  client.start();

  await new Promise<void>((resolve) => {
    abortController.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function resolveRouteParams(
  route: ManagementRoute,
  queryParams: Record<string, unknown>,
  bodyParams: Record<string, unknown>,
): Record<string, unknown> {
  if (route.method === "GET") {
    return queryParams;
  }
  if (Object.keys(bodyParams).length > 0) {
    return bodyParams;
  }
  return queryParams;
}

export async function handleManagementHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    invokeGatewayMethod: GatewayManagementMethodInvoker;
    hostLifecycle: HostManagerLifecycleAdapter;
  },
): Promise<boolean> {
  const requestPath = normalizeRequestPath(req);
  if (
    requestPath !== MANAGEMENT_API_PREFIX &&
    requestPath !== `${MANAGEMENT_API_PREFIX}/events` &&
    !requestPath.startsWith(`${MANAGEMENT_API_PREFIX}/`)
  ) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (requestPath === MANAGEMENT_API_PREFIX && method === "GET") {
    sendJson(res, 200, {
      ok: true,
      result: {
        prefix: MANAGEMENT_API_PREFIX,
        routes: MANAGEMENT_ROUTES.map((route) => ({
          id: route.id,
          method: route.method,
          path: route.path,
          ...(route.kind === "gateway" ? { gatewayMethod: route.gatewayMethod } : {}),
        })),
      },
    });
    return true;
  }

  if (requestPath === `${MANAGEMENT_API_PREFIX}/events`) {
    if (method !== "GET") {
      sendJson(res, 405, {
        ok: false,
        error: {
          code: "method_not_allowed",
          message: "method not allowed",
        },
      });
      return true;
    }
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!requestAuth) {
      return true;
    }
    const scopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
    const scopeAuth = authorizeOperatorScopesForMethod("health", scopes);
    if (!scopeAuth.allowed) {
      sendJson(res, 403, {
        ok: false,
        error: {
          code: "forbidden",
          message: `missing scope: ${scopeAuth.missingScope}`,
        },
      });
      return true;
    }
    await handleManagementEventsSse({
      req,
      res,
      auth: opts.auth,
      scopes,
    });
    return true;
  }

  // --- OAuth proxy routes (custom, not gateway-method-backed) ---
  if (requestPath === `${MANAGEMENT_API_PREFIX}/oauth/start` && method === "POST") {
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      req, res, auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!requestAuth) return true;
    await handleOAuthStart(req, res);
    return true;
  }
  if (requestPath === `${MANAGEMENT_API_PREFIX}/oauth/callback` && method === "POST") {
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      req, res, auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!requestAuth) return true;
    await handleOAuthCallback(req, res);
    return true;
  }
  if (requestPath === `${MANAGEMENT_API_PREFIX}/oauth/providers` && method === "GET") {
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      req, res, auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!requestAuth) return true;
    handleOAuthProvidersList(req, res);
    return true;
  }

  const route = resolveRoute(method, requestPath);
  if (!route) {
    if (hasAnyRouteForPath(requestPath)) {
      sendJson(res, 405, {
        ok: false,
        error: {
          code: "method_not_allowed",
          message: "method not allowed",
        },
      });
      return true;
    }
    sendJson(res, 404, {
      ok: false,
      error: {
        code: "not_found",
        message: "management route not found",
      },
    });
    return true;
  }

  const routeResult =
    route.kind === "gateway" ? routeResultFromGatewayRoute(route) : routeResultFromHostRoute(route);

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const scopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const requiredScopeMethod =
    route.kind === "gateway" ? (route.scopeMethod ?? route.gatewayMethod) : route.scopeMethod;
  const scopeAuth = authorizeOperatorScopesForMethod(requiredScopeMethod, scopes);
  if (!scopeAuth.allowed) {
    sendManagementError(
      res,
      403,
      routeResult,
      "forbidden",
      `missing scope: ${scopeAuth.missingScope}`,
      { missingScope: scopeAuth.missingScope },
    );
    return true;
  }

  if (route.path === "/v1/management/credentials") {
    const credentials = await resolveCredentialsSummary({
      invokeGatewayMethod: opts.invokeGatewayMethod,
      scopes,
      req,
    });
    if (!credentials.ok) {
      sendManagementError(
        res,
        credentials.status,
        routeResult,
        credentials.code,
        credentials.message,
        credentials.details,
      );
      return true;
    }
    sendManagementResult(res, 200, routeResult, credentials.payload);
    return true;
  }

  const bodyParams = await parseRouteBody(req, res, route.body);
  if (bodyParams === null) {
    return true;
  }
  const queryParams = collectQueryParams(req);
  const paramsPayload = resolveRouteParams(route, queryParams, bodyParams);

  if (route.kind === "host") {
    try {
      const result = await opts.hostLifecycle[route.hostAction](paramsPayload);
      sendManagementResult(res, 200, routeResult, result);
      return true;
    } catch (error) {
      sendManagementError(
        res,
        500,
        routeResult,
        "host_manager_error",
        String(error),
      );
      return true;
    }
  }

  const gatewayResult = await opts.invokeGatewayMethod({
    method: route.gatewayMethod,
    params: paramsPayload,
    scopes,
    req,
  });
  if (!gatewayResult.ok) {
    sendManagementError(
      res,
      502,
      routeResult,
      gatewayResult.error?.code ?? "upstream_error",
      gatewayResult.error?.message ?? "gateway method failed",
      gatewayResult.error?.details,
    );
    return true;
  }

  sendManagementResult(res, 200, routeResult, gatewayResult.payload);
  return true;
}
