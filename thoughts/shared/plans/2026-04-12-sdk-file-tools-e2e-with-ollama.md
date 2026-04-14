# SDK File Tools E2E Integration Tests with Ollama Provider

## Overview

Add end-to-end integration tests that verify the SDK can read, write, and edit files through the full harness pipeline using a real locally-running Ollama instance (qwen3:0.5b). These tests exercise the complete flow: management API request -> gateway -> embedded pi-agent -> Ollama LLM -> tool_use response -> tool dispatch -> filesystem operation -> result back to caller. A reusable test provider registration helper makes it easy to plug in Ollama (or any local LLM) for harness-level tests.

## Current State Analysis

**What exists:**
- Unit tests for individual tool `execute()` methods (`src/agents/pi-tools.workspace-only-false.test.ts`) — calls tools directly, no LLM involved
- E2E tests for the embedded runner (`src/agents/pi-embedded-runner.e2e.test.ts`) — mocks the LLM, verifies pipeline plumbing
- Transport stream tests (`src/agents/anthropic-transport-stream.test.ts`) — mocks SSE events, verifies tool_use parsing
- Gateway management API endpoint tests (`src/gateway/server.management-api.endpoints.e2e.test.ts`) — verifies HTTP acks, does not wait for run completion
- Full gateway process harness (`test/helpers/gateway-e2e-harness.ts`) — spawns a real `node dist/index.js gateway` child process with config

**What's missing:**
- No test sends a real prompt to a real LLM and verifies that tool_use actually reads/writes/edits files on disk
- No test helper for wiring a local LLM provider into the gateway test harness
- No SSE event consumption helper for waiting on tool events and final responses in e2e tests

**Ollama support already exists:**
- Bundled `ollama` provider plugin with `api: "ollama"` native transport (`extensions/ollama/`)
- `createOllamaStreamFn` talks to `/api/chat` with NDJSON streaming
- Auto-discovery via `/api/tags` + `/api/show`
- Tool calling supported natively (tools sent in request body, tool_calls in response)
- `OLLAMA_LOCAL_AUTH_MARKER = "ollama-local"` sentinel suppresses auth header for local instances

### Key Discoveries:
- `spawnGatewayInstance` (`test/helpers/gateway-e2e-harness.ts:104`) sets `OPENCLAW_SKIP_PROVIDERS: "1"` — we must **not** set this for our tests
- The config written to disk at `configPath` controls everything — we need to write a config with `models.providers.ollama` and `agents.defaults.model` pointing at Ollama
- Gateway events (tool calls, final response) arrive over WebSocket, not the management API HTTP response
- The management API `/v1/management/sessions/send` only returns `{ runId, messageSeq }` — actual results come via events
- `connectGatewayClient` from `src/gateway/test-helpers.e2e.ts` handles the WS auth handshake
- Ollama tool_use produces `stopReason: "toolUse"` with `toolCall` content blocks (IDs are `ollama_call_<uuid>`)
- The Ollama stream function strips `/v1` from baseUrl automatically, always appends `/api/chat`

## Desired End State

A new e2e test file that:
1. Checks if Ollama is reachable at `http://127.0.0.1:11434` and that `qwen3:0.5b` is available — skips all tests if not
2. Spawns a real gateway process configured with Ollama as the sole provider
3. Creates a session via the management API targeting `ollama/qwen3:0.5b`
4. Sends prompts that require file tool usage (Read, Write, Edit)
5. Waits for the run to complete via WebSocket events
6. Verifies actual filesystem state after each operation
7. Cleans up all temp dirs and the gateway process

### Verification:
- `npm run test:e2e:ollama` runs the suite (or it's included in `test:e2e` with automatic skip)
- Tests pass when Ollama is running with qwen3:0.5b pulled
- Tests skip gracefully when Ollama is unavailable
- Each test verifies actual file contents on disk, not just response text

## What We're NOT Doing

- Not building a generic "provider registration framework" — Ollama plugin already exists
- Not testing every tool in the harness — focusing on Read, Write, Edit (the file tools)
- Not mocking anything — these are real e2e tests with a real LLM
- Not adding new provider plugin code — only test infrastructure
- Not modifying existing test configs or helpers

## Implementation Approach

Model the test infrastructure after the existing `test/helpers/gateway-e2e-harness.ts` pattern (spawn a real gateway child process), but:
- Write a config with Ollama as the provider instead of skipping providers
- Add an SSE/WebSocket event listener that waits for `chat` events with `state: "final"`
- Add an Ollama availability preflight check
- Use deterministic prompts that reliably trigger tool_use (e.g., "Read the file at /path/to/file.txt and report its exact contents")

---

## Phase 1: Ollama E2E Test Helpers

### Overview
Create the test infrastructure: Ollama availability check, gateway instance spawner with Ollama config, and event consumption utilities.

### Changes Required:

#### 1. Ollama Availability Helper
**File**: `test/helpers/ollama-e2e.ts`
**Changes**: New file with Ollama preflight and gateway spawner

```typescript
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = "qwen3:0.5b";
const OLLAMA_PREFLIGHT_TIMEOUT_MS = 5_000;

export { OLLAMA_BASE_URL, OLLAMA_MODEL };

/**
 * Check if Ollama is reachable and the target model is available.
 * Returns true if both conditions are met.
 */
export async function isOllamaAvailable(
  baseUrl = OLLAMA_BASE_URL,
  model = OLLAMA_MODEL,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PREFLIGHT_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = body.models ?? [];
      // Ollama model names may include `:latest` suffix
      return models.some(
        (m) =>
          m.name === model ||
          m.name === `${model}:latest` ||
          m.name?.startsWith(`${model}:`),
      );
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export type OllamaGatewayInstance = {
  port: number;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
};

/**
 * Spawn a gateway process configured with Ollama as the sole provider.
 * Creates a temp workspace directory for file tool operations.
 */
export async function spawnOllamaGatewayInstance(): Promise<OllamaGatewayInstance> {
  const port = await getFreePort();
  const gatewayToken = `gateway-ollama-${randomUUID()}`;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ollama-e2e-"));
  const configDir = path.join(homeDir, ".openclaw");
  const stateDir = path.join(configDir, "state");
  const workspaceDir = path.join(homeDir, "workspace");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const configPath = path.join(configDir, "openclaw.json");
  const config = {
    gateway: {
      port,
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        model: { primary: `ollama/${OLLAMA_MODEL}` },
        workspace: workspaceDir,
      },
    },
    models: {
      providers: {
        ollama: {
          baseUrl: OLLAMA_BASE_URL,
          api: "ollama",
          apiKey: "ollama-local",
          models: [
            {
              id: OLLAMA_MODEL,
              name: OLLAMA_MODEL,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const stdout: string[] = [];
  const stderr: string[] = [];
  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    child = spawn(
      "node",
      ["dist/index.js", "gateway", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_SKIP_CHANNELS: "1",
          // NOTE: Do NOT set OPENCLAW_SKIP_PROVIDERS — we need the Ollama provider active
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          VITEST: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => stdout.push(d));
    child.stderr?.on("data", (d: string) => stderr.push(d));

    await waitForPortOpen(child, stdout, stderr, port, 60_000);

    return { port, gatewayToken, homeDir, stateDir, configPath, workspaceDir, child, stdout, stderr };
  } catch (err) {
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    await fs.rm(homeDir, { recursive: true, force: true });
    throw err;
  }
}

export async function stopOllamaGatewayInstance(inst: OllamaGatewayInstance): Promise<void> {
  if (inst.child.exitCode === null && !inst.child.killed) {
    inst.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (inst.child.exitCode === null && !inst.child.killed) {
          try { inst.child.kill("SIGKILL"); } catch { /* ignore */ }
        }
        resolve();
      }, 3_000);
      inst.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  await fs.rm(inst.homeDir, { recursive: true, force: true });
}

/**
 * Send a management API request to the gateway.
 */
export async function managementPost(
  inst: OllamaGatewayInstance,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${inst.port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${inst.gatewayToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) };
}

/**
 * Subscribe to gateway SSE events and wait for the chat final event for a given runId.
 * Returns the final chat event payload.
 */
export async function waitForChatFinal(
  inst: OllamaGatewayInstance,
  runId: string,
  timeoutMs = 120_000,
): Promise<{ state: string; message?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/v1/management/events`, {
      headers: { authorization: `Bearer ${inst.gatewayToken}`, accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before final event");

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6)) as {
            event?: string;
            payload?: { runId?: string; state?: string; message?: unknown };
          };
          if (
            evt.event === "chat" &&
            evt.payload?.runId === runId &&
            (evt.payload?.state === "final" || evt.payload?.state === "error")
          ) {
            reader.cancel();
            return evt.payload as { state: string; message?: unknown };
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// --- internal helpers ---

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
}

async function waitForPortOpen(
  proc: ChildProcessWithoutNullStreams,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(
        `gateway exited before listening (code=${proc.exitCode})\n` +
        `stdout: ${chunksOut.join("")}\nstderr: ${chunksErr.join("")}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("error", (err) => { socket.destroy(); reject(err); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`timeout waiting for gateway on port ${port}`);
}
```

### Success Criteria:

#### Automated Verification:
- [ ] File compiles: `npx tsc --noEmit test/helpers/ollama-e2e.ts`
- [ ] `isOllamaAvailable()` returns `true` when Ollama is running with the model, `false` when not

#### Manual Verification:
- [ ] Start Ollama, pull qwen3:0.5b, verify the preflight detects it
- [ ] Stop Ollama, verify the preflight returns false without hanging

**Implementation Note**: After completing this phase and verifying the helpers compile and the preflight works, pause for manual confirmation before proceeding.

---

## Phase 2: E2E Test Suite — SDK File Tool Operations

### Overview
Create the main e2e test file that exercises Read, Write, and Edit tools through the full pipeline with Ollama.

### Changes Required:

#### 1. E2E Test File
**File**: `test/sdk-file-tools-ollama.e2e.test.ts`
**Changes**: New test file with full e2e tests

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type OllamaGatewayInstance,
  isOllamaAvailable,
  managementPost,
  spawnOllamaGatewayInstance,
  stopOllamaGatewayInstance,
  waitForChatFinal,
  OLLAMA_MODEL,
} from "./helpers/ollama-e2e.js";

// LLM responses are non-deterministic. Use generous timeouts and
// retry-friendly assertions. Each test gets up to 2 minutes for the
// full round trip (prompt → LLM → tool_use → tool execute → response).
const RUN_TIMEOUT_MS = 120_000;

let ollamaReady = false;

// Global preflight — skip entire suite if Ollama is not available
beforeAll(async () => {
  ollamaReady = await isOllamaAvailable();
}, 10_000);

describe.runIf(() => ollamaReady)("SDK file tools e2e with Ollama", () => {
  let gw: OllamaGatewayInstance;

  beforeAll(async () => {
    gw = await spawnOllamaGatewayInstance();
  }, 90_000);

  afterAll(async () => {
    if (gw) await stopOllamaGatewayInstance(gw);
  }, 15_000);

  /**
   * Helper: create a session, send a message, wait for final response.
   * Returns the assistant's final message content.
   */
  async function sendAndWait(message: string): Promise<string> {
    // Create session
    const createRes = await managementPost(gw, "/v1/management/sessions/create", {
      model: `ollama/${OLLAMA_MODEL}`,
    });
    expect(createRes.status).toBe(200);
    const sessionKey = (createRes.json as { result?: { key?: string } }).result?.key;
    expect(sessionKey).toBeDefined();

    // Start SSE listener BEFORE sending the message
    const sendRes = await managementPost(gw, "/v1/management/sessions/send", {
      key: sessionKey,
      message,
    });
    expect(sendRes.status).toBe(200);
    const runId = (sendRes.json as { result?: { runId?: string } }).result?.runId;
    expect(runId).toBeDefined();

    // Wait for final response
    const final = await waitForChatFinal(gw, runId!, RUN_TIMEOUT_MS);
    expect(final.state).toBe("final");

    // Extract text from final message
    const msg = final.message as { content?: Array<{ type: string; text?: string }> | string } | undefined;
    if (typeof msg?.content === "string") return msg.content;
    if (Array.isArray(msg?.content)) {
      return msg.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("\n");
    }
    return "";
  }

  it("reads a file and returns its contents", async () => {
    // Setup: create a file in the workspace
    const testFile = path.join(gw.workspaceDir, "hello.txt");
    await fs.writeFile(testFile, "The magic number is 8675309.", "utf8");

    // Send a prompt that should trigger the Read tool
    const response = await sendAndWait(
      `Read the file at ${testFile} and tell me the exact magic number in it. ` +
      `Reply with ONLY the number, nothing else. Do not use any tools other than the read tool.`,
    );

    // The LLM should have read the file and found the number
    expect(response).toContain("8675309");
  }, RUN_TIMEOUT_MS + 30_000);

  it("writes a new file with specified content", async () => {
    const targetFile = path.join(gw.workspaceDir, "written-by-llm.txt");

    // Send a prompt that should trigger the Write tool
    const response = await sendAndWait(
      `Write a file at ${targetFile} with the exact content: OLLAMA_WRITE_TEST_SUCCESS\n` +
      `Do not include any other content in the file. Just write exactly that string. ` +
      `After writing, confirm you wrote the file.`,
    );

    // Verify the file was actually created on disk
    const content = await fs.readFile(targetFile, "utf8");
    expect(content.trim()).toBe("OLLAMA_WRITE_TEST_SUCCESS");
  }, RUN_TIMEOUT_MS + 30_000);

  it("edits an existing file by replacing content", async () => {
    // Setup: create a file to edit
    const editFile = path.join(gw.workspaceDir, "to-edit.txt");
    await fs.writeFile(editFile, "The color is RED.", "utf8");

    // Send a prompt that should trigger the Edit tool
    const response = await sendAndWait(
      `Edit the file at ${editFile}. Replace the word "RED" with "BLUE". ` +
      `Use the edit tool to make this change. After editing, confirm the change was made.`,
    );

    // Verify the file was actually modified on disk
    const content = await fs.readFile(editFile, "utf8");
    expect(content).toContain("BLUE");
    expect(content).not.toContain("RED");
  }, RUN_TIMEOUT_MS + 30_000);

  it("reads, then edits based on file contents", async () => {
    // Setup: a file with structured content
    const dataFile = path.join(gw.workspaceDir, "data.txt");
    await fs.writeFile(
      dataFile,
      "name=TestProject\nversion=1.0.0\nstatus=draft",
      "utf8",
    );

    // Multi-step: read the file, then edit the version
    const response = await sendAndWait(
      `Read the file at ${dataFile}, then use the edit tool to change the version from "1.0.0" to "2.0.0". ` +
      `After editing, confirm the new version number.`,
    );

    // Verify the file was modified correctly
    const content = await fs.readFile(dataFile, "utf8");
    expect(content).toContain("version=2.0.0");
    expect(content).toContain("name=TestProject"); // other fields preserved
    expect(content).toContain("status=draft");      // other fields preserved
  }, RUN_TIMEOUT_MS + 30_000);
});
```

**Design notes:**
- `describe.runIf(() => ollamaReady)` skips the entire suite when Ollama is unavailable
- Each test creates a fresh session to avoid conversation history contamination
- File assertions check actual disk state, not LLM response text (though we check the response too as a sanity check)
- Generous timeouts (2+ minutes per test) because the LLM may be slow on CPU-only hardware
- Prompts are written to be as unambiguous as possible to maximize tool_use reliability with a small model
- The `sendAndWait` helper handles the full management API lifecycle: create session -> send message -> wait for SSE final event

### Success Criteria:

#### Automated Verification:
- [ ] File compiles cleanly
- [ ] Tests skip gracefully when Ollama is not running: `npx vitest run test/sdk-file-tools-ollama.e2e.test.ts`
- [ ] All 4 tests pass when Ollama is running with qwen3:0.5b

#### Manual Verification:
- [ ] Observe gateway stdout/stderr for tool_use dispatch logs during test runs
- [ ] Verify files are actually created/modified in the temp workspace (add `console.log(gw.workspaceDir)` temporarily)
- [ ] Confirm the tests don't leave orphan gateway processes after completion (check `ps aux | grep gateway`)

**Implementation Note**: After this phase passes automated verification, pause for manual confirmation that the file operations are real and the gateway cleans up properly.

---

## Phase 3: Vitest Config and npm Script

### Overview
Add a dedicated vitest config for the Ollama e2e tests and an npm script to run them.

### Changes Required:

#### 1. Vitest Config
**File**: `vitest.e2e-ollama.config.ts`
**Changes**: New config file extending the shared config

```typescript
import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "./vitest.shared.config.js";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ["test/sdk-file-tools-ollama.e2e.test.ts"],
    exclude: [],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    minWorkers: 1,
    setupFiles: [
      ...(Array.isArray(sharedVitestConfig.test?.setupFiles)
        ? sharedVitestConfig.test.setupFiles
        : sharedVitestConfig.test?.setupFiles
          ? [sharedVitestConfig.test.setupFiles]
          : []),
      "test/setup-openclaw-runtime.ts",
    ],
  },
});
```

#### 2. npm Script
**File**: `package.json`
**Changes**: Add `test:e2e:ollama` script

Add to the `scripts` section:
```json
"test:e2e:ollama": "node scripts/run-vitest.mjs run --config vitest.e2e-ollama.config.ts"
```

#### 3. Include in e2e config (optional skip)
**File**: `vitest.e2e.config.ts`
**Changes**: Add the Ollama test to the e2e include list so it runs with `npm run test:e2e` but auto-skips when Ollama is unavailable

Add `"test/sdk-file-tools-ollama.e2e.test.ts"` to the `include` array.

### Success Criteria:

#### Automated Verification:
- [ ] `npm run test:e2e:ollama` runs successfully (tests pass or skip)
- [ ] `npm run test:e2e` includes the new test file and it skips gracefully when Ollama isn't available
- [ ] No other test suites are affected

#### Manual Verification:
- [ ] Run `npm run test:e2e:ollama` with Ollama running — all tests pass
- [ ] Run `npm run test:e2e:ollama` with Ollama stopped — all tests skip, exit code 0
- [ ] Run `npm run test:e2e` — the new tests appear in the suite and skip/pass appropriately

---

## Testing Strategy

### What These Tests Verify (End-to-End):
1. **Config -> Provider Resolution**: The `models.providers.ollama` config is correctly resolved into a working provider
2. **Gateway -> Agent Pipeline**: `sessions.create` + `sessions.send` correctly routes through the embedded pi-agent
3. **LLM -> Tool Use**: Ollama (qwen3:0.5b) receives tool definitions and returns `tool_use` blocks
4. **Tool Dispatch -> Filesystem**: The harness correctly dispatches tool calls to `Read`/`Write`/`Edit` implementations that perform real filesystem I/O
5. **Result Flow -> Client**: The final response arrives back via SSE events with the correct state

### What We're NOT Testing:
- Individual tool implementation correctness (already covered by unit tests)
- Provider discovery/auto-detection (already covered by `models-config.providers.ollama*.test.ts`)
- Transport parsing details (already covered by stream tests)
- Auth flows (using `auth: "none"` / token auth for simplicity)

### Edge Cases Handled:
- Ollama not running → tests skip
- Model not pulled → tests skip (detected by preflight)
- LLM timeout → test fails with clear timeout error
- Gateway crash → `afterAll` cleanup via SIGKILL fallback
- Temp directory leak → `fs.rm(homeDir, { recursive: true })` in all paths

## Performance Considerations

- **qwen3:0.5b** is chosen for speed — small enough to run on CPU in seconds
- **Single worker** (`maxWorkers: 1`) — these are heavy tests, no parallelism needed
- **One gateway per suite** (not per test) — avoids repeated process startup cost
- **Fresh session per test** — avoids conversation history contamination while reusing the gateway
- **120s timeout per run** — generous for CPU-only inference; can be tuned down for GPU systems
- **Preflight is fast** (5s timeout on `/api/tags`) — doesn't slow down the skip path

## References

- Existing gateway e2e harness: `test/helpers/gateway-e2e-harness.ts`
- Management API endpoint tests: `src/gateway/server.management-api.endpoints.e2e.test.ts`
- Ollama provider plugin: `extensions/ollama/src/stream.ts`
- Ollama discovery tests: `src/agents/models-config.providers.ollama-autodiscovery.test.ts`
- Tool creation: `src/agents/pi-tools.ts:215` (`createOpenClawCodingTools`)
- Tool wrappers: `src/agents/pi-tools.read.ts` (`createOpenClawReadTool`, `createHostWorkspaceWriteTool`, `createHostWorkspaceEditTool`)
