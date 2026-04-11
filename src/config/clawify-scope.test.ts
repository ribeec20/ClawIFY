import { describe, expect, it } from "vitest";
import { applyClawifyScopeToConfig } from "./clawify-scope.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("applyClawifyScopeToConfig", () => {
  it("layers instance defaults and user allowlist extensions", () => {
    const cfg: OpenClawConfig = {
      tools: {
        alsoAllow: ["read"],
      },
      skills: {
        entries: {
          global_skill: { enabled: true },
        },
      },
      clawify: {
        defaultInstanceId: "app-a",
        instances: {
          "app-a": {
            tools: {
              allow: ["edit"],
            },
            skills: {
              entries: {
                instance_skill: { enabled: true },
              },
            },
            userPolicy: {
              tools: "allowlist-extend",
            },
            users: {
              "user-1": {
                tools: {
                  allow: ["write"],
                },
              },
            },
          },
        },
      },
    };

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { userId: "user-1" },
    });

    expect(scoped.tools?.allow ?? []).toContain("edit");
    expect(scoped.tools?.alsoAllow ?? []).toEqual(expect.arrayContaining(["read", "write"]));
    expect(scoped.skills?.entries).toEqual(
      expect.objectContaining({
        global_skill: expect.objectContaining({ enabled: true }),
        instance_skill: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it("honors user policy=none and ignores user-scoped overrides", () => {
    const cfg: OpenClawConfig = {
      clawify: {
        defaultInstanceId: "app-b",
        instances: {
          "app-b": {
            tools: {
              alsoAllow: ["read"],
            },
            userPolicy: {
              tools: "none",
            },
            users: {
              "user-2": {
                tools: {
                  alsoAllow: ["write"],
                },
              },
            },
          },
        },
      },
    };

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { userId: "user-2" },
    });

    expect(scoped.tools?.alsoAllow).toEqual(["read"]);
  });
});
