#!/usr/bin/env node
// plangraph-mcp: the optional, read-only MCP server (stdio) of plangraph. NOT started by the plugin and not on PATH; an owner who wants
// it adds it to an MCP config by hand (docs/MCP.md). Tools: ready, whatif (dry run only), ticket; the protocol is in src/mcp.ts.
// The repository is the working directory the client starts it in, and the plan dir follows the CLI rules (PLANGRAPH_DIR, .plangraphrc).
// stdout carries only JSON-RPC lines; nothing is logged. It exits when stdin closes, after answering what it already read.
import { nodeSupported, floorMessage } from '../src/floor.js';

if (!nodeSupported(process.versions.node)) {
  process.stderr.write(`${floorMessage(process.version)}\n`);
  process.exitCode = 3;
} else {
  const { createServer, serve } = await import('../src/mcp.ts');
  let open = true;
  process.stdout.on('error', () => { open = false; }); // the client went away (EPIPE): stop writing, finish reading
  const write = (line: string) => { if (open) process.stdout.write(`${line}\n`); };
  await serve(process.stdin, write, createServer({ env: process.env, cwd: process.cwd() }));
  process.exitCode = 0;
}
