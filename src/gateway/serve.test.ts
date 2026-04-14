import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type GatewayHandle,
  type ProgressEvent,
  ServeOptionsError,
  serve,
} from "./serve.js";

type MockGatewayServer = {
  close: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  startGatewayServer: vi.fn<(port: number, opts: unknown) => Promise<MockGatewayServer>>(),
}));

vi.mock("./server.js", async () => ({
  startGatewayServer: mocks.startGatewayServer,
}));

function stubServer(): MockGatewayServer {
  return { close: vi.fn<() => Promise<void>>(async () => {}) };
}

describe("serve", () => {
  describe("validation rejections", () => {
    it("rejects non-loopback bind without auth", async () => {
      mocks.startGatewayServer.mockClear();
      await expect(serve({ bind: "lan" })).rejects.toBeInstanceOf(ServeOptionsError);
      expect(mocks.startGatewayServer).not.toHaveBeenCalled();
    });

    it("rejects invalid port before importing gateway module", async () => {
      mocks.startGatewayServer.mockClear();
      await expect(serve({ port: -1 })).rejects.toBeInstanceOf(ServeOptionsError);
      expect(mocks.startGatewayServer).not.toHaveBeenCalled();
    });

    it("rejects unknown profile", async () => {
      mocks.startGatewayServer.mockClear();
      await expect(
        serve({ profile: "bogus" as unknown as "api-only" }),
      ).rejects.toBeInstanceOf(ServeOptionsError);
    });
  });

  describe("handle and defaults", () => {
    it("applies api-only profile and managementApiEnabled=true by default", async () => {
      mocks.startGatewayServer.mockReset();
      mocks.startGatewayServer.mockResolvedValueOnce(stubServer());

      await serve({ port: 20001 });

      expect(mocks.startGatewayServer).toHaveBeenCalledWith(
        20001,
        expect.objectContaining({ profile: "api-only", managementApiEnabled: true }),
      );
    });

    it("does not override caller-provided profile or managementApiEnabled", async () => {
      mocks.startGatewayServer.mockReset();
      mocks.startGatewayServer.mockResolvedValueOnce(stubServer());

      await serve({ port: 20002, profile: "default", managementApiEnabled: false });

      expect(mocks.startGatewayServer).toHaveBeenCalledWith(
        20002,
        expect.objectContaining({ profile: "default", managementApiEnabled: false }),
      );
    });

    it("returns a handle with loopback address when bind is loopback", async () => {
      mocks.startGatewayServer.mockReset();
      mocks.startGatewayServer.mockResolvedValueOnce(stubServer());

      const gw = await serve({ port: 20003, bind: "loopback" });

      expect(gw.port).toBe(20003);
      expect(gw.address).toEqual({ host: "127.0.0.1", port: 20003 });
    });

    it("uses explicit host when provided", async () => {
      mocks.startGatewayServer.mockReset();
      mocks.startGatewayServer.mockResolvedValueOnce(stubServer());

      const gw = await serve({
        port: 20004,
        bind: "custom",
        host: "10.0.0.5",
        auth: { mode: "token", token: "t" },
      });

      expect(gw.address).toEqual({ host: "10.0.0.5", port: 20004 });
    });
  });

  describe("stop", () => {
    it("delegates to server.close with the given reason", async () => {
      mocks.startGatewayServer.mockReset();
      const server = stubServer();
      mocks.startGatewayServer.mockResolvedValueOnce(server);

      const gw = await serve({ port: 20005 });
      await gw.stop({ reason: "test" });

      expect(server.close).toHaveBeenCalledWith({ reason: "test" });
    });

    it("is idempotent — second stop() does not call close() twice", async () => {
      mocks.startGatewayServer.mockReset();
      const server = stubServer();
      mocks.startGatewayServer.mockResolvedValueOnce(server);

      const gw = await serve({ port: 20006 });
      await gw.stop();
      await gw.stop();

      expect(server.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("onProgress", () => {
    it("emits loading-modules, starting-server, ready in order", async () => {
      mocks.startGatewayServer.mockReset();
      mocks.startGatewayServer.mockResolvedValueOnce(stubServer());

      const events: ProgressEvent[] = [];
      await serve({ port: 20007, bind: "loopback", onProgress: (e) => events.push(e) });

      const phases = events.map((e) => e.phase);
      expect(phases).toEqual(["loading-modules", "starting-server", "ready"]);

      const starting = events[1] as Extract<ProgressEvent, { phase: "starting-server" }>;
      expect(starting.port).toBe(20007);
      expect(starting.bind).toBe("loopback");

      const ready = events[2] as Extract<ProgressEvent, { phase: "ready" }>;
      expect(ready.address).toEqual({ host: "127.0.0.1", port: 20007 });
    });

    it("swallows callback errors so startup is not affected", async () => {
      mocks.startGatewayServer.mockReset();
      mocks.startGatewayServer.mockResolvedValueOnce(stubServer());

      const throwing: (e: ProgressEvent) => void = () => {
        throw new Error("callback exploded");
      };

      let handle: GatewayHandle | null = null;
      await expect(
        (async () => {
          handle = await serve({ port: 20008, onProgress: throwing });
        })(),
      ).resolves.toBeUndefined();
      expect(handle).not.toBeNull();
    });
  });

  describe("source invariant", () => {
    // Embedded surface must not pull in CLI plumbing (commander, process.exit, etc.).
    // Guard against accidental reverse imports.
    it("src/gateway/serve.ts has no imports from src/cli/**", async () => {
      const serveSrc = await fs.readFile(
        path.join(process.cwd(), "src", "gateway", "serve.ts"),
        "utf8",
      );
      const optionsSrc = await fs.readFile(
        path.join(process.cwd(), "src", "gateway", "serve.options.ts"),
        "utf8",
      );
      expect(serveSrc).not.toMatch(/from ["'][^"']*\/cli\//);
      expect(optionsSrc).not.toMatch(/from ["'][^"']*\/cli\//);
    });
  });
});
