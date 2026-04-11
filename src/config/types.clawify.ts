import type { McpConfig } from "./types.mcp.js";
import type { SkillConfig } from "./types.skills.js";
import type { ToolPolicyConfig, ToolProfileId } from "./types.tools.js";

export type ClawifyUserMutationPolicy = "none" | "allowlist-extend" | "replace";

export type ClawifyScopedToolsConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: ToolProfileId;
  byProvider?: Record<string, ToolPolicyConfig>;
};

export type ClawifyScopedSkillsConfig = {
  entries?: Record<string, SkillConfig>;
};

export type ClawifyScopedMcpConfig = McpConfig;

export type ClawifyUserConfig = {
  tools?: ClawifyScopedToolsConfig;
  skills?: ClawifyScopedSkillsConfig;
  mcp?: ClawifyScopedMcpConfig;
};

export type ClawifyUserPolicyConfig = {
  tools?: ClawifyUserMutationPolicy;
  skills?: ClawifyUserMutationPolicy;
  mcp?: ClawifyUserMutationPolicy;
};

export type ClawifyInstanceConfig = {
  tools?: ClawifyScopedToolsConfig;
  skills?: ClawifyScopedSkillsConfig;
  mcp?: ClawifyScopedMcpConfig;
  userPolicy?: ClawifyUserPolicyConfig;
  users?: Record<string, ClawifyUserConfig>;
};

export type ClawifyConfig = {
  defaultInstanceId?: string;
  instances?: Record<string, ClawifyInstanceConfig>;
};
