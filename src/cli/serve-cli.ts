import type { Command } from "commander";
import { addGatewayRunCommand, runGatewayCommand, type GatewayRunOpts } from "./gateway-cli/run.js";

function withEnvOverride(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[key];
  process.env[key] = value;
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = previous;
  });
}

export function registerServeCli(program: Command) {
  const serve = addGatewayRunCommand(
    program
      .command("serve")
      .description("Run OpenClaw in headless API mode (Gateway + management API)"),
  );

  serve.action(async (opts) => {
    const runOpts: GatewayRunOpts = {
      ...(opts as GatewayRunOpts),
      profile: "api-only",
    };

    await withEnvOverride("OPENCLAW_GATEWAY_PROFILE", "api-only", async () => {
      await withEnvOverride("OPENCLAW_GATEWAY_MANAGEMENT_API", "1", async () => {
        await runGatewayCommand(runOpts);
      });
    });
  });
}
