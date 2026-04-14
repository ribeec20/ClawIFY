import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVE_PORT,
  ServeOptionsError,
  resolveServeOptions,
} from "./serve.options.js";

describe("resolveServeOptions", () => {
  describe("port", () => {
    it("defaults to 18789 when omitted", () => {
      const { port } = resolveServeOptions();
      expect(port).toBe(DEFAULT_SERVE_PORT);
    });

    it("accepts a valid integer", () => {
      expect(resolveServeOptions({ port: 4242 }).port).toBe(4242);
    });

    it("rejects non-integer", () => {
      expect(() => resolveServeOptions({ port: 18789.5 })).toThrow(ServeOptionsError);
    });

    it("rejects out-of-range", () => {
      expect(() => resolveServeOptions({ port: 0 })).toThrow(ServeOptionsError);
      expect(() => resolveServeOptions({ port: 70000 })).toThrow(ServeOptionsError);
    });

    it("attaches field tag to the error", () => {
      try {
        resolveServeOptions({ port: -1 });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ServeOptionsError);
        expect((err as ServeOptionsError).field).toBe("port");
        expect((err as ServeOptionsError).name).toBe("ServeOptionsError");
      }
    });
  });

  describe("profile", () => {
    it("passes valid values through", () => {
      expect(resolveServeOptions({ profile: "api-only" }).serverOpts.profile).toBe("api-only");
      expect(resolveServeOptions({ profile: "default" }).serverOpts.profile).toBe("default");
    });

    it("rejects unknown profile", () => {
      expect(() =>
        resolveServeOptions({ profile: "bogus" as unknown as "api-only" }),
      ).toThrow(ServeOptionsError);
    });
  });

  describe("bind", () => {
    it("accepts loopback with no auth", () => {
      const { serverOpts } = resolveServeOptions({ bind: "loopback" });
      expect(serverOpts.bind).toBe("loopback");
    });

    it("rejects unknown bind mode", () => {
      expect(() =>
        resolveServeOptions({ bind: "wormhole" as unknown as "lan" }),
      ).toThrow(ServeOptionsError);
    });

    it("rejects non-loopback without auth", () => {
      expect(() => resolveServeOptions({ bind: "lan" })).toThrow(ServeOptionsError);
    });

    it("rejects non-loopback with auth.mode=none", () => {
      expect(() => resolveServeOptions({ bind: "lan", auth: { mode: "none" } })).toThrow(
        ServeOptionsError,
      );
    });

    it("accepts lan with auth.mode=token and non-empty token", () => {
      const { serverOpts } = resolveServeOptions({
        bind: "lan",
        auth: { mode: "token", token: "abc" },
      });
      expect(serverOpts.bind).toBe("lan");
      expect(serverOpts.auth?.token).toBe("abc");
    });

    it("rejects lan with auth.mode=token but empty token", () => {
      expect(() =>
        resolveServeOptions({ bind: "lan", auth: { mode: "token", token: "" } }),
      ).toThrow(ServeOptionsError);
    });

    it("accepts lan with auth.mode=password and non-empty password", () => {
      const { serverOpts } = resolveServeOptions({
        bind: "lan",
        auth: { mode: "password", password: "secret" },
      });
      expect(serverOpts.auth?.password).toBe("secret");
    });

    it("accepts lan with auth.mode=trusted-proxy without token or password", () => {
      const { serverOpts } = resolveServeOptions({
        bind: "lan",
        auth: { mode: "trusted-proxy" },
      });
      expect(serverOpts.auth?.mode).toBe("trusted-proxy");
    });
  });

  describe("auth", () => {
    it("rejects unknown auth.mode", () => {
      expect(() =>
        resolveServeOptions({ auth: { mode: "magic" as unknown as "token" } }),
      ).toThrow(ServeOptionsError);
    });

    it("password mode requires a non-empty password regardless of bind", () => {
      expect(() => resolveServeOptions({ auth: { mode: "password" } })).toThrow(
        ServeOptionsError,
      );
      expect(() => resolveServeOptions({ auth: { mode: "password", password: "" } })).toThrow(
        ServeOptionsError,
      );
    });
  });

  describe("tailscale", () => {
    it("passes mode and resetOnExit through", () => {
      const { serverOpts } = resolveServeOptions({
        tailscale: { mode: "serve", resetOnExit: true },
      });
      expect(serverOpts.tailscale?.mode).toBe("serve");
      expect(serverOpts.tailscale?.resetOnExit).toBe(true);
    });

    it("rejects unknown tailscale mode", () => {
      expect(() =>
        resolveServeOptions({ tailscale: { mode: "warp" as unknown as "off" } }),
      ).toThrow(ServeOptionsError);
    });
  });

  describe("passthrough", () => {
    it("carries managementApiEnabled, host, startupStartedAt through untouched", () => {
      const { serverOpts } = resolveServeOptions({
        managementApiEnabled: true,
        host: "10.0.0.1",
        startupStartedAt: 1000,
      });
      expect(serverOpts.managementApiEnabled).toBe(true);
      expect(serverOpts.host).toBe("10.0.0.1");
      expect(serverOpts.startupStartedAt).toBe(1000);
    });

    it("emits an empty serverOpts when given an empty options object", () => {
      const { serverOpts } = resolveServeOptions({});
      expect(serverOpts).toEqual({});
    });
  });
});
