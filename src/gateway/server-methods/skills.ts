import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import {
  installSkillFromClawHub,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../agents/skills-clawhub.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { resolveClawifyInstanceConfig } from "../../config/clawify-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsDetailParams,
  validateSkillsInstallParams,
  validateSkillsSearchParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ResolvedSkillsScope =
  | null
  | {
      instanceId: string;
      userId?: string;
      instance: Record<string, unknown>;
      mode: "none" | "allowlist-extend" | "replace";
    }
  | {
      error: string;
    };

function resolveUserMutationMode(value: unknown): "none" | "allowlist-extend" | "replace" {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized === "none" || normalized === "allowlist-extend" || normalized === "replace") {
    return normalized;
  }
  return "allowlist-extend";
}

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = normalizeOptionalString(String(bin)) ?? "";
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = normalizeOptionalString(params?.agentId) ?? "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: {
        remote: getRemoteSkillEligibility({
          advertiseExecNode: canExecRequestNode({
            cfg,
            agentId,
          }),
        }),
      },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": async ({ params, respond }) => {
    if (!validateSkillsSearchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.search params: ${formatValidationErrors(validateSkillsSearchParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const results = await searchSkillsFromClawHub({
        query: (params as { query?: string }).query,
        limit: (params as { limit?: number }).limit,
      });
      respond(true, { results }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.detail": async ({ params, respond }) => {
    if (!validateSkillsDetailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.detail params: ${formatValidationErrors(validateSkillsDetailParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const detail = await fetchClawHubSkillDetail({
        slug: (params as { slug: string }).slug,
      });
      respond(true, detail, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug: string;
        version?: string;
        force?: boolean;
      };
      const result = await installSkillFromClawHub({
        workspaceDir: workspaceDirRaw,
        slug: p.slug,
        version: p.version,
        force: Boolean(p.force),
      });
      respond(
        result.ok,
        result.ok
          ? {
              ok: true,
              message: `Installed ${result.slug}@${result.version}`,
              stdout: "",
              stderr: "",
              code: 0,
              slug: result.slug,
              version: result.version,
              targetDir: result.targetDir,
            }
          : result,
        result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.error),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      dangerouslyForceUnsafeInstall?: boolean;
      timeoutMs?: number;
    };
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      dangerouslyForceUnsafeInstall: p.dangerouslyForceUnsafeInstall,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug?: string;
        all?: boolean;
      };
      if (!p.slug && !p.all) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, 'clawhub skills.update requires "slug" or "all"'),
        );
        return;
      }
      if (p.slug && p.all) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            'clawhub skills.update accepts either "slug" or "all", not both',
          ),
        );
        return;
      }
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
      const results = await updateSkillsFromClawHub({
        workspaceDir,
        slug: p.slug,
      });
      const errors = results.filter((result) => !result.ok);
      respond(
        errors.length === 0,
        {
          ok: errors.length === 0,
          skillKey: p.slug ?? "*",
          config: {
            source: "clawhub",
            results,
          },
        },
        errors.length === 0
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; ")),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
      instanceId?: string;
      userId?: string;
    };
    const cfg = loadConfig();
    let targetConfig: OpenClawConfig = { ...cfg };
    const resolvedScope: ResolvedSkillsScope = (() => {
      const requestedInstanceId = normalizeOptionalString(p.instanceId);
      const requestedUserId = normalizeOptionalString(p.userId);
      if (!requestedInstanceId && !requestedUserId) {
        return null;
      }
      const resolvedInstance = resolveClawifyInstanceConfig({
        cfg,
        instanceId: requestedInstanceId,
      });
      if (resolvedInstance) {
        return {
          instanceId: resolvedInstance.instanceId,
          userId: requestedUserId,
          instance: {
            ...resolvedInstance.instance,
          } as Record<string, unknown>,
          mode:
            resolveUserMutationMode(
              (resolvedInstance.instance.userPolicy as { skills?: unknown } | undefined)?.skills,
            ),
        };
      }
      if (!requestedInstanceId) {
        return {
          error:
            "userId was provided but no clawify instance is configured and no default instance is set",
        };
      }
      return {
        instanceId: requestedInstanceId,
        userId: requestedUserId,
        instance: {},
        mode: "allowlist-extend",
      };
    })();
    if (resolvedScope && "error" in resolvedScope) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolvedScope.error));
      return;
    }
    const getCurrentSkillEntry = () => {
      if (!resolvedScope) {
        return (targetConfig.skills?.entries?.[p.skillKey] ?? {}) as Record<string, unknown>;
      }
      const instanceSkillsEntries =
        ((resolvedScope.instance.skills as { entries?: Record<string, unknown> } | undefined)
          ?.entries as Record<string, unknown> | undefined) ?? {};
      if (!resolvedScope.userId) {
        return (instanceSkillsEntries[p.skillKey] as Record<string, unknown> | undefined) ?? {};
      }
      const userEntry = (
        ((resolvedScope.instance.users as Record<string, unknown> | undefined)?.[
          resolvedScope.userId
        ] as { skills?: { entries?: Record<string, unknown> } } | undefined) ?? {}
      ).skills?.entries?.[p.skillKey];
      return (userEntry as Record<string, unknown> | undefined) ?? {};
    };
    const current = { ...getCurrentSkillEntry() };
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv: Record<string, string> =
        current.env && typeof current.env === "object"
          ? { ...(current.env as Record<string, string>) }
          : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    if (!resolvedScope) {
      const skills = targetConfig.skills ? { ...targetConfig.skills } : {};
      const entries = skills.entries ? { ...skills.entries } : {};
      entries[p.skillKey] = current;
      skills.entries = entries;
      targetConfig = {
        ...targetConfig,
        skills,
      };
    } else {
      const clawify = {
        ...(targetConfig.clawify ?? {}),
      };
      const instances = {
        ...(clawify.instances ?? {}),
      };
      const instance = {
        ...resolvedScope.instance,
      };
      if (!resolvedScope.userId) {
        const skills = (instance.skills as { entries?: Record<string, unknown> } | undefined) ?? {};
        const entries = {
          ...(skills.entries ?? {}),
        };
        entries[p.skillKey] = current;
        instance.skills = {
          ...skills,
          entries,
        };
      } else {
        const mode = resolvedScope.mode;
        if (mode === "none") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `user skill mutation is disabled for instance "${resolvedScope.instanceId}"`,
            ),
          );
          return;
        }
        const users = {
          ...((instance.users as Record<string, unknown> | undefined) ?? {}),
        };
        const user = ((users[resolvedScope.userId] as Record<string, unknown> | undefined) ?? {}) as Record<
          string,
          unknown
        >;
        const userSkills = (user.skills as { entries?: Record<string, unknown> } | undefined) ?? {};
        const userEntries = {
          ...(userSkills.entries ?? {}),
        };
        userEntries[p.skillKey] =
          mode === "allowlist-extend"
            ? {
                ...((userEntries[p.skillKey] as Record<string, unknown> | undefined) ?? {}),
                ...current,
              }
            : current;
        user.skills = {
          ...userSkills,
          entries: userEntries,
        };
        users[resolvedScope.userId] = user;
        instance.users = users;
      }
      instances[resolvedScope.instanceId] = instance;
      clawify.instances = instances;
      if (!normalizeOptionalString(clawify.defaultInstanceId)) {
        clawify.defaultInstanceId = resolvedScope.instanceId;
      }
      targetConfig = {
        ...targetConfig,
        clawify,
      };
    }
    await writeConfigFile(targetConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
};
