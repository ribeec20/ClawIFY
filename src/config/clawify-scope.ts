import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { McpConfig } from "./types.mcp.js";
import type {
  ClawifyInstanceConfig,
  ClawifyScopedMcpConfig,
  ClawifyScopedSkillsConfig,
  ClawifyScopedToolsConfig,
  ClawifyUserConfig,
  ClawifyUserMutationPolicy,
} from "./types.clawify.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type { SkillConfig } from "./types.skills.js";
import type { ToolPolicyConfig, ToolsConfig } from "./types.tools.js";

export const DEFAULT_CLAWIFY_USER_MUTATION_POLICY: ClawifyUserMutationPolicy = "allowlist-extend";

type ClawifyScope = {
  instanceId?: string;
  userId?: string;
};

function normalizeClawifyId(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function dedupeStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = dedupeStrings(value.filter((entry): entry is string => typeof entry === "string"));
  return normalized;
}

function mergeToolPolicyRecord(params: {
  base: ToolPolicyConfig | undefined;
  overlay: ToolPolicyConfig;
  mode: ClawifyUserMutationPolicy | "replace";
}): ToolPolicyConfig {
  const next: ToolPolicyConfig = {
    ...(params.base ?? {}),
  };
  if (params.mode === "allowlist-extend") {
    const allowAdditions = dedupeStrings([
      ...(normalizeStringArray(params.overlay.allow) ?? []),
      ...(normalizeStringArray(params.overlay.alsoAllow) ?? []),
    ]);
    if (allowAdditions.length > 0) {
      next.alsoAllow = dedupeStrings([...(next.alsoAllow ?? []), ...allowAdditions]);
    }
    const denyAdditions = normalizeStringArray(params.overlay.deny) ?? [];
    if (denyAdditions.length > 0) {
      next.deny = dedupeStrings([...(next.deny ?? []), ...denyAdditions]);
    }
    if (!next.profile && params.overlay.profile) {
      next.profile = params.overlay.profile;
    }
    return next;
  }
  if (params.overlay.allow !== undefined) {
    next.allow = normalizeStringArray(params.overlay.allow) ?? [];
  }
  if (params.overlay.alsoAllow !== undefined) {
    next.alsoAllow = normalizeStringArray(params.overlay.alsoAllow) ?? [];
  }
  if (params.overlay.deny !== undefined) {
    next.deny = normalizeStringArray(params.overlay.deny) ?? [];
  }
  if (params.overlay.profile !== undefined) {
    next.profile = params.overlay.profile;
  }
  return next;
}

function mergeScopedTools(params: {
  base: ToolsConfig | undefined;
  overlay: ClawifyScopedToolsConfig | undefined;
  mode: ClawifyUserMutationPolicy | "replace";
}): ToolsConfig | undefined {
  if (!params.overlay) {
    return params.base;
  }
  const next: ToolsConfig = {
    ...(params.base ?? {}),
  };
  if (params.mode === "allowlist-extend") {
    const allowAdditions = dedupeStrings([
      ...(normalizeStringArray(params.overlay.allow) ?? []),
      ...(normalizeStringArray(params.overlay.alsoAllow) ?? []),
    ]);
    if (allowAdditions.length > 0) {
      next.alsoAllow = dedupeStrings([...(next.alsoAllow ?? []), ...allowAdditions]);
    }
    const denyAdditions = normalizeStringArray(params.overlay.deny) ?? [];
    if (denyAdditions.length > 0) {
      next.deny = dedupeStrings([...(next.deny ?? []), ...denyAdditions]);
    }
    if (!next.profile && params.overlay.profile) {
      next.profile = params.overlay.profile;
    }
  } else {
    if (params.overlay.allow !== undefined) {
      next.allow = normalizeStringArray(params.overlay.allow) ?? [];
    }
    if (params.overlay.alsoAllow !== undefined) {
      next.alsoAllow = normalizeStringArray(params.overlay.alsoAllow) ?? [];
    }
    if (params.overlay.deny !== undefined) {
      next.deny = normalizeStringArray(params.overlay.deny) ?? [];
    }
    if (params.overlay.profile !== undefined) {
      next.profile = params.overlay.profile;
    }
  }

  if (params.overlay.byProvider && typeof params.overlay.byProvider === "object") {
    const mergedByProvider: Record<string, ToolPolicyConfig> = {
      ...(next.byProvider ?? {}),
    };
    for (const [providerKey, providerPolicy] of Object.entries(params.overlay.byProvider)) {
      if (!providerPolicy || typeof providerPolicy !== "object") {
        continue;
      }
      mergedByProvider[providerKey] = mergeToolPolicyRecord({
        base: mergedByProvider[providerKey],
        overlay: providerPolicy,
        mode: params.mode,
      });
    }
    next.byProvider = mergedByProvider;
  }
  return next;
}

function mergeSkillEntries(params: {
  base: OpenClawConfig["skills"];
  overlay: ClawifyScopedSkillsConfig | undefined;
  mode: ClawifyUserMutationPolicy | "replace";
}): OpenClawConfig["skills"] {
  if (!params.overlay?.entries || typeof params.overlay.entries !== "object") {
    return params.base;
  }
  const nextSkills = {
    ...(params.base ?? {}),
  };
  const nextEntries: Record<string, SkillConfig> = {
    ...(nextSkills.entries ?? {}),
  };
  for (const [skillKey, skillEntry] of Object.entries(params.overlay.entries)) {
    if (!skillEntry || typeof skillEntry !== "object") {
      continue;
    }
    if (params.mode === "allowlist-extend") {
      nextEntries[skillKey] = {
        ...(nextEntries[skillKey] ?? {}),
        ...skillEntry,
      };
      continue;
    }
    nextEntries[skillKey] = { ...skillEntry };
  }
  nextSkills.entries = nextEntries;
  return nextSkills;
}

function mergeMcpConfig(params: {
  base: McpConfig | undefined;
  overlay: ClawifyScopedMcpConfig | undefined;
  mode: ClawifyUserMutationPolicy | "replace";
}): McpConfig | undefined {
  if (!params.overlay?.servers || typeof params.overlay.servers !== "object") {
    return params.base;
  }
  const next: McpConfig = {
    ...(params.base ?? {}),
  };
  const mergedServers = {
    ...(next.servers ?? {}),
  };
  for (const [serverName, serverConfig] of Object.entries(params.overlay.servers)) {
    if (!serverConfig || typeof serverConfig !== "object") {
      continue;
    }
    mergedServers[serverName] = {
      ...(mergedServers[serverName] ?? {}),
      ...serverConfig,
    };
  }
  next.servers = mergedServers;
  return next;
}

function resolveMutationPolicy(raw: unknown): ClawifyUserMutationPolicy {
  const normalized = normalizeClawifyId(raw)?.toLowerCase();
  if (normalized === "none" || normalized === "allowlist-extend" || normalized === "replace") {
    return normalized;
  }
  return DEFAULT_CLAWIFY_USER_MUTATION_POLICY;
}

export function resolveClawifyInstanceConfig(params: {
  cfg: OpenClawConfig;
  instanceId?: string;
}): { instanceId: string; instance: ClawifyInstanceConfig } | undefined {
  const requested = normalizeClawifyId(params.instanceId);
  const defaultInstanceId = normalizeClawifyId(params.cfg.clawify?.defaultInstanceId);
  const resolvedId = requested ?? defaultInstanceId;
  if (!resolvedId) {
    return undefined;
  }
  const instance = params.cfg.clawify?.instances?.[resolvedId];
  if (!instance || typeof instance !== "object") {
    return undefined;
  }
  return {
    instanceId: resolvedId,
    instance,
  };
}

export function applyClawifyScopeToConfig(params: {
  cfg: OpenClawConfig;
  scope?: ClawifyScope;
}): OpenClawConfig {
  const scopedInstance = resolveClawifyInstanceConfig({
    cfg: params.cfg,
    instanceId: params.scope?.instanceId,
  });
  if (!scopedInstance) {
    return params.cfg;
  }
  const withInstance: OpenClawConfig = {
    ...params.cfg,
    tools: mergeScopedTools({
      base: params.cfg.tools,
      overlay: scopedInstance.instance.tools,
      mode: "replace",
    }),
    skills: mergeSkillEntries({
      base: params.cfg.skills,
      overlay: scopedInstance.instance.skills,
      mode: "replace",
    }),
    mcp: mergeMcpConfig({
      base: params.cfg.mcp,
      overlay: scopedInstance.instance.mcp,
      mode: "replace",
    }),
  };
  const userId = normalizeClawifyId(params.scope?.userId);
  if (!userId) {
    return withInstance;
  }
  const scopedUser = scopedInstance.instance.users?.[userId];
  if (!scopedUser || typeof scopedUser !== "object") {
    return withInstance;
  }
  const toolsPolicy = resolveMutationPolicy(scopedInstance.instance.userPolicy?.tools);
  const skillsPolicy = resolveMutationPolicy(scopedInstance.instance.userPolicy?.skills);
  const mcpPolicy = resolveMutationPolicy(scopedInstance.instance.userPolicy?.mcp);
  return {
    ...withInstance,
    tools:
      toolsPolicy === "none"
        ? withInstance.tools
        : mergeScopedTools({
            base: withInstance.tools,
            overlay: scopedUser.tools,
            mode: toolsPolicy,
          }),
    skills:
      skillsPolicy === "none"
        ? withInstance.skills
        : mergeSkillEntries({
            base: withInstance.skills,
            overlay: scopedUser.skills,
            mode: skillsPolicy,
          }),
    mcp:
      mcpPolicy === "none"
        ? withInstance.mcp
        : mergeMcpConfig({
            base: withInstance.mcp,
            overlay: scopedUser.mcp,
            mode: mcpPolicy,
          }),
  };
}

export function resolveClawifyUserConfig(params: {
  cfg: OpenClawConfig;
  instanceId?: string;
  userId?: string;
}): { instanceId: string; userId: string; user: ClawifyUserConfig } | undefined {
  const scopedInstance = resolveClawifyInstanceConfig({
    cfg: params.cfg,
    instanceId: params.instanceId,
  });
  if (!scopedInstance) {
    return undefined;
  }
  const userId = normalizeClawifyId(params.userId);
  if (!userId) {
    return undefined;
  }
  const user = scopedInstance.instance.users?.[userId];
  if (!user || typeof user !== "object") {
    return undefined;
  }
  return {
    instanceId: scopedInstance.instanceId,
    userId,
    user,
  };
}

export function normalizeClawifyScope(scope: {
  instanceId?: unknown;
  userId?: unknown;
}): ClawifyScope {
  return {
    instanceId: normalizeClawifyId(scope.instanceId),
    userId: normalizeClawifyId(scope.userId),
  };
}
