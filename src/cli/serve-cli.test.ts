import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerServeCli } from "./serve-cli.js";

const mocks = vi.hoisted(() => ({
  runGatewayCommand: vi.fn(async () => undefined),
}));

vi.mock("./gateway-cli/run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-cli/run.js")>();
  return {
    ...actual,
    runGatewayCommand: mocks.runGatewayCommand,
  };
});

describe("registerServeCli", () => {
  it("forces api-only profile and enables management API env flag", async () => {
    let observedManagementFlag: string | undefined;
    mocks.runGatewayCommand.mockImplementationOnce(async () => {
      observedManagementFlag = process.env.OPENCLAW_GATEWAY_MANAGEMENT_API;
    });

    const program = new Command();
    registerServeCli(program);
    await program.parseAsync(["serve"], { from: "user" });

    expect(mocks.runGatewayCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "api-only",
      }),
    );
    expect(observedManagementFlag).toBe("1");
  });
});
