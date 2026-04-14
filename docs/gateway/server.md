---
summary: "Programmatic gateway startup via serve() — embed Clawify inside another Node process without spawning the CLI"
read_when:
  - Embedding the Clawify Gateway inside an existing Node process
  - Avoiding child-process plumbing, log scraping, and PID supervision
  - Wanting typed errors on bad config instead of process.exit
title: "Clawify Server Embedding"
---

# Clawify Server Embedding (`@ribeec20/clawify/server`)

The `./server` subpath starts the gateway in the same Node process as your app. It is the programmatic equivalent of running `clawify serve` from the CLI — same underlying server, without a child process, log scraping, or PID supervision.

Use this when you want:

- Exceptions on bad config / port collisions instead of `process.exit`.
- A promise that resolves when the port is actually bound.
- A handle with a `stop()` method tied to your app's lifecycle.

Use `clawify serve` (CLI) when you want signal handling, restart-on-crash supervision, or a long-running service managed by systemd/launchd/etc. — the CLI keeps those concerns.

## Install and import

```ts
import { serve } from "@ribeec20/clawify/server";
```

## Minimal example

```ts
import { serve } from "@ribeec20/clawify/server";

const gw = await serve({
  port: 18789,
  auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN },
});

console.log(`Gateway listening on ${gw.address.host}:${gw.address.port}`);

// ... make calls against http://127.0.0.1:18789 ...

await gw.stop();
```

## Options

```ts
type ServeOptions = {
  port?: number;                          // default 18789
  profile?: "default" | "api-only";       // default "api-only"
  bind?: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  host?: string;                          // advanced override, bypasses bind resolution
  auth?: {
    mode?: "none" | "token" | "password" | "trusted-proxy";
    token?: string;
    password?: string;
  };
  tailscale?: {
    mode?: "off" | "serve" | "funnel";
    resetOnExit?: boolean;
  };
  managementApiEnabled?: boolean;         // default true (matches `clawify serve`)
  allowUnconfigured?: boolean;
  startupStartedAt?: number;
  onProgress?: (event: ProgressEvent) => void;
};
```

`serve()` rejects with a `ServeOptionsError` if:

- `port` is not an integer in `1..65535`
- `profile`, `bind`, `auth.mode`, or `tailscale.mode` are not valid values
- `auth.mode === "password"` but no `auth.password` is provided
- `bind` is anything other than `"loopback"` and no credentials are provided via `auth.token`, `auth.password`, or `auth.mode === "trusted-proxy"`

```ts
import { serve, ServeOptionsError } from "@ribeec20/clawify/server";

try {
  await serve({ bind: "lan" });
} catch (err) {
  if (err instanceof ServeOptionsError) {
    console.error(`bad config: ${err.message} (field: ${err.field})`);
  }
}
```

## Handle

```ts
type GatewayHandle = {
  readonly port: number;
  readonly address: { host: string; port: number };
  stop(opts?: { reason?: string }): Promise<void>;
};
```

- `port` / `address`: the port and best-effort bound host. For `bind: "custom"` or `"tailnet"`, the host field reports `0.0.0.0` because the real address is resolved by the gateway internally — connect via the host you configured.
- `stop()` is idempotent: calling it a second time resolves without re-invoking the underlying shutdown.

## Progress events

The gateway boot can take tens of seconds (or more, on first run on NTFS). An optional `onProgress` callback surfaces structured phase events so your app isn't facing a silent wait:

```ts
await serve({
  port: 18789,
  auth: { mode: "token", token: "..." },
  onProgress: (event) => {
    switch (event.phase) {
      case "loading-modules":
        console.log("Loading gateway modules…");
        break;
      case "starting-server":
        console.log(`Starting server on port ${event.port}, bind=${event.bind}`);
        break;
      case "ready":
        console.log(`Ready at ${event.address.host}:${event.address.port}`);
        break;
    }
  },
});
```

`onProgress` is fire-and-forget: a throwing callback is caught and will not affect startup.

## Options that are intentionally *not* exposed

The following `clawify serve` CLI flags are **not** accepted by `serve()` because they mutate process-wide state that an embedding host should own:

| CLI flag | Why it's excluded |
|----------|-------------------|
| `--verbose`, `--cli-backend-logs`, `--compact`, `--ws-log` | Would reconfigure global console loggers. |
| `--raw-stream`, `--raw-stream-path` | Would mutate `process.env`. |
| `--force` | Kills external PIDs on the host. Unsafe for a library. |
| `--dev`, `--reset` | Rewrite config on disk. |
| `--password-file` | File reads are a CLI-sugar concern — embedders pass the resolved password directly. |

If you need any of these behaviors, configure them in your own app code.

## v1 limits

1. **One `serve()` per Node process.** The gateway sets `process.env.OPENCLAW_GATEWAY_PORT` during startup; browser/canvas port derivation reads it. Two concurrent `serve()` calls in the same process will race this global. Spawn separate processes if you need multiple gateways.
2. **No lock.** `serve()` does not acquire the gateway lock. If the host also runs `clawify serve` independently, the two will not coordinate.
3. **No signal handling.** The embedding host owns `SIGTERM`/`SIGINT` and must call `await gw.stop()`. The CLI's restart-on-crash supervisor is not active under `serve()`.
4. **No restart-on-crash.** If the gateway crashes, your process sees the rejection / handle close; you decide whether to retry.
5. **Progress phases are coarse.** Only the phases that `serve()` itself orchestrates are emitted; the interior of the server startup is an opaque wait.

## Cold start cost

The **first** `serve()` call in a fresh Node process loads the gateway's module graph (channels, plugins, HTTP stack) and resolves the config + plugin manifests. On Windows/NTFS this can take 60–90 seconds; on Linux/macOS it's noticeably faster but still dominated by module I/O. Subsequent `serve()` calls in the same process reuse the cached module graph and typically complete in 10–20 seconds (mostly config/state reload).

If your host process has a strict startup budget (e.g. a test harness with a 90-second `beforeAll` timeout), pre-warm the graph at module load time:

```ts
// Kick off the heavy dynamic import at module-import time so the first
// serve() call doesn't pay the full cost.
await import("@ribeec20/clawify/server");
```

This is what the repo's own ollama e2e test does (`test/helpers/ollama-e2e.ts`); it lets the first in-process gateway boot stay under a 90 s timeout window by paying the module-load cost before any hook runs.

Use the `onProgress` callback to surface the cold-start phases to the user so the wait isn't silent.

## CLI parity

The CLI `clawify serve` and the programmatic `serve()` share the same underlying server implementation. What the CLI adds on top: argv parsing, restart supervisor, signal handlers, exit-on-error, progress spinner, and env-var side effects. What `serve()` adds on top: typed errors, handle-based shutdown, progress callback.
