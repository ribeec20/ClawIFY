import { afterEach, describe, expect, it } from "vitest";
import { replaceCliName, resolveCliName } from "./cli-name.js";
import { formatCliCommand } from "./command-format.js";

describe("cli-name clawify alias", () => {
  const originalCliName = process.env.OPENCLAW_CLI_NAME;

  afterEach(() => {
    if (originalCliName === undefined) {
      delete process.env.OPENCLAW_CLI_NAME;
      return;
    }
    process.env.OPENCLAW_CLI_NAME = originalCliName;
  });

  it("resolves clawify from env override", () => {
    process.env.OPENCLAW_CLI_NAME = "clawify";
    expect(resolveCliName(["node", "openclaw.mjs"])).toBe("clawify");
  });

  it("resolves clawify from argv entry basename", () => {
    delete process.env.OPENCLAW_CLI_NAME;
    expect(resolveCliName(["node", "C:\\tools\\clawify.mjs"])).toBe("clawify");
  });

  it("rewrites command prefixes for clawify", () => {
    expect(replaceCliName("openclaw gateway status", "clawify")).toBe("clawify gateway status");
    expect(replaceCliName("pnpm openclaw update", "clawify")).toBe("pnpm clawify update");
  });

  it("formats cli command hints with clawify alias", () => {
    process.env.OPENCLAW_CLI_NAME = "clawify";
    expect(formatCliCommand("openclaw gateway status")).toBe("clawify gateway status");
  });
});
