import path from "node:path";

export const DEFAULT_CLI_NAME = "openclaw";
export const CLI_BRAND_ALIASES = ["openclaw", "clawify"] as const;

const KNOWN_CLI_NAMES = new Set<string>(CLI_BRAND_ALIASES);
const CLI_PREFIX_RE = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw|clawify)\b/;

export function resolveCliName(argv: string[] = process.argv): string {
  const fromEnv = process.env.OPENCLAW_CLI_NAME?.trim().toLowerCase();
  if (fromEnv && KNOWN_CLI_NAMES.has(fromEnv)) {
    return fromEnv;
  }

  const argv1 = argv[1];
  if (!argv1) {
    return DEFAULT_CLI_NAME;
  }
  const base = path.basename(argv1).trim();
  if (KNOWN_CLI_NAMES.has(base)) {
    return base;
  }
  const withoutExt = base.replace(/\.(?:mjs|js|cmd|ps1|exe)$/i, "");
  if (KNOWN_CLI_NAMES.has(withoutExt)) {
    return withoutExt;
  }
  return DEFAULT_CLI_NAME;
}

export function replaceCliName(command: string, cliName = resolveCliName()): string {
  if (!command.trim()) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  return command.replace(CLI_PREFIX_RE, (_match, runner: string | undefined) => {
    return `${runner ?? ""}${cliName}`;
  });
}
