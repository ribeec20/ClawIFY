import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { handleManagementHttpRequest } from "./management-http.js";

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: vi.fn(),
  resolveOpenAiCompatibleHttpOperatorScopes: vi.fn(),
  getBearerToken: vi.fn(),
}));

vi.mock("./http-common.js", () => ({
  readJsonBodyOrError: vi.fn(),
  sendJson: vi.fn(),
  setSseHeaders: vi.fn(),
  watchClientDisconnect: vi.fn(() => () => undefined),
}));

const { authorizeGatewayHttpRequestOrReply, resolveOpenAiCompatibleHttpOperatorScopes } =
  await import("./http-utils.js");
const { readJsonBodyOrError, sendJson } = await import("./http-common.js");

function createRequest(path: string, method: string): IncomingMessage {
  return {
    url: path,
    method,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("handleManagementHttpRequest", () => {
  beforeEach(() => {
    vi.mocked(authorizeGatewayHttpRequestOrReply).mockResolvedValue({
      trustDeclaredOperatorScopes: true,
    });
    vi.mocked(resolveOpenAiCompatibleHttpOperatorScopes).mockReturnValue([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ]);
    vi.mocked(readJsonBodyOrError).mockResolvedValue({});
    vi.mocked(sendJson).mockReset();
  });

  it("maps management routes to gateway methods", async () => {
    const invokeGatewayMethod = vi.fn(async () => ({ ok: true, payload: { ok: true } }));

    await handleManagementHttpRequest(
      createRequest("/v1/management/sessions/send", "POST"),
      {} as ServerResponse,
      {
        auth: { mode: "none", allowTailscale: false },
        invokeGatewayMethod,
        hostLifecycle: {
          status: async () => ({}),
          probe: async () => ({}),
          install: async () => ({}),
          start: async () => ({}),
          stop: async () => ({}),
          restart: async () => ({}),
          uninstall: async () => ({}),
        },
      },
    );

    expect(invokeGatewayMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.send",
      }),
    );
  });

  it("enforces route-level scope checks", async () => {
    vi.mocked(resolveOpenAiCompatibleHttpOperatorScopes).mockReturnValue([]);
    const invokeGatewayMethod = vi.fn(async () => ({ ok: true, payload: { ok: true } }));

    await handleManagementHttpRequest(
      createRequest("/v1/management/sessions/send", "POST"),
      {} as ServerResponse,
      {
        auth: { mode: "none", allowTailscale: false },
        invokeGatewayMethod,
        hostLifecycle: {
          status: async () => ({}),
          probe: async () => ({}),
          install: async () => ({}),
          start: async () => ({}),
          stop: async () => ({}),
          restart: async () => ({}),
          uninstall: async () => ({}),
        },
      },
    );

    expect(invokeGatewayMethod).not.toHaveBeenCalled();
    expect(vi.mocked(sendJson)).toHaveBeenCalledWith(
      expect.anything(),
      403,
      expect.objectContaining({
        ok: false,
      }),
    );
  });

  it("returns credential summaries without raw secret values", async () => {
    const invokeGatewayMethod = vi.fn(async () => ({
      ok: true,
      payload: {
        config: {
          gateway: {
            auth: {
              token: REDACTED_SENTINEL,
            },
          },
          providers: {
            demo: {
              apiKey: "raw-secret-value",
            },
          },
        },
      },
    }));

    await handleManagementHttpRequest(
      createRequest("/v1/management/credentials", "GET"),
      {} as ServerResponse,
      {
        auth: { mode: "none", allowTailscale: false },
        invokeGatewayMethod,
        hostLifecycle: {
          status: async () => ({}),
          probe: async () => ({}),
          install: async () => ({}),
          start: async () => ({}),
          stop: async () => ({}),
          restart: async () => ({}),
          uninstall: async () => ({}),
        },
      },
    );

    const payload = vi.mocked(sendJson).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("raw-secret-value");
    expect(JSON.stringify(payload)).toContain("gateway.auth.token");
  });

  it("routes host lifecycle actions through the host adapter", async () => {
    const hostLifecycle = {
      status: vi.fn(async () => ({})),
      probe: vi.fn(async () => ({})),
      install: vi.fn(async () => ({})),
      start: vi.fn(async () => ({ started: true })),
      stop: vi.fn(async () => ({})),
      restart: vi.fn(async () => ({})),
      uninstall: vi.fn(async () => ({})),
    };

    await handleManagementHttpRequest(
      createRequest("/v1/management/host/start", "POST"),
      {} as ServerResponse,
      {
        auth: { mode: "none", allowTailscale: false },
        invokeGatewayMethod: async () => ({ ok: true, payload: {} }),
        hostLifecycle,
      },
    );

    expect(hostLifecycle.start).toHaveBeenCalledTimes(1);
  });
});
