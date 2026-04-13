# @ribeec20/clawify

**An API and agent SDK forked from [OpenClaw](https://github.com/openclaw/openclaw).**

Clawify repackages the OpenClaw gateway and runtime as a library you can install into your own projects. Instead of running a standalone CLI assistant, you get programmatic access to multi-channel AI gateway capabilities: sessions, agents, tools, and management APIs.

> **Early version (0.x)** -- APIs may change between minor releases. Pin to an exact version if stability matters.

[![npm](https://img.shields.io/npm/v/@ribeec20/clawify?style=flat-square)](https://www.npmjs.com/package/@ribeec20/clawify)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

---

## What this package is (and isn't)

| Clawify (this package) | OpenClaw (upstream) |
|---|---|
| Importable API + SDK for embedding in other repos | Standalone personal AI assistant with CLI |
| Programmatic gateway, session, and agent control | Interactive terminal / chat-channel experience |
| Designed to be a harness for your own applications | Designed to be run directly by end users |

Clawify **does not** ship a CLI for end-user chat. If you want the full OpenClaw experience (onboarding wizard, channel pairing, companion apps), use [OpenClaw](https://github.com/openclaw/openclaw) directly.

## Install

```bash
npm install @ribeec20/clawify
# or
pnpm add @ribeec20/clawify
```

**Runtime:** Node 24 (recommended) or Node 22.16+.

## Package exports

```ts
// Core API -- gateway lifecycle, config, runtime
import { ... } from "@ribeec20/clawify";

// SDK client -- typed management API client
import { ClawifySDK } from "@ribeec20/clawify/sdk";

// Plugin SDK -- build channel/tool/provider plugins
import { ... } from "@ribeec20/clawify/plugin-sdk";
```

## Quick start

### 1. Start the gateway programmatically

```ts
import { startGateway } from "@ribeec20/clawify";

const gw = await startGateway({
  port: 18789,
  bind: "loopback",
  auth: { mode: "token", token: process.env.GATEWAY_TOKEN },
});
```

### 2. Use the SDK client

```ts
import { ClawifySDK } from "@ribeec20/clawify/sdk";

const sdk = new ClawifySDK({
  baseUrl: "http://127.0.0.1:18789",
  token: process.env.GATEWAY_TOKEN,
});

// Create a session and send a message
const session = await sdk.sessions.create({ model: "openai/gpt-4o" });
const reply = await sdk.sessions.send(session.key, {
  message: "Hello from my app",
});
```

### 3. Use the OpenAI-compatible API

The gateway exposes OpenAI-compatible endpoints out of the box:

```bash
curl http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

Available routes:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET  /v1/models`
- `POST /v1/embeddings`
- `POST /tools/invoke`
- `GET  /sessions/:key/history`
- `GET  /health`
- `POST /v1/management/oauth/start`
- `POST /v1/management/oauth/callback`
- `GET  /v1/management/oauth/providers`

## Management API

The gateway includes a management API at `/v1/management` for runtime control:

- Sessions -- create, list, send, kill, inspect history
- Agents -- configure models, tools, and routing
- Config -- read and update gateway configuration
- Tools & skills -- register, invoke, manage
- Cron & webhooks -- schedule and automate
- Users & scopes -- multi-tenant instance/user management

See [HEADLESS_OPENCLAW_BLUEPRINT.md](HEADLESS_OPENCLAW_BLUEPRINT.md) for the full API surface.

## OAuth API

The gateway includes a built-in OAuth proxy for connecting third-party providers (e.g., Google, GitHub) with PKCE support. Three endpoints are available under `/v1/management/oauth`:

### `POST /v1/management/oauth/start`

Initiate an OAuth flow. Returns an authorization URL to redirect the user to.

```bash
curl -X POST http://127.0.0.1:18789/v1/management/oauth/start \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "google-gemini",
    "redirectUri": "http://localhost:3000/oauth/callback"
  }'
```

Response:

```json
{
  "ok": true,
  "result": {
    "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?...",
    "state": "...",
    "provider": "google-gemini",
    "redirectUri": "http://localhost:3000/oauth/callback"
  }
}
```

Providers can be pre-registered at startup via `registerOAuthProvider()`, or supplied inline in the request body with full config (`authorizeUrl`, `tokenUrl`, `clientId`, `redirectUri`, `scopes`).

### `POST /v1/management/oauth/callback`

Complete the OAuth flow by exchanging the authorization code for tokens. The gateway handles PKCE verification, token exchange, optional userinfo lookup, and persists the resulting credential as an auth profile.

```bash
curl -X POST http://127.0.0.1:18789/v1/management/oauth/callback \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state": "...", "code": "..."}'
```

### `GET /v1/management/oauth/providers`

List all registered OAuth providers.

```bash
curl http://127.0.0.1:18789/v1/management/oauth/providers \
  -H "Authorization: Bearer $GATEWAY_TOKEN"
```

## Plugin SDK

Build custom channel adapters, tool providers, or model providers using the plugin SDK:

```ts
import { definePlugin } from "@ribeec20/clawify/plugin-sdk";

export default definePlugin({
  name: "my-plugin",
  // ...
});
```

## Relationship to OpenClaw

Clawify is a fork of OpenClaw with a strict upstream-compatibility constraint: the source stays as close to upstream OpenClaw as possible so that new OpenClaw releases can be merged in with minimal pain. Changes in this repo are limited to thin, additive seams -- SDK wrappers, management API routes, and packaging configuration -- rather than modifications to core gateway or runtime behavior.

If something works in OpenClaw, it should work the same way in clawify. If OpenClaw ships a new feature, it should land here with a straightforward merge.

What clawify adds on top of upstream:

- Packaged as `@ribeec20/clawify` on npm for use as a dependency
- SDK client (`ClawifySDK`) for typed programmatic access to the management API
- Scoped multi-tenant instance and user configuration
- CLI entry points are secondary; the primary interface is the importable API

## Configuration

Minimal gateway config:

```json
{
  "agent": {
    "model": "<provider>/<model-id>"
  }
}
```

See the [OpenClaw configuration reference](https://docs.openclaw.ai/gateway/configuration) for all options. Most OpenClaw configuration applies directly.

## Security

- Default: tools run on the host. Treat the gateway as a privileged service.
- Use token auth (`auth.mode: "token"`) for any non-local access.
- Bind to `loopback` unless you have a reverse proxy or Tailscale in front.

See the [OpenClaw security guide](https://docs.openclaw.ai/gateway/security) for details.

## Status

This project is in **early development (v0.x)**. Expect breaking changes. The API surface is being stabilized and documented as part of ongoing work.

If you find issues, open them on this repo's issue tracker.

## License

[MIT](LICENSE)
