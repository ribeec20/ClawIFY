# Headless OpenClaw Blueprint

This is a simple picture of how OpenClaw can run as a reusable backend API with plugins/extensions.

## 1) High-Level Shape

```text
Client Apps (Web, Desktop, CLI)
            |
            v
+-------------------------------+
|         HTTP API Layer        |
|  /sessions /tasks /events     |
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

## 2) Suggested Runtime Layout

```text
src/
  api/
    server.ts
    routes/
      sessions.ts
      tasks.ts
      events.ts
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
extensions/
  providers/
  tools/
  channels/
  memory/
```

## 3) Startup Flow

```text
1. Load config
2. Apply mode profile (default headless, prompts disabled)
3. Start runtime core
4. Discover extensions in extensions/
5. Validate extension manifest/contracts
6. Register providers/tools/channels/memory backends
7. Expose API routes
```

## 4) API Surface (Minimal)

### Session endpoints
- POST /v1/sessions
- GET /v1/sessions/:id

### Task endpoints
- POST /v1/tasks
- GET /v1/tasks/:id
- POST /v1/tasks/:id/cancel

### Event streaming
- GET /v1/sessions/:id/events

## 5) Example Request Flow

```text
POST /v1/tasks
  -> routing resolves task type
  -> runtime creates/links session
  -> tool manager picks allowed filesystem tool
  -> provider manager picks model provider extension
  -> execution emits events
  -> API streams events to client
```

## 6) Pairing-Safe Policy Profile (Reduced Friction)

Keep this simple and explicit:
- auth.mode: "pairing"
- prompts.enabled: false
- filesystem.root: workspace-only
- tools.allowlist: explicit
- network.egress: restricted or audited

This lowers friction while still preserving policy boundaries.

## 7) Upstream-Friendly Change Strategy

- Add wrappers, avoid deep rewrites.
- Keep extension contracts stable.
- Keep existing runtime package boundaries.
- Keep changes mostly in API + config wiring.

## 8) Minimal Config Example

```json
{
  "mode": "headless",
  "prompts": { "enabled": false },
  "security": {
    "profile": "pairing",
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

## 9) Why This Works

- API stays stable.
- Features are added by extensions, not core edits.
- You can keep pulling upstream changes with lower merge pain.
