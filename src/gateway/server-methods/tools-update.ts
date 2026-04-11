import type { ToolPolicyConfig, ToolProfileId } from "../../config/types.tools.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateToolsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type UserMutationPolicy = "none" | "allowlist-extend" | "replace";

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeScopedId(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function resolveUserMutationPolicy(value: unknown): UserMutationPolicy {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === "none" || normalized === "allowlist-extend" || normalized === "replace") {
    return normalized;
  }
  return "allowlist-extend";
}

function normalizeToolProfileId(value: unknown): ToolProfileId | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (
    normalized === "minimal" ||
    normalized === "coding" ||
    normalized === "messaging" ||
    normalized === "full"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeByProviderPolicies(value: unknown): Record<string, ToolPolicyConfig> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const output: Record<string, ToolPolicyConfig> = {};
  for (const [providerKey, providerPolicy] of Object.entries(value as Record<string, unknown>)) {
    if (!providerPolicy || typeof providerPolicy !== "object" || Array.isArray(providerPolicy)) {
      continue;
    }
    const policy = providerPolicy as Record<string, unknown>;
    const profile = normalizeToolProfileId(policy.profile);
    output[providerKey] = {
      ...(normalizeStringArray(policy.allow) !== undefined
        ? { allow: normalizeStringArray(policy.allow) ?? [] }
        : {}),
      ...(normalizeStringArray(policy.alsoAllow) !== undefined
        ? { alsoAllow: normalizeStringArray(policy.alsoAllow) ?? [] }
        : {}),
      ...(normalizeStringArray(policy.deny) !== undefined
        ? { deny: normalizeStringArray(policy.deny) ?? [] }
        : {}),
      ...(profile ? { profile } : {}),
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function mergeToolPolicyForMode(params: {
  current: Record<string, unknown>;
  update: {
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
    profile?: ToolProfileId;
    byProvider?: Record<string, ToolPolicyConfig>;
  };
  mode: UserMutationPolicy | "replace";
}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params.current };
  if (params.mode === "allowlist-extend") {
    const additions = [
      ...(params.update.allow ?? []),
      ...(params.update.alsoAllow ?? []),
    ];
    if (additions.length > 0) {
      next.alsoAllow = normalizeStringArray([...(next.alsoAllow as string[] | undefined) ?? [], ...additions]);
    }
    if ((params.update.deny ?? []).length > 0) {
      next.deny = normalizeStringArray([...(next.deny as string[] | undefined) ?? [], ...(params.update.deny ?? [])]);
    }
    if (!next.profile && params.update.profile) {
      next.profile = params.update.profile;
    }
  } else {
    if (params.update.allow !== undefined) {
      next.allow = params.update.allow;
    }
    if (params.update.alsoAllow !== undefined) {
      next.alsoAllow = params.update.alsoAllow;
    }
    if (params.update.deny !== undefined) {
      next.deny = params.update.deny;
    }
    if (params.update.profile !== undefined) {
      next.profile = params.update.profile;
    }
  }
  if (params.update.byProvider) {
    const byProvider = {
      ...((next.byProvider as Record<string, ToolPolicyConfig> | undefined) ?? {}),
    };
    for (const [providerKey, providerPolicy] of Object.entries(params.update.byProvider)) {
      const existingPolicy = byProvider[providerKey] ?? {};
      if (params.mode === "allowlist-extend") {
        byProvider[providerKey] = {
          ...existingPolicy,
          ...(providerPolicy.profile && !existingPolicy.profile
            ? { profile: providerPolicy.profile }
            : {}),
          ...(providerPolicy.allow || providerPolicy.alsoAllow
            ? {
                alsoAllow: normalizeStringArray([
                  ...(existingPolicy.alsoAllow ?? []),
                  ...(providerPolicy.allow ?? []),
                  ...(providerPolicy.alsoAllow ?? []),
                ]),
              }
            : {}),
          ...(providerPolicy.deny
            ? {
                deny: normalizeStringArray([...(existingPolicy.deny ?? []), ...providerPolicy.deny]),
              }
            : {}),
        };
        continue;
      }
      byProvider[providerKey] = {
        ...existingPolicy,
        ...providerPolicy,
      };
    }
    next.byProvider = byProvider;
  }
  return next;
}

export const toolsUpdateHandlers: GatewayRequestHandlers = {
  "tools.update": async ({ params, respond }) => {
    if (!validateToolsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid tools.update params: ${formatValidationErrors(validateToolsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const instanceId = normalizeScopedId(params.instanceId);
    const userId = normalizeScopedId(params.userId);
    const update = {
      allow: normalizeStringArray(params.allow),
      alsoAllow: normalizeStringArray(params.alsoAllow),
      deny: normalizeStringArray(params.deny),
      profile: normalizeToolProfileId(params.profile),
      byProvider: normalizeByProviderPolicies(params.byProvider),
    };

    if (!instanceId) {
      const current = (cfg.tools ?? {}) as Record<string, unknown>;
      const nextTools = mergeToolPolicyForMode({
        current,
        update,
        mode: "replace",
      });
      await writeConfigFile({
        ...cfg,
        tools: nextTools,
      });
      respond(true, { ok: true, scope: "global", config: nextTools }, undefined);
      return;
    }

    const clawify = {
      ...(cfg.clawify ?? {}),
    };
    const instances = {
      ...(clawify.instances ?? {}),
    };
    const currentInstance = ((instances[instanceId] as Record<string, unknown> | undefined) ?? {}) as Record<
      string,
      unknown
    >;
    if (!instances[instanceId]) {
      instances[instanceId] = currentInstance;
    }
    if (!clawify.defaultInstanceId) {
      clawify.defaultInstanceId = instanceId;
    }

    if (!userId) {
      const currentTools =
        currentInstance.tools && typeof currentInstance.tools === "object"
          ? (currentInstance.tools as Record<string, unknown>)
          : {};
      currentInstance.tools = mergeToolPolicyForMode({
        current: currentTools,
        update,
        mode: "replace",
      });
      instances[instanceId] = currentInstance;
      clawify.instances = instances;
      await writeConfigFile({
        ...cfg,
        clawify,
      });
      respond(true, { ok: true, scope: "instance", instanceId, config: currentInstance.tools }, undefined);
      return;
    }

    const userPolicy =
      currentInstance.userPolicy && typeof currentInstance.userPolicy === "object"
        ? (currentInstance.userPolicy as Record<string, unknown>)
        : {};
    const userToolPolicy = resolveUserMutationPolicy(userPolicy.tools);
    if (userToolPolicy === "none") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `user tool mutation is disabled for instance "${instanceId}"`,
        ),
      );
      return;
    }
    const users = (currentInstance.users && typeof currentInstance.users === "object"
      ? currentInstance.users
      : {}) as Record<string, unknown>;
    const currentUser = ((users[userId] as Record<string, unknown> | undefined) ?? {}) as Record<
      string,
      unknown
    >;
    const currentUserTools =
      currentUser.tools && typeof currentUser.tools === "object"
        ? (currentUser.tools as Record<string, unknown>)
        : {};
    currentUser.tools = mergeToolPolicyForMode({
      current: currentUserTools,
      update,
      mode: userToolPolicy,
    });
    users[userId] = currentUser;
    currentInstance.users = users;
    instances[instanceId] = currentInstance;
    clawify.instances = instances;
    await writeConfigFile({
      ...cfg,
      clawify,
    });
    respond(
      true,
      {
        ok: true,
        scope: "user",
        instanceId,
        userId,
        mode: userToolPolicy,
        config: currentUser.tools,
      },
      undefined,
    );
  },
};
