---
summary: "Connect external clients to OpenClaw using HTTP, WebSocket, and management APIs"
read_when:
  - Building apps that need to connect to an OpenClaw gateway
  - Wiring frontend clients to a headless OpenClaw deployment
title: "Client Connection API"
---

# Client Connection API

This page is the quick map for connecting applications to OpenClaw.

Use it when you want a separate frontend or service that talks to OpenClaw over API only.

## Start the headless API runtime

Run OpenClaw in API-focused mode:

```bash
openclaw serve --port 18789
```

`openclaw serve` starts Gateway in `api-only` profile and enables the management API surface.

## API surfaces

### OpenAI compatible HTTP API

Use this for chat clients and SDKs that already speak OpenAI-style endpoints:

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`

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

Common setup:

- `Authorization: Bearer <token-or-password>` for shared-secret modes
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

### Read management status

```bash
curl -sS http://127.0.0.1:18789/v1/management/status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Open management SSE stream

```bash
curl -N http://127.0.0.1:18789/v1/management/events \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Recommended client architecture

For fully separated frontends:

1. Run `openclaw serve` on a private network boundary.
2. Put your own frontend or API gateway in front of OpenClaw.
3. Use OpenAI-compatible endpoints for model/chat UX.
4. Use `/v1/management/*` for admin and runtime controls.
5. Use `/v1/management/events` for realtime UI updates.

For remote deployments, pair this with:

- [/gateway/remote](/gateway/remote)
- [/gateway/tailscale](/gateway/tailscale)
