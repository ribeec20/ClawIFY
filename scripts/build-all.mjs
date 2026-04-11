#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const nodeBin = process.execPath;
const WINDOWS_BUILD_MAX_OLD_SPACE_MB = 4096;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const a2uiRendererDir = path.join(rootDir, "vendor", "a2ui", "renderers", "lit");
const a2uiAppDir = path.join(rootDir, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const a2uiBundleFile = path.join(rootDir, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
export const BUILD_ALL_STEPS = [
  { label: "canvas:a2ui:bundle", kind: "pnpm", pnpmArgs: ["canvas:a2ui:bundle"] },
  { label: "tsdown", kind: "node", args: ["scripts/tsdown-build.mjs"] },
  { label: "runtime-postbuild", kind: "node", args: ["scripts/runtime-postbuild.mjs"] },
  { label: "build-stamp", kind: "node", args: ["scripts/build-stamp.mjs"] },
  {
    label: "build:plugin-sdk:dts",
    kind: "pnpm",
    pnpmArgs: ["build:plugin-sdk:dts"],
    windowsNodeOptions: `--max-old-space-size=${WINDOWS_BUILD_MAX_OLD_SPACE_MB}`,
  },
  {
    label: "write-plugin-sdk-entry-dts",
    kind: "node",
    args: ["--import", "tsx", "scripts/write-plugin-sdk-entry-dts.ts"],
  },
  {
    label: "check-plugin-sdk-exports",
    kind: "node",
    args: ["scripts/check-plugin-sdk-exports.mjs"],
  },
  {
    label: "canvas-a2ui-copy",
    kind: "node",
    args: ["--import", "tsx", "scripts/canvas-a2ui-copy.ts"],
  },
  {
    label: "copy-hook-metadata",
    kind: "node",
    args: ["--import", "tsx", "scripts/copy-hook-metadata.ts"],
  },
  {
    label: "copy-export-html-templates",
    kind: "node",
    args: ["--import", "tsx", "scripts/copy-export-html-templates.ts"],
  },
  {
    label: "write-build-info",
    kind: "node",
    args: ["--import", "tsx", "scripts/write-build-info.ts"],
  },
  {
    label: "write-cli-startup-metadata",
    kind: "node",
    args: ["--experimental-strip-types", "scripts/write-cli-startup-metadata.ts"],
  },
  {
    label: "write-cli-compat",
    kind: "node",
    args: ["--import", "tsx", "scripts/write-cli-compat.ts"],
  },
];

function shouldSkipMissingA2ui(env) {
  if (env.OPENCLAW_A2UI_SKIP_MISSING === "1" || env.OPENCLAW_SPARSE_PROFILE) {
    return true;
  }
  const isCi = /^(1|true)$/i.test(env.CI ?? "");
  if (isCi) {
    return false;
  }
  const hasSources = existsSync(a2uiRendererDir) && existsSync(a2uiAppDir);
  const hasBundle = existsSync(a2uiBundleFile);
  return !hasSources && !hasBundle;
}

function resolveBuildAllEnv(env = process.env) {
  if (!shouldSkipMissingA2ui(env)) {
    return env;
  }
  return {
    ...env,
    OPENCLAW_A2UI_SKIP_MISSING: "1",
  };
}

function resolveStepEnv(step, env, platform) {
  if (platform !== "win32" || !step.windowsNodeOptions) {
    return env;
  }
  const currentNodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  if (currentNodeOptions.includes(step.windowsNodeOptions)) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: currentNodeOptions
      ? `${currentNodeOptions} ${step.windowsNodeOptions}`
      : step.windowsNodeOptions,
  };
}

export function resolveBuildAllStep(step, params = {}) {
  const platform = params.platform ?? process.platform;
  const env = resolveStepEnv(step, params.env ?? process.env, platform);
  if (step.kind === "pnpm") {
    const runner = resolvePnpmRunner({
      pnpmArgs: step.pnpmArgs,
      nodeExecPath: params.nodeExecPath ?? nodeBin,
      npmExecPath: params.npmExecPath ?? env.npm_execpath,
      comSpec: params.comSpec ?? env.ComSpec,
      platform,
    });
    return {
      command: runner.command,
      args: runner.args,
      options: {
        stdio: "inherit",
        env,
        shell: runner.shell,
        windowsVerbatimArguments: runner.windowsVerbatimArguments,
      },
    };
  }
  return {
    command: params.nodeExecPath ?? nodeBin,
    args: step.args,
    options: {
      stdio: "inherit",
      env,
    },
  };
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  const buildEnv = resolveBuildAllEnv(process.env);
  for (const step of BUILD_ALL_STEPS) {
    console.error(`[build-all] ${step.label}`);
    const invocation = resolveBuildAllStep(step, { env: buildEnv });
    const result = spawnSync(invocation.command, invocation.args, invocation.options);
    if (typeof result.status === "number") {
      if (result.status !== 0) {
        process.exit(result.status);
      }
      continue;
    }
    process.exit(1);
  }
}
