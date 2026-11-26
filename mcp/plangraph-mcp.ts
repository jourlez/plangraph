#!/usr/bin/env node
// plangraph-mcp: the optional, read-only MCP server (stdio) of plangraph. NOT started by the plugin and not on PATH; an owner who wants
// it adds it to an MCP config by hand (docs/MCP.md). Tools: ready, whatif (dry run only), ticket; the protocol is in src/mcp.ts.
// The repository is the working directory the client starts it in, and the plan dir follows the CLI rules (PLANGRAPH_DIR, .plangraphrc).
// stdout carries only JSON-RPC lines; nothing is logged. It exits when stdin closes, after answering what it already read.
import { nodeSupported, floorMessage } from '../src/floor.js';

export interface McpHost {
  version: string; // process.version, with the leading v
  versions: string; // process.versions.node
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: AsyncIterable<Uint8Array | string>;
  stdout: { write(chunk: string): unknown; on(event: 'error', listener: () => void): unknown };
  stderr: { write(chunk: string): unknown };
}

/** Runs the server on the given streams and returns the exit code: 3 below the Node floor, otherwise 0 once stdin is drained. */
export async function main(host: McpHost): Promise<number> {
  if (!nodeSupported(host.versions)) {
    host.stderr.write(`${floorMessage(host.version)}\n`);
    return 3;
  }
  const { createServer, serve } = await import('../src/mcp.ts');
  let open = true;
  host.stdout.on('error', () => { open = false; }); // the client went away (EPIPE): stop writing, finish reading
  const write = (line: string) => { if (open) host.stdout.write(`${line}\n`); };
  await serve(host.stdin, write, createServer({ env: host.env, cwd: host.cwd }));
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main({ version: process.version, versions: process.versions.node, env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
}
