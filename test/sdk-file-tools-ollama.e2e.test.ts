import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type OllamaGatewayInstance,
  type OllamaModel,
  type ToolServer,
  discoverOllamaModel,
  managementPost,
  spawnOllamaGatewayInstance,
  startToolServer,
  stopOllamaGatewayInstance,
  waitForAssistantReply,
} from "./helpers/ollama-e2e.js";

const RUN_TIMEOUT_MS = 120_000;

// Top-level await — runs at module load time so describe.runIf gets a real boolean.
const ollamaModel: OllamaModel | null = await discoverOllamaModel();

describe.runIf(ollamaModel !== null)("SDK file tools e2e with Ollama", () => {
  let gw: OllamaGatewayInstance;

  beforeAll(async () => {
    gw = await spawnOllamaGatewayInstance(ollamaModel!);
  }, 180_000);

  afterAll(async () => {
    if (gw) await stopOllamaGatewayInstance(gw);
  }, 15_000);

  async function sendAndWait(
    message: string,
    opts?: { instanceId?: string },
  ): Promise<string> {
    const createRes = await managementPost(gw, "/v1/management/sessions/create", {
      model: `ollama/${gw.model.id}`,
      ...(opts?.instanceId ? { instanceId: opts.instanceId } : {}),
    });
    expect(createRes.status).toBe(200);
    const result = (createRes.json as { result?: { key?: string; entry?: { sessionFile?: string } } }).result;
    const sessionKey = result?.key;
    const sessionFile = result?.entry?.sessionFile;
    expect(sessionKey).toBeDefined();
    expect(sessionFile).toBeDefined();

    const sendRes = await managementPost(gw, "/v1/management/sessions/send", {
      key: sessionKey,
      message,
    });
    expect(sendRes.status).toBe(200);

    return waitForAssistantReply(sessionFile!, RUN_TIMEOUT_MS);
  }

  it("reads a file and returns its contents", async () => {
    const testFile = path.join(gw.workspaceDir, "hello.txt");
    await fs.writeFile(testFile, "The secret code is: XYLOPHONE-42-JAZZ", "utf8");

    const response = await sendAndWait(
      `Use the read tool to read the file at ${testFile}. ` +
      `What is the full secret code in the file? Repeat it back exactly as written.`,
    );

    expect(response).toContain("XYLOPHONE-42-JAZZ");
  }, RUN_TIMEOUT_MS + 30_000);

  it("writes a new file with specified content", async () => {
    const targetFile = path.join(gw.workspaceDir, "written-by-llm.txt");

    await sendAndWait(
      `Write a file at ${targetFile} with the exact content: OLLAMA_WRITE_TEST_SUCCESS\n` +
      `Do not include any other content in the file. Just write exactly that string. ` +
      `After writing, confirm you wrote the file.`,
    );

    const content = await fs.readFile(targetFile, "utf8");
    expect(content.trim()).toBe("OLLAMA_WRITE_TEST_SUCCESS");
  }, RUN_TIMEOUT_MS + 30_000);

  it("edits an existing file by replacing content", async () => {
    const editFile = path.join(gw.workspaceDir, "to-edit.txt");
    await fs.writeFile(editFile, "The color is RED.", "utf8");

    await sendAndWait(
      `Edit the file at ${editFile}. Replace the word "RED" with "BLUE". ` +
      `Use the edit tool to make this change. After editing, confirm the change was made.`,
    );

    const content = await fs.readFile(editFile, "utf8");
    expect(content).toContain("BLUE");
    expect(content).not.toContain("RED");
  }, RUN_TIMEOUT_MS + 30_000);

  it("reads, then edits based on file contents", async () => {
    const dataFile = path.join(gw.workspaceDir, "data.txt");
    await fs.writeFile(dataFile, "name=TestProject\nversion=1.0.0\nstatus=draft", "utf8");

    await sendAndWait(
      `Read the file at ${dataFile}, then use the edit tool to change the version from "1.0.0" to "2.0.0". ` +
      `After editing, confirm the new version number.`,
    );

    const content = await fs.readFile(dataFile, "utf8");
    expect(content).toContain("version=2.0.0");
    expect(content).toContain("name=TestProject");
    expect(content).toContain("status=draft");
  }, RUN_TIMEOUT_MS + 30_000);
});

describe.runIf(ollamaModel !== null)("Custom tool registration e2e with Ollama", () => {
  const SECRET_CODE = `VAULT-${randomUUID().slice(0, 8).toUpperCase()}`;
  let gw: OllamaGatewayInstance;
  let toolSrv: ToolServer;

  beforeAll(async () => {
    toolSrv = await startToolServer(SECRET_CODE);

    gw = await spawnOllamaGatewayInstance(ollamaModel!, {
      clawify: {
        defaultInstanceId: "test-app",
        instances: {
          "test-app": {
            customTools: {
              get_secret_vault_code: {
                name: "get_secret_vault_code",
                description:
                  "Retrieves the secret vault code. Call this tool to get the code. " +
                  "Takes no meaningful input parameters. Returns the secret code as plain text.",
                parameters: { type: "object", properties: {} },
                target: { url: toolSrv.url },
              },
            },
          },
        },
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (gw) await stopOllamaGatewayInstance(gw);
    if (toolSrv) await toolSrv.close();
  }, 15_000);

  it("calls a registered custom tool and returns its result", async () => {
    const createRes = await managementPost(gw, "/v1/management/sessions/create", {
      model: `ollama/${gw.model.id}`,
      instanceId: "test-app",
    });
    expect(createRes.status).toBe(200);
    const result = (createRes.json as { result?: { key?: string; entry?: { sessionFile?: string } } }).result;
    const sessionKey = result?.key;
    const sessionFile = result?.entry?.sessionFile;
    expect(sessionKey).toBeDefined();
    expect(sessionFile).toBeDefined();

    const sendRes = await managementPost(gw, "/v1/management/sessions/send", {
      key: sessionKey,
      message:
        "Use the get_secret_vault_code tool to retrieve the secret vault code, " +
        "then tell me what the code is. Repeat the exact code in your response.",
    });
    expect(sendRes.status).toBe(200);

    const response = await waitForAssistantReply(sessionFile!, RUN_TIMEOUT_MS);
    expect(response).toContain(SECRET_CODE);
  }, RUN_TIMEOUT_MS + 30_000);
});
