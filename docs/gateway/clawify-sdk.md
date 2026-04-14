---
summary: "SDK reference for app-side Clawify instance and user configuration over the management API"
read_when:
  - Embedding OpenClaw or clawify into an app backend
  - Registering custom HTTP tools the agent can call
  - Enabling or disabling user tool access in code
  - Registering custom MCP servers per instance or user
title: "Clawify SDK"
---

# Clawify SDK

Use the Clawify SDK when your app needs to configure and drive a *running* Gateway using code.

If you instead want to start the gateway in-process (instead of spawning `clawify serve` as a child process), see [the `server` subpath](./server.md) which exports `serve(opts)`.

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

## Custom tools

Register HTTP-backed tools that the agent can call during a session. When the LLM decides to use the tool, the gateway POSTs the arguments to your endpoint and returns the response body to the model.

### Register a custom tool

```ts
await instance.registerCustomTool("lookup_customer", {
  name: "lookup_customer",
  description: "Look up a customer by ID and return their profile.",
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "The customer ID" },
    },
    required: ["customerId"],
  },
  target: {
    url: "https://api.example.com/customers/lookup",
    method: "POST",
    auth: { type: "bearer", token: "secret" },
    timeoutMs: 10000,
  },
});
```

Target options:

- `url` (required): HTTP endpoint to call
- `method`: `POST` (default), `PUT`, or `PATCH`
- `headers`: additional request headers
- `auth`: `{ type: "bearer", token }` or `{ type: "header", name, value }`
- `timeoutMs`: request timeout in milliseconds (default: 30000)

Set `removable: false` to prevent user-level deny lists from removing the tool.

### List custom tools

```ts
const tools = await instance.listCustomTools();
// { lookup_customer: { name: "lookup_customer", ... } }
```

### Remove a custom tool

```ts
await instance.removeCustomTool("lookup_customer");
```

### Use custom tools in a session

Custom tools are available when the session has an `instanceId`. Pass it when prompting:

```ts
const result = await user.prompt("Look up customer C-1234", {
  model: "ollama/qwen3.5:9b",
});
```

Or when creating a session directly via the management API:

```ts
POST /v1/management/sessions/create
{ "model": "ollama/qwen3.5:9b", "instanceId": "my-app" }
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
