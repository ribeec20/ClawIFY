---
summary: "Connect external clients to OpenClaw using HTTP, WebSocket, and management APIs"
read_when:
  - Building apps that need to connect to an OpenClaw gateway
  - Wiring frontend clients to a headless OpenClaw deployment
title: "Client Connection API"
---

# Client Connection API

This page is the single setup and usage path for API-first deployments.

Use it when you want a separate frontend or service that talks to OpenClaw over HTTP or WebSocket only.

## Quick start from a clone

### 1) Clone and install

Requirements:

- Node.js `22.14+`
- `pnpm`

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
```

### 2) Start in API mode (`serve`)

Pick a gateway token and start the API server.

macOS/Linux:

```bash
export OPENCLAW_GATEWAY_TOKEN="replace-with-strong-token"
pnpm openclaw serve --bind loopback --port 18789 --auth token --token "$OPENCLAW_GATEWAY_TOKEN"
```

PowerShell:

```powershell
$env:OPENCLAW_GATEWAY_TOKEN="replace-with-strong-token"
pnpm openclaw serve --bind loopback --port 18789 --auth token --token $env:OPENCLAW_GATEWAY_TOKEN
```

Notes:

- `pnpm openclaw` runs the CLI directly from your clone.
- If you installed a binary package, you can run `openclaw serve` (or `clawify serve` when using the clawify package alias).
- `serve` runs Gateway in `api-only` profile and enables the management API.

### 3) Verify API is up

```bash
curl -sS http://127.0.0.1:18789/health
curl -sS http://127.0.0.1:18789/v1/management \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN"
```

The management root endpoint (`GET /v1/management`) returns the currently available management routes for that runtime.

## API surfaces

### OpenAI compatible HTTP API

Use this for chat clients and SDKs that already speak OpenAI-style endpoints:

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Base URL example:

- `http://127.0.0.1:18789`

These endpoints are documented here:

- [/gateway/openai-http-api](/gateway/openai-http-api)
- [/gateway/openresponses-http-api](/gateway/openresponses-http-api)

### Management HTTP API

Use this for runtime and host operations from your own frontend/backend.

Base prefix:

- `/v1/management/*`

Examples of managed domains include:

- health and status
- config read and write flows
- credentials summary (redacted)
- agents and sessions lifecycle
- tools and cron management
- channels, devices, and nodes flows
- plugin and skill flows
- host lifecycle actions (`install`, `start`, `stop`, `restart`, `uninstall`, `status`, `probe`)

If you want a package-style app integration (`clawify.instance(...).user(...).prompt(...)`), see:

- [/gateway/clawify-sdk](/gateway/clawify-sdk)

### Management event stream

Use this for live updates in dashboards and control UIs:

- `GET /v1/management/events` (SSE)

This stream forwards Gateway events for session, lifecycle, and operational updates.

### Gateway WebSocket protocol

Use this when you need direct protocol-level RPC/event handling:

- `ws://<gateway-host>:<port>` or `wss://<gateway-host>:<port>`

Protocol details:

- [/gateway/protocol](/gateway/protocol)
- [/gateway/bridge-protocol](/gateway/bridge-protocol)

## Authentication model

All client surfaces use Gateway auth.

Common token setup:

- Start server with `--auth token --token <token>`
- Send `Authorization: Bearer <token>` on requests
- trusted proxy identity headers for `trusted-proxy` mode

See full auth setup:

- [/gateway/authentication](/gateway/authentication)
- [/gateway/trusted-proxy-auth](/gateway/trusted-proxy-auth)

## Connection examples

### List models

```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Run an OpenAI responses request

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"openai/gpt-5.4",
    "input":"Say hello from OpenClaw API mode."
  }'
```

### Read management status

```bash
curl -sS http://127.0.0.1:18789/v1/management/status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Inspect route inventory

```bash
curl -sS http://127.0.0.1:18789/v1/management \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Open management SSE stream

```bash
curl -N http://127.0.0.1:18789/v1/management/events \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Read config schema then apply config

```bash
curl -sS http://127.0.0.1:18789/v1/management/config/schema \
  -H "Authorization: Bearer YOUR_TOKEN"

curl -sS http://127.0.0.1:18789/v1/management/config/apply \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"patch":{"prompts":{"enabled":false}}}'
```

Management responses use a stable envelope:

- `ok`
- `result`
- `error.code`
- `error.message`
- `error.details`

## Recommended client architecture

For fully separated frontends:

1. Run `serve` on a private network boundary.
2. Put your own frontend or API gateway in front of OpenClaw.
3. Use OpenAI-compatible endpoints for model/chat UX.
4. Use `/v1/management/*` for admin and runtime controls.
5. Use `/v1/management/events` for realtime UI updates.

For remote deployments, pair this with:

- [/gateway/remote](/gateway/remote)
- [/gateway/tailscale](/gateway/tailscale)
