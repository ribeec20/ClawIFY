import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const ToolProfileIdSchema = Type.Union([
  Type.Literal("minimal"),
  Type.Literal("coding"),
  Type.Literal("messaging"),
  Type.Literal("full"),
]);

const ClawifyToolPolicySchema = Type.Object(
  {
    allow: Type.Optional(Type.Array(NonEmptyString)),
    alsoAllow: Type.Optional(Type.Array(NonEmptyString)),
    deny: Type.Optional(Type.Array(NonEmptyString)),
    profile: Type.Optional(ToolProfileIdSchema),
  },
  { additionalProperties: false },
);

const ClawifyScopedToolsConfigSchema = Type.Object(
  {
    allow: Type.Optional(Type.Array(NonEmptyString)),
    alsoAllow: Type.Optional(Type.Array(NonEmptyString)),
    deny: Type.Optional(Type.Array(NonEmptyString)),
    profile: Type.Optional(ToolProfileIdSchema),
    byProvider: Type.Optional(Type.Record(NonEmptyString, ClawifyToolPolicySchema)),
  },
  { additionalProperties: false },
);

const ClawifySkillConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    config: Type.Optional(Type.Record(NonEmptyString, Type.Unknown())),
  },
  { additionalProperties: false },
);

const ClawifyScopedSkillsConfigSchema = Type.Object(
  {
    entries: Type.Optional(Type.Record(NonEmptyString, ClawifySkillConfigSchema)),
  },
  { additionalProperties: false },
);

const ClawifyMcpServerSchema = Type.Object(
  {
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(NonEmptyString, Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
    cwd: Type.Optional(Type.String()),
    workingDirectory: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    transport: Type.Optional(Type.Union([Type.Literal("sse"), Type.Literal("streamable-http")])),
    headers: Type.Optional(Type.Record(NonEmptyString, Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
    connectionTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: true },
);

const ClawifyScopedMcpConfigSchema = Type.Object(
  {
    servers: Type.Optional(Type.Record(NonEmptyString, ClawifyMcpServerSchema)),
  },
  { additionalProperties: false },
);

const ClawifyMutationPolicySchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("allowlist-extend"),
  Type.Literal("replace"),
]);

const ClawifyUserPolicyConfigSchema = Type.Object(
  {
    tools: Type.Optional(ClawifyMutationPolicySchema),
    skills: Type.Optional(ClawifyMutationPolicySchema),
    mcp: Type.Optional(ClawifyMutationPolicySchema),
  },
  { additionalProperties: false },
);

export const ClawifyUserConfigSchema = Type.Object(
  {
    tools: Type.Optional(ClawifyScopedToolsConfigSchema),
    skills: Type.Optional(ClawifyScopedSkillsConfigSchema),
    mcp: Type.Optional(ClawifyScopedMcpConfigSchema),
  },
  { additionalProperties: false },
);

export const ClawifyInstanceConfigSchema = Type.Object(
  {
    tools: Type.Optional(ClawifyScopedToolsConfigSchema),
    skills: Type.Optional(ClawifyScopedSkillsConfigSchema),
    mcp: Type.Optional(ClawifyScopedMcpConfigSchema),
    userPolicy: Type.Optional(ClawifyUserPolicyConfigSchema),
    users: Type.Optional(Type.Record(NonEmptyString, ClawifyUserConfigSchema)),
  },
  { additionalProperties: false },
);

export const ClawifyInstancesListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ClawifyInstanceGetParamsSchema = Type.Object(
  {
    instanceId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ClawifyInstanceUpsertParamsSchema = Type.Object(
  {
    instanceId: NonEmptyString,
    config: ClawifyInstanceConfigSchema,
  },
  { additionalProperties: false },
);

export const ClawifyInstanceDeleteParamsSchema = Type.Object(
  {
    instanceId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ClawifyUserGetParamsSchema = Type.Object(
  {
    instanceId: Type.Optional(NonEmptyString),
    userId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ClawifyUserUpsertParamsSchema = Type.Object(
  {
    instanceId: Type.Optional(NonEmptyString),
    userId: NonEmptyString,
    config: ClawifyUserConfigSchema,
  },
  { additionalProperties: false },
);

export const ClawifyUserDeleteParamsSchema = Type.Object(
  {
    instanceId: Type.Optional(NonEmptyString),
    userId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ClawifyInstancesListResultSchema = Type.Object(
  {
    defaultInstanceId: Type.Optional(NonEmptyString),
    instances: Type.Array(
      Type.Object(
        {
          id: NonEmptyString,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const ClawifyInstanceGetResultSchema = Type.Object(
  {
    instanceId: NonEmptyString,
    config: ClawifyInstanceConfigSchema,
  },
  { additionalProperties: false },
);

export const ClawifyUserGetResultSchema = Type.Object(
  {
    instanceId: NonEmptyString,
    userId: NonEmptyString,
    config: ClawifyUserConfigSchema,
  },
  { additionalProperties: false },
);

export const ClawifyMutationResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    instanceId: NonEmptyString,
    userId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
