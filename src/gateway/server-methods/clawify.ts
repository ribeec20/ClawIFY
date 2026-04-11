import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { ClawifyInstanceConfig, ClawifyUserConfig } from "../../config/types.clawify.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateClawifyInstanceDeleteParams,
  validateClawifyInstanceGetParams,
  validateClawifyInstanceUpsertParams,
  validateClawifyInstancesListParams,
  validateClawifyUserDeleteParams,
  validateClawifyUserGetParams,
  validateClawifyUserUpsertParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeScopedId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveInstanceOrError(params: {
  cfg: ReturnType<typeof loadConfig>;
  requestedId?: string;
}): { instanceId: string; instance: ClawifyInstanceConfig } | { error: string } {
  const instances = params.cfg.clawify?.instances ?? {};
  const resolvedId = params.requestedId ?? normalizeScopedId(params.cfg.clawify?.defaultInstanceId);
  if (!resolvedId) {
    return { error: "instance id required (none configured and no default instance set)" };
  }
  const instance = instances[resolvedId];
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    return { error: `unknown clawify instance "${resolvedId}"` };
  }
  return { instanceId: resolvedId, instance: instance as ClawifyInstanceConfig };
}

function sortedInstanceIds(cfg: ReturnType<typeof loadConfig>): string[] {
  return Object.keys(cfg.clawify?.instances ?? {})
    .map((id) => id.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export const clawifyHandlers: GatewayRequestHandlers = {
  "clawify.instances.list": ({ params, respond }) => {
    if (!validateClawifyInstancesListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.instances.list params: ${formatValidationErrors(validateClawifyInstancesListParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const defaultInstanceId = normalizeScopedId(cfg.clawify?.defaultInstanceId);
    respond(
      true,
      {
        defaultInstanceId,
        instances: sortedInstanceIds(cfg).map((id) => ({ id })),
      },
      undefined,
    );
  },
  "clawify.instance.get": ({ params, respond }) => {
    if (!validateClawifyInstanceGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.instance.get params: ${formatValidationErrors(validateClawifyInstanceGetParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const requestedId = normalizeScopedId(params.instanceId);
    const resolved = resolveInstanceOrError({
      cfg,
      requestedId,
    });
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    respond(
      true,
      {
        instanceId: resolved.instanceId,
        config: resolved.instance,
      },
      undefined,
    );
  },
  "clawify.instance.upsert": async ({ params, respond }) => {
    if (!validateClawifyInstanceUpsertParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.instance.upsert params: ${formatValidationErrors(validateClawifyInstanceUpsertParams.errors)}`,
        ),
      );
      return;
    }
    const instanceId = params.instanceId.trim();
    const cfg = loadConfig();
    const clawify = {
      ...(cfg.clawify ?? {}),
    };
    const instances = {
      ...(clawify.instances ?? {}),
    };
    instances[instanceId] = structuredClone(params.config) as ClawifyInstanceConfig;
    clawify.instances = instances;
    if (!normalizeScopedId(clawify.defaultInstanceId)) {
      clawify.defaultInstanceId = instanceId;
    }
    await writeConfigFile({
      ...cfg,
      clawify,
    });
    respond(true, { ok: true, instanceId }, undefined);
  },
  "clawify.instance.delete": async ({ params, respond }) => {
    if (!validateClawifyInstanceDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.instance.delete params: ${formatValidationErrors(validateClawifyInstanceDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const instanceId = params.instanceId.trim();
    const cfg = loadConfig();
    const instances = {
      ...(cfg.clawify?.instances ?? {}),
    };
    if (!(instanceId in instances)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown clawify instance "${instanceId}"`),
      );
      return;
    }
    delete instances[instanceId];
    const remainingIds = Object.keys(instances).sort((a, b) => a.localeCompare(b));
    const nextDefault =
      normalizeScopedId(cfg.clawify?.defaultInstanceId) === instanceId
        ? remainingIds[0]
        : normalizeScopedId(cfg.clawify?.defaultInstanceId);
    await writeConfigFile({
      ...cfg,
      clawify: {
        ...(cfg.clawify ?? {}),
        instances,
        defaultInstanceId: nextDefault,
      },
    });
    respond(true, { ok: true, instanceId }, undefined);
  },
  "clawify.user.get": ({ params, respond }) => {
    if (!validateClawifyUserGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.user.get params: ${formatValidationErrors(validateClawifyUserGetParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const resolvedInstance = resolveInstanceOrError({
      cfg,
      requestedId: normalizeScopedId(params.instanceId),
    });
    if ("error" in resolvedInstance) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolvedInstance.error));
      return;
    }
    const userId = params.userId.trim();
    const users = (resolvedInstance.instance.users ?? {}) as Record<string, unknown>;
    const user = users[userId];
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown clawify user "${userId}" in instance "${resolvedInstance.instanceId}"`,
        ),
      );
      return;
    }
    respond(
      true,
      {
        instanceId: resolvedInstance.instanceId,
        userId,
        config: user,
      },
      undefined,
    );
  },
  "clawify.user.upsert": async ({ params, respond }) => {
    if (!validateClawifyUserUpsertParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.user.upsert params: ${formatValidationErrors(validateClawifyUserUpsertParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const resolvedInstance = resolveInstanceOrError({
      cfg,
      requestedId: normalizeScopedId(params.instanceId),
    });
    if ("error" in resolvedInstance) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolvedInstance.error));
      return;
    }
    const userId = params.userId.trim();
    const clawify = {
      ...(cfg.clawify ?? {}),
    };
    const instances = {
      ...(clawify.instances ?? {}),
    };
    const currentInstance = {
      ...resolvedInstance.instance,
    };
    const users: Record<string, ClawifyUserConfig> = {
      ...(currentInstance.users ?? {}),
    };
    users[userId] = structuredClone(params.config) as ClawifyUserConfig;
    currentInstance.users = users;
    instances[resolvedInstance.instanceId] = currentInstance;
    clawify.instances = instances;
    await writeConfigFile({
      ...cfg,
      clawify,
    });
    respond(true, { ok: true, instanceId: resolvedInstance.instanceId, userId }, undefined);
  },
  "clawify.user.delete": async ({ params, respond }) => {
    if (!validateClawifyUserDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid clawify.user.delete params: ${formatValidationErrors(validateClawifyUserDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const resolvedInstance = resolveInstanceOrError({
      cfg,
      requestedId: normalizeScopedId(params.instanceId),
    });
    if ("error" in resolvedInstance) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolvedInstance.error));
      return;
    }
    const userId = params.userId.trim();
    const currentUsers: Record<string, ClawifyUserConfig> = {
      ...(resolvedInstance.instance.users ?? {}),
    };
    if (!(userId in currentUsers)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown clawify user "${userId}" in instance "${resolvedInstance.instanceId}"`,
        ),
      );
      return;
    }
    delete currentUsers[userId];
    const clawify = {
      ...(cfg.clawify ?? {}),
    };
    const instances = {
      ...(clawify.instances ?? {}),
    };
    instances[resolvedInstance.instanceId] = {
      ...resolvedInstance.instance,
      users: currentUsers,
    };
    clawify.instances = instances;
    await writeConfigFile({
      ...cfg,
      clawify,
    });
    respond(true, { ok: true, instanceId: resolvedInstance.instanceId, userId }, undefined);
  },
};
