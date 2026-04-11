---
summary: "SDK reference for app-side Clawify instance and user configuration over the management API"
read_when:
  - Embedding OpenClaw or clawify into an app backend
  - Enabling or disabling user tool access in code
  - Registering custom MCP servers per instance or user
title: "Clawify SDK"
---

# Clawify SDK

Use the Clawify SDK when your app needs to configure and drive a running Gateway using code.

This SDK wraps management API routes under `/v1/management/*` and gives you package-style primitives:

- `clawify.instance(instanceId, options)`
- `instance.user(userId)`
- `user.prompt(message, options)`

Use the dedicated SDK subpath so app integrations stay isolated from CLI/runtime surface changes:

- `clawify/sdk`

## Install and import

```ts
import { clawify } from "clawify/sdk";
```

## Create an instance client

```ts
import { clawify } from "clawify/sdk";

const instance = clawify.instance("my-app", {
  baseUrl: "http://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
});
```

Options:

- `baseUrl`: Gateway base URL. Default: `http://127.0.0.1:18789`
- `token`: management bearer token
- `headers`: additional headers

## Control what users are allowed to change

Use per-instance policy toggles for tools, skills, and MCP:

```ts
await instance.setUserToolsEnabled(true);   // allow user tool updates
await instance.setUserSkillsEnabled(true);  // allow user skill updates
await instance.setUserMcpEnabled(true);     // allow user MCP updates
```

Disable a surface:

```ts
await instance.setUserToolsEnabled(false);  // blocks user-level tools updates
```

## Work with a user scope

```ts
const user = instance.user("user-123");
```

### Tools

Allow and deny tools for one user:

```ts
await user.allowTools(["write", "read"]);
await user.denyTools(["exec"]);
```

You can also post full tool updates:

```ts
await user.updateTools({
  alsoAllow: ["edit"],
  deny: ["exec"],
});
```

### Skills

Enable and configure a skill entry for one user:

```ts
await user.updateSkill("my_skill", {
  enabled: true,
  env: {
    MY_SKILL_MODE: "prod",
  },
});
```

### MCP servers

Register a custom MCP server for one user:

```ts
await user.setMcpServer("docs", {
  url: "https://mcp.example.com/sse",
  transport: "sse",
  headers: {
    Authorization: "Bearer secret-token",
  },
});
```

Remove a server:

```ts
await user.removeMcpServer("docs");
```

## Prompt the agent from your app

Run a scoped prompt using the same instance and user settings:

```ts
const result = await user.prompt(
  "Edit src/test-file.txt and set it to HELLO",
  {
    model: "openai/gpt-5.4",
  },
);

console.log(result.key); // session key
console.log(result.runId); // run id
```

`prompt()` creates a session when needed, then calls `sessions.send` with the same `instanceId` and `userId`.

## Full example

```ts
import { clawify } from "clawify/sdk";

async function configureAndRun() {
  const instance = clawify.instance("my-app", {
    baseUrl: "http://127.0.0.1:18789",
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
  });

  await instance.setUserToolsEnabled(true);
  await instance.setUserMcpEnabled(true);

  const user = instance.user("user-123");
  await user.allowTools(["write"]);
  await user.setMcpServer("docs", {
    url: "https://mcp.example.com/sse",
    transport: "sse",
  });

  const run = await user.prompt("Update README.md with a short hello line");
  return run;
}
```

## Related

- Gateway client API: [/gateway/api](/gateway/api)
- OpenAI-compatible API: [/gateway/openai-http-api](/gateway/openai-http-api)
- Gateway auth: [/gateway/authentication](/gateway/authentication)
