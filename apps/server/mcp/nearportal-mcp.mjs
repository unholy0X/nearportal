#!/usr/bin/env node
// Launcher usable from any working directory (Claude Code / Codex start MCP servers elsewhere):
// resolves the TypeScript loader relative to this file, then runs the CLI.
import { register } from "tsx/esm/api";
register();
await import("./cli.ts");
