import type {
  ClawifyInstanceConfig,
  ClawifyUserConfig,
  ClawifyUserMutationPolicy,
  ClawifyUserPolicyConfig,
} from "../config/types.clawify.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { ToolPolicyConfig, ToolProfileId } from "../config/types.tools.js";

const DEFAULT_MANAGEMENT_BASE_URL = "http://127.0.0.1:18789";
const MANAGEMENT_API_PREFIX = "/v1/management";

type JsonRecord = Record<string, unknown>;

type ManagementRouteInfo = {
  routeId?: string;
};

type ManagementErrorShape = {
  code?: string;
  message?: string;
  details?: unknown;
};

type ManagementEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: ManagementErrorShape;
  route?: ManagementRouteInfo;
};

type SessionCreateResult = {
  key?: string;
  runId?: string;
  messageSeq?: number;
};

type SessionSendResult = {
  runId?: string;
  messageSeq?: number;
  status?: string;
};

type ClawifyInstanceGetResult = {
  instanceId: string;
  config: ClawifyInstanceConfig;
};

type ClawifyUserGetResult = {
  instanceId: string;
  userId: string;
  config: ClawifyUserConfig;
};

type ClawifyMutationResult = {
  ok?: boolean;
  instanceId?: string;
  userId?: string;
};

type SkillsUpdateResult = {
  ok?: boolean;
  skillKey?: string;
  config?: JsonRecord;
};

export type ClawifyClientOptions = {
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  networkRetryAttempts?: number;
  networkRetryBaseDelayMs?: number;
};

export type ClawifyToolsUpdate = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: ToolProfileId;
  byProvider?: Record<string, ToolPolicyConfig>;
};

export type ClawifySkillUpdate = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
};

export type ClawifySessionCreateParams = {
  key?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  task?: string;
  message?: string;
};

export type ClawifySessionSendParams = {
  key: string;
  message: string;
  thinking?: string;
  attachments?: unknown[];
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type ClawifyPromptParams = Omit<ClawifySessionCreateParams, "message"> &
  Omit<ClawifySessionSendParams, "key" | "message"> & {
    sessionKey?: string;
  };

export type ClawifyPromptResult = {
  key: string;
  runId?: string;
  messageSeq?: number;
  status?: string;
};

type ManagementRequestParams = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (normalizeNonEmptyString(value) ?? DEFAULT_MANAGEMENT_BASE_URL).replace(/\/+$/, "");
}

function createErrorMessage(params: {
  status: number;
  method: string;
  path: string;
  envelope: ManagementEnvelope<unknown> | null;
}): string {
  const envelopeMessage = normalizeNonEmptyString(params.envelope?.error?.message);
  if (envelopeMessage) {
    return envelopeMessage;
  }
  return `management request failed (${params.method} ${params.path}, status=${params.status})`;
}

function readErrorCode(envelope: ManagementEnvelope<unknown> | null): string {
  return normalizeNonEmptyString(envelope?.error?.code) ?? "upstream_error";
}

function readErrorDetails(envelope: ManagementEnvelope<unknown> | null): unknown {
  return envelope?.error?.details;
}

function readRouteId(envelope: ManagementEnvelope<unknown> | null): string | undefined {
  return normalizeNonEmptyString(envelope?.route?.routeId);
}

function readTextForErrorPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "";
  }
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function appendQueryParams(url: URL, query: Record<string, unknown> | undefined): void {
  if (!query) {
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function assertNonEmptyString(value: string | undefined, label: string): string {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function toMutationModeFromEnabled(
  enabled: boolean,
  whenEnabled: ClawifyUserMutationPolicy = "allowlist-extend",
): ClawifyUserMutationPolicy {
  return enabled ? whenEnabled : "none";
}

export class ClawifyManagementApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly routeId?: string;
  readonly method: string;
  readonly path: string;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    routeId?: string;
    method: string;
    path: string;
  }) {
    super(params.message);
    this.name = "ClawifyManagementApiError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
    this.routeId = params.routeId;
    this.method = params.method;
    this.path = params.path;
  }
}

class ClawifyManagementHttpClient {
  readonly baseUrl: string;
  readonly token?: string;
  readonly headers: Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly networkRetryAttempts: number;
  readonly networkRetryBaseDelayMs: number;

  constructor(options: ClawifyClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = normalizeNonEmptyString(options.token);
    this.headers = {
      ...(options.headers ?? {}),
    };
    this.networkRetryAttempts =
      typeof options.networkRetryAttempts === "number" &&
      Number.isFinite(options.networkRetryAttempts)
        ? Math.max(1, Math.floor(options.networkRetryAttempts))
        : 4;
    this.networkRetryBaseDelayMs =
      typeof options.networkRetryBaseDelayMs === "number" &&
      Number.isFinite(options.networkRetryBaseDelayMs)
        ? Math.max(1, Math.floor(options.networkRetryBaseDelayMs))
        : 200;
    if (typeof options.fetchImpl === "function") {
      this.fetchImpl = options.fetchImpl;
      return;
    }
    if (typeof globalThis.fetch !== "function") {
      throw new Error(
        "global fetch is not available; pass fetchImpl in ClawifyClientOptions for this runtime",
      );
    }
    this.fetchImpl = globalThis.fetch.bind(globalThis);
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(this.networkRetryBaseDelayMs * attempt, 1_000);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private canRetryNetworkError(error: unknown): boolean {
    const errorRecord =
      error && typeof error === "object" ? (error as { code?: unknown; cause?: unknown }) : {};
    const causeRecord =
      errorRecord.cause && typeof errorRecord.cause === "object"
        ? (errorRecord.cause as { code?: unknown; errno?: unknown; syscall?: unknown })
        : {};
    const code = String(errorRecord.code ?? causeRecord.code ?? causeRecord.errno ?? "");
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ETIMEDOUT"
    ) {
      return true;
    }
    const message = String(error);
    return message.toLowerCase().includes("fetch failed");
  }

  async request<T>(params: ManagementRequestParams): Promise<T> {
    const url = new URL(`${this.baseUrl}${params.path}`);
    appendQueryParams(url, params.query);
    const headers: Record<string, string> = {
      ...this.headers,
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    let body: string | undefined;
    if (params.method === "POST") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(params.body ?? {});
    }
    let response: Response | null = null;
    let lastError: unknown = undefined;
    for (let attempt = 1; attempt <= this.networkRetryAttempts; attempt += 1) {
      try {
        response = await this.fetchImpl(url.toString(), {
          method: params.method,
          headers,
          body,
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= this.networkRetryAttempts || !this.canRetryNetworkError(error)) {
          throw error;
        }
        await this.waitBeforeRetry(attempt);
      }
    }
    if (!response) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    const rawText = await response.text();
    let parsedPayload: unknown = undefined;
    if (rawText.trim().length > 0) {
      try {
        parsedPayload = JSON.parse(rawText);
      } catch {
        parsedPayload = rawText;
      }
    }
    const envelope = isRecord(parsedPayload)
      ? (parsedPayload as ManagementEnvelope<unknown>)
      : null;
    if (response.status !== 200 || envelope?.ok !== true) {
      throw new ClawifyManagementApiError({
        status: response.status,
        code: readErrorCode(envelope),
        message:
          envelope === null
            ? `management request failed (${params.method} ${params.path}, status=${
                response.status
              }, body=${readTextForErrorPayload(parsedPayload)})`
            : createErrorMessage({
                status: response.status,
                method: params.method,
                path: params.path,
                envelope,
              }),
        details: readErrorDetails(envelope),
        routeId: readRouteId(envelope),
        method: params.method,
        path: params.path,
      });
    }
    return envelope.result as T;
  }

  async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return await this.request<T>({
      method: "GET",
      path: `${MANAGEMENT_API_PREFIX}${path}`,
      query,
    });
  }

  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return await this.request<T>({
      method: "POST",
      path: `${MANAGEMENT_API_PREFIX}${path}`,
      body,
    });
  }
}

function isUnknownInstanceError(error: unknown): boolean {
  return (
    error instanceof ClawifyManagementApiError &&
    error.code === "invalid_request" &&
    error.message.toLowerCase().includes("unknown clawify instance")
  );
}

function isUnknownUserError(error: unknown): boolean {
  return (
    error instanceof ClawifyManagementApiError &&
    error.code === "invalid_request" &&
    error.message.toLowerCase().includes("unknown clawify user")
  );
}

function nextMcpServers(params: {
  current: Record<string, McpServerConfig>;
  serverName: string;
  serverConfig: McpServerConfig;
}): Record<string, McpServerConfig> {
  return {
    ...params.current,
    [params.serverName]: {
      ...(params.current[params.serverName] ?? {}),
      ...params.serverConfig,
    },
  };
}

export class ClawifyInstanceClient {
  private readonly http: ClawifyManagementHttpClient;
  readonly instanceId: string;

  constructor(params: { http: ClawifyManagementHttpClient; instanceId: string }) {
    this.http = params.http;
    this.instanceId = assertNonEmptyString(params.instanceId, "instanceId");
  }

  user(userId: string): ClawifyUserClient {
    return new ClawifyUserClient({
      http: this.http,
      instanceId: this.instanceId,
      userId,
    });
  }

  async get(): Promise<ClawifyInstanceGetResult> {
    return await this.http.get<ClawifyInstanceGetResult>("/clawify/instances/get", {
      instanceId: this.instanceId,
    });
  }

  async getConfig(): Promise<ClawifyInstanceConfig> {
    return (await this.get()).config ?? {};
  }

  async upsert(config: ClawifyInstanceConfig): Promise<ClawifyMutationResult> {
    return await this.http.post<ClawifyMutationResult>("/clawify/instances/upsert", {
      instanceId: this.instanceId,
      config,
    });
  }

  async delete(): Promise<ClawifyMutationResult> {
    return await this.http.post<ClawifyMutationResult>("/clawify/instances/delete", {
      instanceId: this.instanceId,
    });
  }

  private async readConfigOrEmpty(): Promise<ClawifyInstanceConfig> {
    try {
      return await this.getConfig();
    } catch (error) {
      if (!isUnknownInstanceError(error)) {
        throw error;
      }
      return {};
    }
  }

  async setUserMutationPolicy(
    policy: Partial<ClawifyUserPolicyConfig>,
  ): Promise<ClawifyMutationResult> {
    const current = await this.readConfigOrEmpty();
    return await this.upsert({
      ...current,
      userPolicy: {
        ...(current.userPolicy ?? {}),
        ...policy,
      },
    });
  }

  async setUserToolsEnabled(enabled: boolean): Promise<ClawifyMutationResult> {
    return await this.setUserMutationPolicy({
      tools: toMutationModeFromEnabled(enabled, "allowlist-extend"),
    });
  }

  async setUserSkillsEnabled(enabled: boolean): Promise<ClawifyMutationResult> {
    return await this.setUserMutationPolicy({
      skills: toMutationModeFromEnabled(enabled, "allowlist-extend"),
    });
  }

  async setUserMcpEnabled(enabled: boolean): Promise<ClawifyMutationResult> {
    return await this.setUserMutationPolicy({
      mcp: toMutationModeFromEnabled(enabled, "allowlist-extend"),
    });
  }

  async updateTools(update: ClawifyToolsUpdate): Promise<JsonRecord> {
    return await this.http.post<JsonRecord>("/tools/update", {
      instanceId: this.instanceId,
      ...update,
    });
  }

  async allowTools(toolIds: string[]): Promise<JsonRecord> {
    return await this.updateTools({
      alsoAllow: toolIds,
    });
  }

  async denyTools(toolIds: string[]): Promise<JsonRecord> {
    return await this.updateTools({
      deny: toolIds,
    });
  }

  async updateSkill(skillKey: string, update: ClawifySkillUpdate): Promise<SkillsUpdateResult> {
    return await this.http.post<SkillsUpdateResult>("/plugins/skills/update", {
      instanceId: this.instanceId,
      skillKey: assertNonEmptyString(skillKey, "skillKey"),
      ...update,
    });
  }

  async setMcpServer(
    serverName: string,
    serverConfig: McpServerConfig,
  ): Promise<ClawifyMutationResult> {
    const normalizedServerName = assertNonEmptyString(serverName, "serverName");
    const current = await this.readConfigOrEmpty();
    return await this.upsert({
      ...current,
      mcp: {
        ...(current.mcp ?? {}),
        servers: nextMcpServers({
          current: { ...(current.mcp?.servers ?? {}) },
          serverName: normalizedServerName,
          serverConfig,
        }),
      },
    });
  }

  async removeMcpServer(serverName: string): Promise<ClawifyMutationResult> {
    const normalizedServerName = assertNonEmptyString(serverName, "serverName");
    const current = await this.readConfigOrEmpty();
    const nextServers = {
      ...(current.mcp?.servers ?? {}),
    };
    delete nextServers[normalizedServerName];
    return await this.upsert({
      ...current,
      mcp:
        Object.keys(nextServers).length > 0
          ? {
              ...(current.mcp ?? {}),
              servers: nextServers,
            }
          : undefined,
    });
  }

  async createSession(params: ClawifySessionCreateParams = {}): Promise<SessionCreateResult> {
    return await this.http.post<SessionCreateResult>("/sessions/create", {
      ...params,
      instanceId: this.instanceId,
    });
  }

  async send(params: ClawifySessionSendParams): Promise<SessionSendResult> {
    return await this.http.post<SessionSendResult>("/sessions/send", {
      ...params,
      instanceId: this.instanceId,
    });
  }

  async prompt(message: string, params: ClawifyPromptParams = {}): Promise<ClawifyPromptResult> {
    const normalizedMessage = assertNonEmptyString(message, "message");
    const sessionKey =
      normalizeNonEmptyString(params.sessionKey) ??
      assertNonEmptyString(
        (await this.createSession({
          key: params.key,
          agentId: params.agentId,
          label: params.label,
          model: params.model,
          parentSessionKey: params.parentSessionKey,
          task: params.task,
        })).key,
        "sessions.create result.key",
      );
    const sendResult = await this.send({
      key: sessionKey,
      message: normalizedMessage,
      thinking: params.thinking,
      attachments: params.attachments,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      key: sessionKey,
      runId: normalizeNonEmptyString(sendResult.runId),
      messageSeq:
        typeof sendResult.messageSeq === "number" && Number.isFinite(sendResult.messageSeq)
          ? sendResult.messageSeq
          : undefined,
      status: normalizeNonEmptyString(sendResult.status),
    };
  }
}

export class ClawifyUserClient {
  private readonly http: ClawifyManagementHttpClient;
  readonly instanceId: string;
  readonly userId: string;

  constructor(params: { http: ClawifyManagementHttpClient; instanceId: string; userId: string }) {
    this.http = params.http;
    this.instanceId = assertNonEmptyString(params.instanceId, "instanceId");
    this.userId = assertNonEmptyString(params.userId, "userId");
  }

  async get(): Promise<ClawifyUserGetResult> {
    return await this.http.get<ClawifyUserGetResult>("/clawify/users/get", {
      instanceId: this.instanceId,
      userId: this.userId,
    });
  }

  async getConfig(): Promise<ClawifyUserConfig> {
    return (await this.get()).config ?? {};
  }

  async upsert(config: ClawifyUserConfig): Promise<ClawifyMutationResult> {
    return await this.http.post<ClawifyMutationResult>("/clawify/users/upsert", {
      instanceId: this.instanceId,
      userId: this.userId,
      config,
    });
  }

  async delete(): Promise<ClawifyMutationResult> {
    return await this.http.post<ClawifyMutationResult>("/clawify/users/delete", {
      instanceId: this.instanceId,
      userId: this.userId,
    });
  }

  private async readConfigOrEmpty(): Promise<ClawifyUserConfig> {
    try {
      return await this.getConfig();
    } catch (error) {
      if (!isUnknownUserError(error)) {
        throw error;
      }
      return {};
    }
  }

  async updateTools(update: ClawifyToolsUpdate): Promise<JsonRecord> {
    return await this.http.post<JsonRecord>("/tools/update", {
      instanceId: this.instanceId,
      userId: this.userId,
      ...update,
    });
  }

  async allowTools(toolIds: string[]): Promise<JsonRecord> {
    return await this.updateTools({
      alsoAllow: toolIds,
    });
  }

  async denyTools(toolIds: string[]): Promise<JsonRecord> {
    return await this.updateTools({
      deny: toolIds,
    });
  }

  async updateSkill(skillKey: string, update: ClawifySkillUpdate): Promise<SkillsUpdateResult> {
    return await this.http.post<SkillsUpdateResult>("/plugins/skills/update", {
      instanceId: this.instanceId,
      userId: this.userId,
      skillKey: assertNonEmptyString(skillKey, "skillKey"),
      ...update,
    });
  }

  async setMcpServer(
    serverName: string,
    serverConfig: McpServerConfig,
  ): Promise<ClawifyMutationResult> {
    const normalizedServerName = assertNonEmptyString(serverName, "serverName");
    const current = await this.readConfigOrEmpty();
    return await this.upsert({
      ...current,
      mcp: {
        ...(current.mcp ?? {}),
        servers: nextMcpServers({
          current: { ...(current.mcp?.servers ?? {}) },
          serverName: normalizedServerName,
          serverConfig,
        }),
      },
    });
  }

  async removeMcpServer(serverName: string): Promise<ClawifyMutationResult> {
    const normalizedServerName = assertNonEmptyString(serverName, "serverName");
    const current = await this.readConfigOrEmpty();
    const nextServers = {
      ...(current.mcp?.servers ?? {}),
    };
    delete nextServers[normalizedServerName];
    return await this.upsert({
      ...current,
      mcp:
        Object.keys(nextServers).length > 0
          ? {
              ...(current.mcp ?? {}),
              servers: nextServers,
            }
          : undefined,
    });
  }

  async createSession(params: ClawifySessionCreateParams = {}): Promise<SessionCreateResult> {
    return await this.http.post<SessionCreateResult>("/sessions/create", {
      ...params,
      instanceId: this.instanceId,
      userId: this.userId,
    });
  }

  async send(params: ClawifySessionSendParams): Promise<SessionSendResult> {
    return await this.http.post<SessionSendResult>("/sessions/send", {
      ...params,
      instanceId: this.instanceId,
      userId: this.userId,
    });
  }

  async prompt(message: string, params: ClawifyPromptParams = {}): Promise<ClawifyPromptResult> {
    const normalizedMessage = assertNonEmptyString(message, "message");
    const sessionKey =
      normalizeNonEmptyString(params.sessionKey) ??
      assertNonEmptyString(
        (await this.createSession({
          key: params.key,
          agentId: params.agentId,
          label: params.label,
          model: params.model,
          parentSessionKey: params.parentSessionKey,
          task: params.task,
        })).key,
        "sessions.create result.key",
      );
    const sendResult = await this.send({
      key: sessionKey,
      message: normalizedMessage,
      thinking: params.thinking,
      attachments: params.attachments,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.idempotencyKey,
    });
    return {
      key: sessionKey,
      runId: normalizeNonEmptyString(sendResult.runId),
      messageSeq:
        typeof sendResult.messageSeq === "number" && Number.isFinite(sendResult.messageSeq)
          ? sendResult.messageSeq
          : undefined,
      status: normalizeNonEmptyString(sendResult.status),
    };
  }
}

export class ClawifyClient {
  private readonly http: ClawifyManagementHttpClient;

  constructor(options: ClawifyClientOptions = {}) {
    this.http = new ClawifyManagementHttpClient(options);
  }

  instance(instanceId: string): ClawifyInstanceClient {
    return new ClawifyInstanceClient({
      http: this.http,
      instanceId,
    });
  }

  user(instanceId: string, userId: string): ClawifyUserClient {
    return this.instance(instanceId).user(userId);
  }

  async listInstances(): Promise<{ defaultInstanceId?: string; instances: Array<{ id: string }> }> {
    return await this.http.get<{ defaultInstanceId?: string; instances: Array<{ id: string }> }>(
      "/clawify/instances/list",
    );
  }
}

export function createClawify(options: ClawifyClientOptions = {}): ClawifyClient {
  return new ClawifyClient(options);
}

export const clawify = {
  create: createClawify,
  instance(instanceId: string, options?: ClawifyClientOptions): ClawifyInstanceClient {
    return createClawify(options).instance(instanceId);
  },
  user(instanceId: string, userId: string, options?: ClawifyClientOptions): ClawifyUserClient {
    return createClawify(options).user(instanceId, userId);
  },
};
