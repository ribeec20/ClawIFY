import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostManagerLifecycleAdapter } from "./management-host.js";

const mocks = vi.hoisted(() => {
  const service = {
    label: "systemd",
    install: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => ({ outcome: "completed" as const })),
    uninstall: vi.fn(async () => undefined),
  };
  return {
    service,
    readBestEffortConfig: vi.fn(async () => ({})),
    resolveGatewayPort: vi.fn(() => 18789),
    buildGatewayInstallPlan: vi.fn(async () => ({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    })),
    resolveGatewayService: vi.fn(() => service),
    readGatewayServiceState: vi.fn(async () => ({
      installed: true,
      loaded: true,
      running: true,
      env: process.env,
      command: null,
    })),
    startGatewayService: vi.fn(async () => ({ outcome: "started", state: { running: true } })),
    gatherDaemonStatus: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("../config/config.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
  readGatewayServiceState: mocks.readGatewayServiceState,
  startGatewayService: mocks.startGatewayService,
}));

vi.mock("../cli/daemon-cli/status.gather.js", () => ({
  gatherDaemonStatus: mocks.gatherDaemonStatus,
}));

describe("createHostManagerLifecycleAdapter", () => {
  beforeEach(() => {
    mocks.service.install.mockClear();
    mocks.service.stop.mockClear();
    mocks.service.restart.mockClear();
    mocks.service.uninstall.mockClear();
    mocks.resolveGatewayPort.mockClear();
    mocks.buildGatewayInstallPlan.mockClear();
    mocks.readGatewayServiceState.mockClear();
    mocks.startGatewayService.mockClear();
    mocks.gatherDaemonStatus.mockClear();
  });

  it("installs through daemon service interfaces", async () => {
    const adapter = createHostManagerLifecycleAdapter();
    await adapter.install({ port: 18888, runtime: "node" });

    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 18888,
        runtime: "node",
      }),
    );
    expect(mocks.service.install).toHaveBeenCalledTimes(1);
  });

  it("starts through startGatewayService", async () => {
    const adapter = createHostManagerLifecycleAdapter();
    const result = await adapter.start();

    expect(mocks.startGatewayService).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        service: "systemd",
      }),
    );
  });

  it("returns status and probe payloads", async () => {
    const adapter = createHostManagerLifecycleAdapter();
    const status = await adapter.status();
    const probe = await adapter.probe();

    expect(status).toEqual(
      expect.objectContaining({
        service: "systemd",
      }),
    );
    expect(probe).toEqual({ ok: true });
    expect(mocks.gatherDaemonStatus).toHaveBeenCalledTimes(1);
  });
});
