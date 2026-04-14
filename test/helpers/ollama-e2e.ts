import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type GatewayHandle,
  serve,
} from "../../src/gateway/serve.js";

// Warm the gateway server module graph at helper-import time so the first
// serve() call doesn't pay the ~90s dynamic-import cost during vitest's
// default 90s beforeAll timeout. Subsequent serve() calls reuse the cached
// module graph.
await import("../../src/gateway/server.js");

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const OLLAMA_PREFLIGHT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const getFreePort = async (): Promise<number> => {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
};

// Env vars the in-process gateway needs configured — either to point at our
// temp config/state dirs, to keep startup minimal, or to override the
// vitest-harness flags that would otherwise make the gateway behave like a
// running test-mock rather than a live server with a real provider.
const ENV_KEYS_TO_OVERRIDE = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_GATEWAY_MANAGEMENT_API",
  "VITEST",
  "OPENCLAW_TEST_FAST",
  "OPENCLAW_STRICT_FAST_REPLY_CONFIG",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
] as const;

type EnvSnapshot = Record<(typeof ENV_KEYS_TO_OVERRIDE)[number], string | undefined>;

function captureEnvSnapshot(): EnvSnapshot {
  const snap = {} as EnvSnapshot;
  for (const key of ENV_KEYS_TO_OVERRIDE) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnvSnapshot(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS_TO_OVERRIDE) {
    const prev = snap[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type OllamaModel = {
  id: string;
  name: string;
  contextWindow: number;
};

/**
 * Query the local Ollama instance and return the first available model,
 * or null if Ollama is unreachable or has no models pulled.
 */
export async function discoverOllamaModel(
  baseUrl = OLLAMA_BASE_URL,
): Promise<OllamaModel | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_PREFLIGHT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return null;

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    if (models.length === 0) return null;

    // Prefer qwen3.5:9b when available — smaller models are unreliable at the
    // tool-calling patterns these tests require.
    const preferred = models.find((m) => m.name === "qwen3.5:9b");
    const picked = preferred ?? models[0]!;

    // Try to get context window from /api/show
    let contextWindow = 32768;
    try {
      const showController = new AbortController();
      const showTimer = setTimeout(() => showController.abort(), OLLAMA_PREFLIGHT_TIMEOUT_MS);
      try {
        const showRes = await fetch(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: picked.name }),
          signal: showController.signal,
        });
        if (showRes.ok) {
          const showData = (await showRes.json()) as {
            model_info?: Record<string, unknown>;
          };
          const ctxLen = showData.model_info?.["*.context_length"];
          if (typeof ctxLen === "number" && ctxLen > 0) {
            contextWindow = ctxLen;
          }
        }
      } finally {
        clearTimeout(showTimer);
      }
    } catch {
      // fall back to default
    }

    return { id: picked.name, name: picked.name, contextWindow };
  } catch {
    return null;
  }
}

export type OllamaGatewayInstance = {
  port: number;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  workspaceDir: string;
  model: OllamaModel;
  handle: GatewayHandle;
  envSnapshot: EnvSnapshot;
};

/**
 * Start an in-process gateway configured to use a local Ollama provider.
 * The caller must pass a discovered model from `discoverOllamaModel()`.
 * Optional `extraConfig` is merged into the gateway config (e.g. for clawify custom tools).
 *
 * Uses the `serve()` SDK instead of spawning `clawify serve` as a child process.
 * The returned handle's `stop()` shuts the gateway down cleanly; `stopOllamaGatewayInstance`
 * additionally restores the pre-call env and removes the temp directory.
 */
export async function spawnOllamaGatewayInstance(
  model: OllamaModel,
  extraConfig?: Record<string, unknown>,
): Promise<OllamaGatewayInstance> {
  const port = await getFreePort();
  const gatewayToken = `ollama-gateway-${randomUUID()}`;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ollama-e2e-"));
  const configDir = path.join(homeDir, ".openclaw");
  const stateDir = path.join(homeDir, "state");
  const workspaceDir = path.join(homeDir, "workspace");

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const configPath = path.join(configDir, "openclaw.json");

  const config = {
    gateway: {
      port,
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        model: { primary: `ollama/${model.id}` },
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
              id: model.id,
              name: model.name,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: model.contextWindow,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    ...extraConfig,
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const envSnapshot = captureEnvSnapshot();

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_GATEWAY_MANAGEMENT_API = "1";
  // VITEST=1 + OPENCLAW_TEST_MINIMAL_GATEWAY=1 trips the minimalTestGateway branch
  // in server.impl.ts, which skips the sidecar/channel startup phase that would
  // otherwise keep startGatewayServer awaiting for tens of seconds even with
  // OPENCLAW_SKIP_CHANNELS set. With it, serve() resolves promptly after the
  // management API is bound — providers are still loaded because plugin
  // bootstrap runs earlier than sidecars.
  process.env.VITEST = "1";
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
  // Clear OPENCLAW_TEST_FAST so config/path resolution honours our temp
  // OPENCLAW_CONFIG_PATH/OPENCLAW_STATE_DIR instead of diverting to the
  // test-fast paths set by vitest's global test-env setup.
  process.env.OPENCLAW_TEST_FAST = "";
  process.env.OPENCLAW_STRICT_FAST_REPLY_CONFIG = "";
  process.env.OPENCLAW_SKIP_PROVIDERS = "";

  let handle: GatewayHandle | null = null;
  try {
    handle = await serve({
      port,
      bind: "loopback",
      auth: { mode: "none" },
      allowUnconfigured: true,
    });

    return {
      port,
      gatewayToken,
      homeDir,
      stateDir,
      configPath,
      workspaceDir,
      model,
      handle,
      envSnapshot,
    };
  } catch (err) {
    if (handle) {
      try {
        await handle.stop({ reason: "startup-failure" });
      } catch {
        // ignore
      }
    }
    restoreEnvSnapshot(envSnapshot);
    try {
      await fs.rm(homeDir, { recursive: true, force: true });
    } catch {
      // ignore — files may still be locked on Windows
    }
    throw err;
  }
}

/**
 * Gracefully stop an Ollama gateway instance, restore the pre-start env,
 * and remove its temp directory.
 */
export async function stopOllamaGatewayInstance(inst: OllamaGatewayInstance): Promise<void> {
  try {
    await inst.handle.stop({ reason: "test cleanup" });
  } catch {
    // ignore — tests should still proceed to cleanup
  }

  restoreEnvSnapshot(inst.envSnapshot);

  try {
    await fs.rm(inst.homeDir, { recursive: true, force: true });
  } catch {
    // On Windows, files may still be locked briefly after shutdown
  }
}

/**
 * POST JSON to the management API of a running gateway instance.
 */
export async function managementPost(
  inst: OllamaGatewayInstance,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${inst.port}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let json: unknown = null;
  const text = await res.text();
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  return { status: res.status, json };
}

/**
 * Poll the session transcript JSONL file until a final assistant message appears.
 * Returns the assistant message text content.
 *
 * The transcript is a newline-delimited JSON file where each line is one of:
 *   { type: "session", ... }
 *   { message: { role: "user"|"assistant", content: ... } }
 *   { type: "usage", ... }
 */
export async function waitForAssistantReply(
  sessionFile: string,
  timeoutMs = 120_000,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await fs.readFile(sessionFile, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);

      // Walk backwards to find the last assistant message.
      // The run is complete when there's an assistant message after the user message.
      let foundUser = false;
      let lastAssistantText = "";

      for (const line of lines) {
        let entry: { message?: { role?: string; content?: unknown }; type?: string };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }

        if (entry.message?.role === "user") {
          foundUser = true;
          lastAssistantText = "";
        }
        if (entry.message?.role === "assistant" && foundUser) {
          const content = entry.message.content;
          if (typeof content === "string") {
            lastAssistantText = content;
          } else if (Array.isArray(content)) {
            lastAssistantText = (content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text!)
              .join("\n");
          }
        }
      }

      if (foundUser && lastAssistantText.length > 0) {
        return lastAssistantText;
      }
    } catch {
      // File may not exist yet or be partially written
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`timeout (${timeoutMs}ms) waiting for assistant reply in ${sessionFile}`);
}

// ---------------------------------------------------------------------------
// Custom tool test server
// ---------------------------------------------------------------------------

export type ToolServer = {
  port: number;
  url: string;
  server: http.Server;
  close: () => Promise<void>;
};

/**
 * Start a tiny HTTP server that responds to POST requests with a fixed body.
 * Useful for testing custom tool registration — the LLM calls the tool,
 * hits this server, and gets the response body back.
 */
export async function startToolServer(responseBody: string): Promise<ToolServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(responseBody);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind tool server"));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
