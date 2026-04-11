import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

let configState: OpenClawConfig = {};

vi.mock("../../config/config.js", () => ({
  loadConfig: () => configState,
  writeConfigFile: async (nextConfig: OpenClawConfig) => {
    configState = nextConfig;
  },
}));

const { toolsUpdateHandlers } = await import("./tools-update.js");

function invokeToolsUpdate(params: Record<string, unknown>) {
  const responses: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
  return Promise.resolve(
    toolsUpdateHandlers["tools.update"]({
      params,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (ok, payload, error) => {
        responses.push({ ok, payload, error });
      },
    }),
  ).then(() => responses.at(-1));
}

describe("tools.update", () => {
  beforeEach(() => {
    configState = {};
  });

  it("updates global tools policy", async () => {
    const response = await invokeToolsUpdate({
      alsoAllow: ["read", "write"],
      deny: ["exec"],
    });
    expect(response?.ok).toBe(true);
    expect(configState.tools).toEqual(
      expect.objectContaining({
        alsoAllow: ["read", "write"],
        deny: ["exec"],
      }),
    );
  });

  it("extends user tools when instance policy is allowlist-extend", async () => {
    configState = {
      clawify: {
        defaultInstanceId: "app-1",
        instances: {
          "app-1": {
            userPolicy: {
              tools: "allowlist-extend",
            },
          },
        },
      },
    };
    const response = await invokeToolsUpdate({
      instanceId: "app-1",
      userId: "user-1",
      allow: ["write"],
    });
    expect(response?.ok).toBe(true);
    expect(
      configState.clawify?.instances?.["app-1"]?.users?.["user-1"]?.tools?.alsoAllow,
    ).toEqual(["write"]);
  });
});
