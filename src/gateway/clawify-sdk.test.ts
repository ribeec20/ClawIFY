import { describe, expect, it, vi } from "vitest";
import { clawify, createClawify } from "./clawify-sdk.js";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function readBodyObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "string") {
    throw new Error("request body should be a JSON string");
  }
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body should parse as an object");
  }
  return parsed as Record<string, unknown>;
}

describe("clawify-sdk", () => {
  it("posts scoped user tools updates to the management API", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          ok: true,
        },
      }),
    );
    const client = createClawify({
      token: "token-123",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.user("instance-a", "user-a").updateTools({
      alsoAllow: ["write"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18789/v1/management/tools/update");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    expect(readBodyObject(init.body)).toEqual({
      instanceId: "instance-a",
      userId: "user-a",
      alsoAllow: ["write"],
    });
  });

  it("upserts user mcp config when user config does not exist yet", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(502, {
          ok: false,
          error: {
            code: "invalid_request",
            message: 'unknown clawify user "user-a" in instance "instance-a"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            ok: true,
            instanceId: "instance-a",
            userId: "user-a",
          },
        }),
      );
    const client = createClawify({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.user("instance-a", "user-a").setMcpServer("docs", {
      url: "https://mcp.example.com/sse",
      transport: "sse",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(
      "http://127.0.0.1:18789/v1/management/clawify/users/get?instanceId=instance-a&userId=user-a",
    );
    const [upsertUrl, upsertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(upsertUrl).toBe("http://127.0.0.1:18789/v1/management/clawify/users/upsert");
    expect(readBodyObject(upsertInit.body)).toEqual({
      instanceId: "instance-a",
      userId: "user-a",
      config: {
        mcp: {
          servers: {
            docs: {
              url: "https://mcp.example.com/sse",
              transport: "sse",
            },
          },
        },
      },
    });
  });

  it("supports clawify.instance(...).user(...).prompt(...) with scoped sessions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            key: "session-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            runId: "run-1",
            messageSeq: 7,
          },
        }),
      );

    const agent = clawify
      .instance("instance-a", {
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
      .user("user-a");

    const promptResult = await agent.prompt("edit the file", {
      model: "mock/noop-model",
      timeoutMs: 3_000,
    });

    expect(promptResult).toEqual({
      key: "session-1",
      runId: "run-1",
      messageSeq: 7,
      status: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe("http://127.0.0.1:18789/v1/management/sessions/create");
    expect(readBodyObject(createInit.body)).toEqual({
      model: "mock/noop-model",
      instanceId: "instance-a",
      userId: "user-a",
    });

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe("http://127.0.0.1:18789/v1/management/sessions/send");
    expect(readBodyObject(sendInit.body)).toEqual({
      key: "session-1",
      message: "edit the file",
      timeoutMs: 3_000,
      instanceId: "instance-a",
      userId: "user-a",
    });
  });
});
