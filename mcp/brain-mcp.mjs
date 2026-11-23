#!/usr/bin/env node
// brain-mcp: the optional, read-only MCP server (stdio) of open-brain. NOT started by the plugin and not on PATH; an owner who wants
// it adds it to an MCP config by hand (docs/MCP.md). Tools: ready, whatif (dry run only), ticket; the protocol is in src/mcp.mjs.
// The repository is the working directory the client starts it in, and the brain dir follows the CLI rules (BRAIN_DIR, .brainrc).
// stdout carries only JSON-RPC lines; nothing is logged. It exits when stdin closes, after answering what it already read.
import { nodeSupported, floorMessage } from '../src/floor.mjs';

if (!nodeSupported(process.versions.node)) {
  process.stderr.write(`${floorMessage(process.version)}\n`);
  process.exitCode = 3;
} else {
  const { createServer, serve } = await import('../src/mcp.mjs');
  let open = true;
  process.stdout.on('error', () => { open = false; }); // the client went away (EPIPE): stop writing, finish reading
  const write = (/** @type {string} */ line) => { if (open) process.stdout.write(`${line}\n`); };
  await serve(process.stdin, write, createServer({ env: process.env, cwd: process.cwd() }));
  process.exitCode = 0;
}
