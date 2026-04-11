import { Writable } from "node:stream";
import { gatherDaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import { readBestEffortConfig, resolveGatewayPort } from "../config/config.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  startGatewayService,
} from "../daemon/service.js";

const DEV_NULL = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

type HostInstallParams = {
  port?: number;
  runtime?: string;
};

function parsePositivePort(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  throw new Error("invalid port");
}

function resolveInstallRuntime(raw: unknown) {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!normalized) {
    return DEFAULT_GATEWAY_DAEMON_RUNTIME;
  }
  if (!isGatewayDaemonRuntime(normalized)) {
    throw new Error(`invalid runtime "${String(raw)}"`);
  }
  return normalized;
}

export type HostManagerLifecycleAdapter = {
  status: () => Promise<unknown>;
  probe: () => Promise<unknown>;
  install: (params: HostInstallParams) => Promise<unknown>;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  restart: () => Promise<unknown>;
  uninstall: () => Promise<unknown>;
};

export function createHostManagerLifecycleAdapter(): HostManagerLifecycleAdapter {
  const service = resolveGatewayService();

  return {
    status: async () => {
      const state = await readGatewayServiceState(service, { env: process.env });
      return {
        service: service.label,
        state,
      };
    },
    probe: async () => {
      return await gatherDaemonStatus({
        rpc: { json: true, timeout: "5000" },
        probe: true,
        deep: false,
      });
    },
    install: async (params) => {
      const cfg = await readBestEffortConfig();
      const port = parsePositivePort(params.port) ?? resolveGatewayPort(cfg, process.env);
      const runtime = resolveInstallRuntime(params.runtime);
      const plan = await buildGatewayInstallPlan({
        env: process.env,
        port,
        runtime,
        config: cfg,
      });
      await service.install({
        env: process.env,
        stdout: DEV_NULL,
        programArguments: plan.programArguments,
        workingDirectory: plan.workingDirectory,
        environment: plan.environment,
      });
      const state = await readGatewayServiceState(service, { env: process.env });
      return {
        service: service.label,
        runtime,
        port,
        state,
      };
    },
    start: async () => {
      const result = await startGatewayService(service, { env: process.env, stdout: DEV_NULL });
      return {
        service: service.label,
        result,
      };
    },
    stop: async () => {
      await service.stop({ env: process.env, stdout: DEV_NULL });
      const state = await readGatewayServiceState(service, { env: process.env });
      return {
        service: service.label,
        state,
      };
    },
    restart: async () => {
      const result = await service.restart({ env: process.env, stdout: DEV_NULL });
      const state = await readGatewayServiceState(service, { env: process.env });
      return {
        service: service.label,
        result,
        state,
      };
    },
    uninstall: async () => {
      await service.uninstall({ env: process.env, stdout: DEV_NULL });
      const state = await readGatewayServiceState(service, { env: process.env });
      return {
        service: service.label,
        state,
      };
    },
  };
}
