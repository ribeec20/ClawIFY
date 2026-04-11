#!/usr/bin/env node

process.env.OPENCLAW_CLI_NAME = "clawify";
await import("./openclaw.mjs");
