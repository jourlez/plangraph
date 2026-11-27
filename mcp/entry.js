#!/usr/bin/env node
// The entry the plugin registers for its MCP server (mcp/servers.json) and the one to use by hand (docs/MCP.md). Plain JavaScript so that any
// Node parses it: below the Node floor it answers the handshake with no tools (mcp/below-floor.js) instead of dying, which Claude Code reports
// as a failed connection; on a supported Node it loads the real server, mcp/plangraph-mcp.ts.
import { nodeSupported } from '../src/floor.js';

if (!nodeSupported(process.versions.node)) {
  const { serveBelowFloor } = await import('./below-floor.js');
  await serveBelowFloor(process.stdin, process.stdout, process.version);
} else {
  const { main } = await import('./plangraph-mcp.ts');
  process.exitCode = await main({ version: process.version, versions: process.versions.node, env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
}
