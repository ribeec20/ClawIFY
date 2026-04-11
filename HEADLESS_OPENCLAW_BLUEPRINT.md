# Headless OpenClaw Blueprint

This is a simple picture of how OpenClaw runs as a reusable backend API by stripping and reusing the existing Gateway (not by creating a parallel API stack).

The guiding constraint is upstream compatibility: keep this repo as close to standard OpenClaw as possible so upstream changes can still be applied with low merge pain. Headless work should add thin profile, API, and management seams around the existing Gateway/runtime instead of forking core behavior.

## 1) High-Level Shape

```text
Client Apps (Web, Desktop, CLI, external frontends)
            |
            v
+-------------------------------+
| Headless API Compatibility    |
| thin HTTP/WS aliases + docs   |
+-------------------------------+
            |
            v
+-------------------------------+
| Existing Gateway API Layer    |
| HTTP + WS routes already here |
+-------------------------------+
            |
            v
+-------------------------------+
|     OpenClaw Runtime Core     |
| agents | sessions | tasks     |
| cron   | process  | routing   |
+-------------------------------+
            |
            v
+-------------------------------+
|    Extension Registry/Loader  |
+-------------------------------+
   |        |        |        |
   v        v        v        v
Providers  Tools   Channels  Memory
(LLMs)     (FS)    (I/O)     (stores)
```

For a fully separated frontend, the frontend must never shell out to `openclaw`, read local config files, or inspect local credential stores directly. It should talk only to authenticated Gateway/host-manager APIs.

## 2) Current Progress Toward a Simple API

Status summary: the core API substrate already exists in Gateway. Most remaining work is simplification, route curation, and profile defaults.

Implemented today (Gateway reuse already in place):

- Gateway HTTP server pipeline with staged handlers and auth/scopes.
- OpenAI-compatible routes:
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `GET /v1/models`
  - `GET /v1/models/:id`
  - `POST /v1/embeddings`
- Runtime utility routes:
  - `POST /tools/invoke`
  - `GET /sessions/:sessionKey/history` (JSON + SSE)
  - `POST /sessions/:sessionKey/kill`
  - `GET /health`, `GET /healthz`, `GET /ready`, `GET /readyz`
- Extension/plugin route registration remains first-class (no contract break needed).
- Gateway RPC already covers broad management primitives such as health, logs, config, sessions, agents, cron, nodes/devices, approvals, models, tools, skills, secrets, and updates.

In progress:

- Defining and documenting the "simple API" subset from existing Gateway routes.
- Tightening headless defaults (reduced UI/prompt friction, pairing-safe behavior).
- Defining the management API subset needed by a fully separated frontend.

Next:

- If needed, add thin compatibility aliases (for example `/v1/sessions`, `/v1/tasks`, `/v1/events`) that map to existing Gateway/runtime capabilities instead of building a new runtime path.
- Add missing management APIs only as thin wrappers around existing Gateway methods, config seams, plugin contracts, and secret/runtime helpers.
- Add a minimal host-manager boundary only for lifecycle tasks the running Gateway cannot own by itself (for example starting a stopped Gateway).

## 3) Runtime Layout (Reuse-First)

```text
src/
  headless/                # optional thin compatibility facade only, no forked runtime
  gateway/
    server.ts               # public entrypoint
    server.impl.ts          # runtime assembly
    server-http.ts          # HTTP route stage pipeline
    openai-http.ts          # /v1/chat/completions
    openresponses-http.ts   # /v1/responses
    models-http.ts          # /v1/models
    embeddings-http.ts      # /v1/embeddings
    tools-invoke-http.ts    # /tools/invoke
    sessions-history-http.ts
    session-kill-http.ts
  runtime/                 # existing OpenClaw runtime stays primary
  agents/
  sessions/
  tasks/
  cron/
  process/
  routing/
  plugins/                 # plugin contracts + loader
  security/                # policy hooks
  secrets/                 # secret adapters
  config/                  # mode flags and defaults
  host-manager/            # optional minimal service/lifecycle boundary, if needed
extensions/
  providers/
  tools/
  channels/
  memory/
```

Important direction:

- Do not introduce a new top-level `src/api` service for headless by default.
- Keep headless API work inside Gateway routing/config seams.
- If a small `src/headless` facade is needed, keep it route/schema-only and have it call existing Gateway handlers or clients.
- Do not fork provider, tool, channel, session, cron, or plugin runtime logic for headless.
- Do not add hardcoded bundled plugin/provider/channel special cases in core; use existing registry, manifest, capability, and plugin-owned contracts.

## 4) Startup Flow (Gateway Reuse)

```text
1. Load config
2. Apply headless profile (prompts/UI reduced, policy defaults applied)
3. Start existing Gateway runtime core
4. Discover extensions in extensions/
5. Validate extension manifest/contracts
6. Register providers/tools/channels/memory backends
7. Expose curated Gateway API routes (simple subset)
8. Expose curated management API routes for external frontends
9. Defer host lifecycle actions to the optional host-manager boundary
```

## 5) API Surface (Simple Subset)

Current subset from existing Gateway:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/embeddings`
- `POST /tools/invoke`
- `GET /sessions/:sessionKey/history` (JSON or SSE)
- `POST /sessions/:sessionKey/kill`
- `GET /health`, `GET /ready`

Optional compatibility layer (only if product/API consumers require it):

- `POST /v1/tasks` -> map to existing send/agent execution path
- `GET /v1/tasks/:id` -> map to session/run state
- `POST /v1/tasks/:id/cancel` -> map to abort/kill path
- `GET /v1/sessions/:id/events` -> map to existing event streams

## 6) Management API Surface (Frontend Separation)

Goal: an external frontend can configure, operate, and inspect the app without using the CLI, local files, or private runtime imports.

Use existing Gateway RPC methods as the primary implementation source. Add stable aliases/documentation around them rather than replacing them.

Core management groups:

- Health and readiness: status, health, readiness, identity, version, feature flags.
- Logs and diagnostics: tail logs, health details, doctor summaries, usage/cost summaries.
- Config: read schema, read effective config, patch config, apply config, validate config, report restart requirements.
- Credentials: list configured credential targets, set credential, test credential, delete credential, rotate credential, report redacted status. Never return raw secret values.
- Providers/models: list providers, list models, test provider auth, configure provider defaults.
- Agents/sessions: list/create/update/delete agents, list/create/send/abort/reset/delete sessions, stream session messages/events.
- Tools: list catalog, show effective tool policy, invoke allowed tools, update allowlists through config patches.
- Cron/tasks: list/add/update/remove/run cron jobs, list runs, map task aliases to existing session/run state.
- Channels/devices/nodes: list status, start login/onboarding flows, poll auth state, logout, pair/approve/reject devices/nodes, invoke node commands.
- Plugins/skills: list catalog, inspect, install, enable, disable, update, uninstall when supported, request/resolve plugin approvals.
- Updates/restarts: run update, report restart plan, schedule restart when Gateway is running.

Credential API rules:

- Store credentials through existing SecretRef/secret-runtime paths where possible.
- Return only redacted metadata: configured state, source, label, last validation result, and actionable error details.
- Keep provider/channel-specific credential behavior in the owning plugin or documented SDK hooks.
- Prefer `doctor --fix` or plugin-owned repair flows for legacy credential migration; do not add broad startup migrations for headless.

Host lifecycle gap:

- A running Gateway can manage runtime state and schedule its own restart, but it cannot start itself when stopped.
- For full self-contained app management, add a minimal host-manager process or service wrapper that owns service lifecycle: install, start, stop, restart, uninstall, update recovery, and Gateway reachability.
- Keep host-manager small and generic. It should call existing daemon/service runners or platform service integrations, not duplicate Gateway runtime logic.

## 7) Example Request Flow

```text
POST /v1/responses
  -> handled by existing gateway HTTP stage pipeline
  -> auth + operator scope checks run
  -> runtime resolves session/agent context
  -> provider/model resolution runs via existing extension seams
  -> execution emits events
  -> response is returned or streamed to client
```

Management example:

```text
POST /v1/management/credentials/provider/openai
  -> maps to a Gateway credential/config method
  -> auth + admin/operator scope checks run
  -> secret is stored through SecretRef/secret runtime
  -> provider-owned validation hook tests the credential
  -> response returns redacted status only
```

## 8) Same-App Trusted Profile (Reduced Friction)

Goal: when the harness agent and app client run inside the same trusted app/process boundary,
use shared-secret gateway auth and avoid device-pairing friction for operator API calls.

Keep this simple and explicit:

- gateway.auth.mode: "token"
- gateway.auth.token: set from env/SecretRef (single shared app secret)
- gateway.controlUi.enabled: false (if not needed in headless mode)
- prompts.enabled: false
- filesystem.root: workspace-only
- tools.allowlist: explicit
- network.egress: restricted or audited

Behavior notes:

- For operator-style API clients, send gateway token/password and role operator. Do not
  require device identity for same-app inter-app traffic.
- Device/node pairing is still valuable for external nodes, mobile clients, or any connect
  path that crosses a trust boundary.

This lowers friction while preserving separation between API auth and device trust.

## 9) Upstream-Friendly Change Strategy

- Strip and reuse Gateway handlers first; add wrappers only when needed.
- Keep extension contracts stable.
- Keep existing runtime package boundaries.
- Keep changes mostly in Gateway route curation + config wiring.
- Keep API additions additive and versioned; avoid changing existing Gateway behavior unless upstream would accept the change.
- Prefer aliases/facades over moving existing files.
- Prefer config/profile defaults over hardcoded headless branches.
- Keep all provider/channel/plugin-specific behavior in plugin-owned contracts.
- Keep tests focused on public contracts and wrapper mappings, not bundled plugin internals.
- If a change must diverge from upstream, isolate it in a small file with a clear boundary and no runtime duplication.

## 10) Minimal Config Example (Same-App Direction)

```json
{
  "mode": "headless",
  "prompts": { "enabled": false },
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "controlUi": { "enabled": false },
    "openAiChatCompletions": { "enabled": true },
    "openResponses": { "enabled": true }
  },
  "security": {
    "profile": "headless",
    "filesystem": { "root": "./" },
    "toolAllowlist": ["filesystem.read", "filesystem.write", "task.run"]
  },
  "extensions": {
    "providers": ["openai", "anthropic"],
    "tools": ["filesystem", "terminal"],
    "channels": ["http"],
    "memory": ["sqlite"]
  }
}
```

## 11) Why This Works

- API stays stable.
- We reuse battle-tested Gateway auth/scopes/routing instead of duplicating it.
- Features are added by extensions, not core rewrites.
- You can keep pulling upstream changes with lower merge pain.
- Same-app clients can run with one shared gateway secret while pairing remains
  available for cross-boundary device/node trust.
- A separated frontend can manage the app through stable API contracts instead of coupling to CLI prompts, local files, or private core modules.
