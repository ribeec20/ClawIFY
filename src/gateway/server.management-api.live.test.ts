import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { clawify } from "./clawify-sdk.js";

type ManagementEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  route?: {
    routeId?: string;
  };
};

type ToolsCatalogResult = {
  groups?: Array<{
    tools?: Array<{
      id?: string;
    }>;
  }>;
};

type AgentsListResult = {
  defaultId?: string;
  agents?: Array<{
    id?: string;
    workspace?: string;
  }>;
};

const LIVE = isLiveTestEnabled(["OPENCLAW_LIVE_MANAGEMENT_API"]);
const MANAGEMENT_LIVE = isTruthyEnvValue(process.env.OPENCLAW_LIVE_MANAGEMENT_API);
const describeLive = LIVE && MANAGEMENT_LIVE ? describe : describe.skip;

const MANAGEMENT_BASE_URL = (
  process.env.OPENCLAW_LIVE_MANAGEMENT_BASE_URL?.trim() || "http://127.0.0.1:18789"
).replace(/\/+$/, "");
const MANAGEMENT_TOKEN =
  process.env.OPENCLAW_LIVE_MANAGEMENT_TOKEN?.trim() ||
  process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
  undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function resolveWorkspaceRoot(rawWorkspace: string): string {
  const trimmed = rawWorkspace.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function extractToolIds(result: ToolsCatalogResult): string[] {
  const ids: string[] = [];
  for (const group of result.groups ?? []) {
    for (const tool of group.tools ?? []) {
      const id = tool.id?.trim();
      if (id) {
        ids.push(id);
      }
    }
  }
  return dedupeStrings(ids);
}

function resolvePreferredToolId(catalogToolIds: string[]): string {
  const available = new Set(catalogToolIds);
  const preferredIds = ["write", "edit", "exec", "read"];
  for (const preferred of preferredIds) {
    if (available.has(preferred)) {
      return preferred;
    }
  }
  if (catalogToolIds.length > 0) {
    return catalogToolIds[0];
  }
  throw new Error("tools.catalog returned no tool ids");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestHealth(): Promise<void> {
  const headers: Record<string, string> = {};
  if (MANAGEMENT_TOKEN) {
    headers.authorization = `Bearer ${MANAGEMENT_TOKEN}`;
  }
  const response = await fetch(`${MANAGEMENT_BASE_URL}/health`, { headers });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  expect(response.status).toBe(200);
  expect(parsed).toEqual(expect.objectContaining({ ok: true }));
}

async function requestManagement<T>(
  routePath: string,
  init?: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
  },
): Promise<ManagementEnvelope<T>> {
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  if (MANAGEMENT_TOKEN) {
    headers.authorization = `Bearer ${MANAGEMENT_TOKEN}`;
  }
  let body: string | undefined;
  if (method === "POST") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init?.body ?? {});
  }

  const response = await fetch(`${MANAGEMENT_BASE_URL}${routePath}`, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const payload = asRecord(parsed);
  if (!payload) {
    throw new Error(`${method} ${routePath} did not return a JSON object (status=${response.status})`);
  }
  const envelope = payload as ManagementEnvelope<T>;
  if (response.status !== 200 || envelope.ok !== true) {
    const message =
      envelope.error?.message ??
      `management request failed (${method} ${routePath}, status=${response.status})`;
    throw new Error(message);
  }
  return envelope;
}

async function waitForFileToContain(params: {
  filePath: string;
  expectedToken: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let lastValue = "";
  while (Date.now() < deadline) {
    try {
      const current = await fs.readFile(params.filePath, "utf-8");
      lastValue = current;
      if (current.includes(params.expectedToken)) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await delay(1_000);
  }
  throw new Error(
    `Timed out waiting for file edit. file=${params.filePath} lastContent=${JSON.stringify(lastValue)}`,
  );
}

describeLive("gateway management api live", () => {
  it(
    "updates user tools/skills/mcp via clawify sdk and prompts a real file edit",
    { timeout: 300_000 },
    async () => {
      const nonce = randomUUID().slice(0, 8);
      const instanceId = `management-live-instance-${nonce}`;
      const userId = `management-live-user-${nonce}`;
      const skillKey = `management_live_skill_${nonce}`;
      const mcpServerKey = `management_live_mcp_${nonce}`;
      const fileToken = `MANAGEMENT_FILE_EDIT_${nonce}`;

      await requestHealth();

      const catalogEnvelope = await requestManagement<ToolsCatalogResult>(
        "/v1/management/tools/catalog",
      );
      expect(catalogEnvelope.route?.routeId).toBe("tools-catalog");
      const catalogToolIds = extractToolIds(catalogEnvelope.result ?? {});
      expect(catalogToolIds.length).toBeGreaterThan(0);
      const toolToAllow = resolvePreferredToolId(catalogToolIds);

      const agentsEnvelope = await requestManagement<AgentsListResult>("/v1/management/agents/list");
      expect(agentsEnvelope.route?.routeId).toBe("agents-list");
      const agents = agentsEnvelope.result?.agents ?? [];
      const defaultAgentId = agentsEnvelope.result?.defaultId;
      const defaultWorkspace =
        agents.find((agent) => agent.id === defaultAgentId)?.workspace?.trim() ||
        agents.find((agent) => typeof agent.workspace === "string")?.workspace?.trim();
      if (!defaultWorkspace) {
        throw new Error("agents.list did not return a default agent workspace");
      }
      const workspaceRoot = resolveWorkspaceRoot(defaultWorkspace);
      const relativeTestFile = path.posix.join(".openclaw-live-tests", `management-live-${nonce}.txt`);
      const workspaceFilePath = path.join(
        workspaceRoot,
        ...relativeTestFile.split("/"),
      );
      await fs.mkdir(path.dirname(workspaceFilePath), { recursive: true });
      await fs.writeFile(workspaceFilePath, `seed-${nonce}\n`, "utf-8");

      const instance = clawify.instance(instanceId, {
        baseUrl: MANAGEMENT_BASE_URL,
        token: MANAGEMENT_TOKEN,
      });
      const user = instance.user(userId);

      try {
        await instance.upsert({
          userPolicy: {
            tools: "allowlist-extend",
            skills: "allowlist-extend",
            mcp: "allowlist-extend",
          },
        });
        await user.updateSkill(skillKey, {
          enabled: true,
          env: {
            OPENCLAW_MANAGEMENT_LIVE_NONCE: nonce,
          },
        });
        await user.allowTools([toolToAllow]);
        await user.setMcpServer(mcpServerKey, {
          url: "https://mcp.example.com/sse",
          transport: "sse",
          headers: {
            Authorization: `Bearer ${nonce}`,
          },
        });

        const userConfig = await user.getConfig();
        expect(userConfig.skills?.entries?.[skillKey]?.enabled).toBe(true);
        expect(userConfig.mcp?.servers?.[mcpServerKey]?.transport).toBe("sse");

        const modelOverride = process.env.OPENCLAW_LIVE_MANAGEMENT_MODEL?.trim();
        const promptResult = await user.prompt(
          [
            "Use tools to edit one file.",
            `Set ${relativeTestFile} to exactly this text: ${fileToken}`,
            "Do not modify any other file.",
            "After editing, respond with DONE.",
          ].join("\n"),
          modelOverride
            ? {
                model: modelOverride,
              }
            : {},
        );
        expect(promptResult.key).toBeTruthy();
        expect(promptResult.runId).toBeTruthy();

        await waitForFileToContain({
          filePath: workspaceFilePath,
          expectedToken: fileToken,
          timeoutMs: 180_000,
        });
      } finally {
        await instance.delete().catch(() => {});
        await fs.rm(workspaceFilePath, { force: true });
      }
    },
  );
});
