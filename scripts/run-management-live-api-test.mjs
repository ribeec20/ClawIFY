#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const args = process.argv.slice(2);

let reuseExisting = false;
const forwardedArgs = [];
for (const arg of args) {
  if (arg === "--reuse-existing") {
    reuseExisting = true;
    continue;
  }
  forwardedArgs.push(arg);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve free port")));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForManagementApiReady(baseUrl, timeoutMs, getLogs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "gateway did not become ready";

  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${baseUrl}/health`);
      if (health.status !== 200) {
        lastError = `health status=${health.status}`;
        await delay(500);
        continue;
      }

      const management = await fetch(`${baseUrl}/v1/management`);
      const contentType = management.headers.get("content-type") || "";
      const body = await management.text();
      if (management.status !== 200) {
        lastError = `management status=${management.status}`;
        await delay(500);
        continue;
      }
      if (!contentType.includes("application/json")) {
        lastError = `management content-type=${contentType}`;
        await delay(500);
        continue;
      }
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && parsed.ok === true) {
        return;
      }
      lastError = "management response missing ok=true";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }

  const logs = getLogs();
  const logBlock = logs.length > 0 ? `\nGateway logs:\n${logs.join("\n")}` : "";
  throw new Error(`Timed out waiting for management API readiness: ${lastError}${logBlock}`);
}

function runLiveTest(env) {
  const child = spawnSync(
    process.execPath,
    [
      "scripts/test-live.mjs",
      "--",
      "src/gateway/server.management-api.live.test.ts",
      ...forwardedArgs,
    ],
    {
      stdio: "inherit",
      env,
    },
  );
  if (child.error) {
    throw child.error;
  }
  return child.status ?? 1;
}

async function stopGateway(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
  }
}

async function main() {
  const baseEnv = {
    ...process.env,
    OPENCLAW_LIVE_MANAGEMENT_API: process.env.OPENCLAW_LIVE_MANAGEMENT_API || "1",
  };

  if (reuseExisting || process.env.OPENCLAW_LIVE_MANAGEMENT_BASE_URL?.trim()) {
    const status = runLiveTest(baseEnv);
    process.exit(status);
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const gatewayLogs = [];
  const maxGatewayLogLines = 120;
  const keepLogLine = (line) => {
    if (!line) {
      return;
    }
    gatewayLogs.push(line);
    if (gatewayLogs.length > maxGatewayLogLines) {
      gatewayLogs.splice(0, gatewayLogs.length - maxGatewayLogLines);
    }
  };
  const appendLogs = (chunk) => {
    const text = String(chunk ?? "");
    for (const line of text.split(/\r?\n/)) {
      keepLogLine(line.trim());
    }
    if (process.env.OPENCLAW_LIVE_MANAGEMENT_GATEWAY_LOGS === "1") {
      process.stderr.write(text);
    }
  };

  const gatewayChild = spawn(
    process.execPath,
    [
      "scripts/run-node.mjs",
      "serve",
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--allow-unconfigured",
      "--port",
      String(port),
      "--force",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_MANAGEMENT_API: "1",
        OPENCLAW_GATEWAY_PROFILE: "api-only",
      },
    },
  );
  gatewayChild.stdout?.on("data", appendLogs);
  gatewayChild.stderr?.on("data", appendLogs);

  const onSigint = async () => {
    await stopGateway(gatewayChild);
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  try {
    await waitForManagementApiReady(baseUrl, 90_000, () => gatewayLogs);
    const status = runLiveTest({
      ...baseEnv,
      OPENCLAW_LIVE_MANAGEMENT_BASE_URL: baseUrl,
      OPENCLAW_LIVE_MANAGEMENT_TOKEN: "",
    });
    process.exit(status);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    await stopGateway(gatewayChild);
  }
}

await main();
