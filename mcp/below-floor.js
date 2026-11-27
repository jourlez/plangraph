// The MCP server on a Node below the floor. Plain JavaScript on purpose: it must parse and run on any Node that has ES modules, and the
// real server (mcp/plangraph-mcp.ts, TypeScript) does not. Claude Code starts the bundled server in every session; a server that exits
// at once is shown as a failed connection (CONNECTION_CLOSED), so below the floor this answers the handshake instead: initialize succeeds,
// tools/list is empty, tools/call gives one fixed error result, `instructions` says what to do. Exit 0 when stdin ends, nothing on stderr.
// Only a string or number id is ever echoed; no other text of a request is repeated.
import { floorMessage, floorTry } from '../src/floor.js';

const DEFAULT_PROTOCOL = '2025-11-25';

/**
 * Answers the MCP handshake on the given streams until stdin ends.
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {string} version the running Node version (process.version)
 * @returns {Promise<void>} settles when stdin has ended and the pending lines were answered
 */
export function serveBelowFloor(stdin, stdout, version) {
  const text = `${floorMessage(version)}; ${floorTry}`;
  let open = true;
  stdout.on('error', () => { open = false; });
  const send = (/** @type {object} */ o) => { if (open) stdout.write(`${JSON.stringify(o)}\n`); };
  const handle = (/** @type {string} */ line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.method !== 'string') return;
    const id = m.id;
    if (typeof id !== 'string' && typeof id !== 'number') return; // a notification (no id) gets no reply
    if (m.method === 'initialize') {
      const asked = m.params && typeof m.params.protocolVersion === 'string' ? m.params.protocolVersion : '';
      send({ jsonrpc: '2.0', id, result: { protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'plangraph', version: 'below-node-floor' }, instructions: text } });
    } else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
    else if (m.method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
    else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  };
  return new Promise((resolve) => {
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 1048576) buf = ''; // a line over 1 MiB is dropped, as in the real server
    });
    stdin.on('end', () => { if (buf.trim()) handle(buf); resolve(); });
  });
}
