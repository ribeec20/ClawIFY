import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

let configState: OpenClawConfig = {};

vi.mock("../../config/config.js", () => ({
  loadConfig: () => configState,
  writeConfigFile: async (nextConfig: OpenClawConfig) => {
    configState = nextConfig;
  },
}));

const { clawifyHandlers } = await import("./clawify.js");

function createHandlerOptions(params: Record<string, unknown>) {
  const responses: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
  return {
    options: {
      params,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (ok: boolean, payload: unknown, error?: unknown) => {
        responses.push({ ok, payload, error });
      },
    },
    responses,
  };
}

describe("clawify handlers", () => {
  beforeEach(() => {
    configState = {};
  });

  it("creates an instance and lists it", async () => {
    const upsertCall = createHandlerOptions({
      instanceId: "app-1",
      config: {
        tools: {
          alsoAllow: ["read"],
        },
      },
    });
    await clawifyHandlers["clawify.instance.upsert"](upsertCall.options);
    expect(upsertCall.responses.at(-1)?.ok).toBe(true);

    const listCall = createHandlerOptions({});
    await clawifyHandlers["clawify.instances.list"](listCall.options);
    expect(listCall.responses.at(-1)?.payload).toEqual(
      expect.objectContaining({
        defaultInstanceId: "app-1",
        instances: [{ id: "app-1" }],
      }),
    );
  });

  it("upserts and reads user config", async () => {
    await clawifyHandlers["clawify.instance.upsert"](
      createHandlerOptions({
        instanceId: "app-2",
        config: {},
      }).options,
    );

    const userUpsertCall = createHandlerOptions({
      instanceId: "app-2",
      userId: "user-1",
      config: {
        tools: {
          alsoAllow: ["write"],
        },
      },
    });
    await clawifyHandlers["clawify.user.upsert"](userUpsertCall.options);
    expect(userUpsertCall.responses.at(-1)?.ok).toBe(true);

    const userGetCall = createHandlerOptions({
      instanceId: "app-2",
      userId: "user-1",
    });
    await clawifyHandlers["clawify.user.get"](userGetCall.options);
    expect(userGetCall.responses.at(-1)?.payload).toEqual(
      expect.objectContaining({
        instanceId: "app-2",
        userId: "user-1",
        config: expect.objectContaining({
          tools: expect.objectContaining({
            alsoAllow: ["write"],
          }),
        }),
      }),
    );
  });
});
