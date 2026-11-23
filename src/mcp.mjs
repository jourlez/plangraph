// The optional, read-only MCP adapter: three tools (ready, whatif, ticket) over the stdio transport, hand-written JSON-RPC 2.0, no SDK.
// Off by default: nothing in the plugin starts it (no mcpServers in plugin.json, no .mcp.json at the plugin root); docs/MCP.md says how
// an owner opts in. Each tool call runs the SAME command through src/cli.mjs main() with a collecting io, so the text is byte for byte
// what `brain ready|ticket|whatif` prints (fences, sanitization, the 40-line bound, the STALE warning, error lines), stdout then stderr.
// Safety: arguments are validated against fixed allowlists (ticket key shapes, a person-name shape, safe integers, booleans) and become a
// fixed argv (`--` before the key); whatif is a dry run only: --apply-plan and --write can never be built. No paths from arguments, no
// shell, no network, no writes, no stdin read by a command (stdin is the protocol). Library code: never exits, never prints.
// Protocol (handshake-based revisions 2025-11-25 and earlier): see docs/MCP.md for what was verified against the spec and what was not.
import { main as cliMain } from './cli.mjs';
import { makeContext } from './context.mjs';

/** @typedef {{ out(line: string): void, err(line: string): void }} RunIO */
/** @typedef {(argv: string[], io: RunIO, opts: { env: Record<string, string | undefined>, cwd: string }) => Promise<number>} Runner */
/** @typedef {string | number} Id */

export const SERVER_VERSION = '0.1.0';
/** Newest first. A requested version in this list is echoed; any other gets the first (the spec: answer the latest one we support). */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
export const MAX_MESSAGE = 1024 * 1024; // bytes of one message line, newline excluded
export const MAX_TEXT = 256 * 1024; // bytes of one tool result text

const ERR = Object.freeze({ PARSE: -32700, INVALID: -32600, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603 });

// Ticket keys: a Jira key (src/commands/shared.mjs KEY_RE) or a superpowers key sp:<slug>[/<id>] (lib/integrations/superpowers.mjs:
// slug [A-Za-z0-9][A-Za-z0-9._-]* up to 48, id dot-separated alphanumerics up to 24). No `..`, no second `/`, nothing else.
const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const SP_KEY = /^sp:[A-Za-z0-9][A-Za-z0-9._-]{0,47}(?:\/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;
const MAX_KEY = 120;
/** @param {unknown} k */
const validKey = (k) => typeof k === 'string' && k.length <= MAX_KEY && (JIRA_KEY.test(k) || (SP_KEY.test(k) && !k.includes('..') && k.length <= 76));
// A person (whatif --to): letters, marks, digits, space, . _ ' - ; starts with a letter or digit, no trailing space, at most 80.
const PERSON = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'-]{0,79}$/u;
/** @param {unknown} s */
const validPerson = (s) => typeof s === 'string' && PERSON.test(s) && !s.endsWith(' ');
const MAX_SPRINT = 100000;

const KEY_PROP = { type: 'string', description: 'Ticket key, e.g. ABC-123 or sp:<plan>/<task>' };
const VERBOSE = { type: 'boolean', description: 'Longer answer (the CLI -v)' };
const ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
/** The tool definitions, in tools/list order. Every property is listed; anything else is refused. */
export const TOOLS = Object.freeze([
  { name: 'ready', title: 'May this ticket start now?', description: 'Definition of ready for one ticket: READY TO START, DONE (its own status is closed), or NOT READY with reasons (verdict, open items, unfinished producers). Same text as `brain ready KEY`.',
    inputSchema: { type: 'object', properties: { key: KEY_PROP, verbose: VERBOSE }, required: ['key'], additionalProperties: false }, annotations: ANNOTATIONS },
  { name: 'whatif', title: 'Dry run of a move', description: 'Dry run of reassigning a ticket (to) or moving it to a sprint: OK, or NO with the broken rules and a repair. Never changes anything. Same text as `brain whatif KEY`.',
    inputSchema: { type: 'object', properties: { key: KEY_PROP, to: { type: 'string', description: 'New owner' }, sprint: { type: 'integer', minimum: 0, maximum: MAX_SPRINT, description: 'New sprint' },
      earlier: { type: 'boolean' }, owner_change: { type: 'boolean' }, slip: { type: 'boolean' }, strict: { type: 'boolean' }, verbose: VERBOSE }, required: ['key'], additionalProperties: false }, annotations: ANNOTATIONS },
  { name: 'ticket', title: 'One ticket', description: 'One ticket: size, status, verdict, placement, needs, findings (verbose adds evidence). Same text as `brain ticket KEY`.',
    inputSchema: { type: 'object', properties: { key: KEY_PROP, verbose: VERBOSE }, required: ['key'], additionalProperties: false }, annotations: ANNOTATIONS },
].map((t) => Object.freeze(t)));
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const WHATIF_FLAGS = Object.freeze([['earlier', '--earlier'], ['owner_change', '--owner-change'], ['slip', '--slip'], ['strict', '--strict']]);

class ArgError extends Error {}

/** The fixed argv of one tool call, or throws ArgError (fixed message, never the value). Exported for tests.
 * @param {string} name @param {Record<string, unknown>} args @returns {string[]} */
export function toolArgv(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new ArgError('unknown tool');
  const props = tool.inputSchema.properties;
  for (const k of Object.keys(args)) if (!Object.hasOwn(props, k)) throw new ArgError('unknown argument (allowed: ' + Object.keys(props).join(', ') + ')');
  if (!validKey(args.key)) throw new ArgError('key must be a ticket key such as ABC-123 or sp:<plan>/<task>');
  for (const [k, p] of Object.entries(props)) if (p.type === 'boolean' && args[k] !== undefined && typeof args[k] !== 'boolean') throw new ArgError(`${k} must be true or false`);
  const argv = [name];
  if (name === 'whatif') {
    if (args.to !== undefined) { if (!validPerson(args.to)) throw new ArgError('to must be a person name (letters, digits, space, . _ \' -; at most 80)'); argv.push(`--to=${args.to}`); }
    if (args.sprint !== undefined) {
      if (typeof args.sprint !== 'number' || !Number.isSafeInteger(args.sprint) || args.sprint < 0 || args.sprint > MAX_SPRINT) throw new ArgError(`sprint must be a whole number from 0 to ${MAX_SPRINT}`);
      argv.push(`--sprint=${args.sprint}`);
    }
    for (const [k, flag] of WHATIF_FLAGS) if (args[k] === true) argv.push(flag);
  }
  if (args.verbose === true) argv.push('-v');
  argv.push('--', /** @type {string} */ (args.key));
  // defense in depth: the dry-run guarantee does not rest on the allowlist above alone
  if (argv.some((a) => a === '--write' || a.startsWith('--apply') || a === '--jira' || a === '--dir')) throw new ArgError('refused');
  return argv;
}

// A command must never read the protocol stream: its stdin is a closed, empty one.
const NO_STDIN = Object.freeze({ isTTY: false, read: () => '' });
/** The default runner: src/cli.mjs main() with the caller's io, env and cwd, and no stdin. @type {Runner} */
const defaultRun = (argv, io, { env, cwd }) => cliMain(argv, { io, env, cwd, makeContext: (o) => makeContext({ ...o, stdin: NO_STDIN }) });

/** Bounded text: stdout lines, then stderr lines; past MAX_TEXT bytes the text is cut on a character boundary with one marker line. */
function collector() {
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  let bytes = 0, cut = false;
  /** @param {string[]} into */
  const add = (into) => (/** @type {unknown} */ line) => {
    if (cut) return;
    const s = String(line), n = Buffer.byteLength(s) + 1;
    if (bytes + n > MAX_TEXT) { cut = true; return; }
    bytes += n; into.push(s);
  };
  return { io: { out: add(out), err: add(err) }, text: () => [...out, ...err].join('\n') + (cut ? `\n... output cut at ${MAX_TEXT} bytes` : '') };
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} id @returns {id is Id} */
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id));
/** @param {Id | null} id @param {number} code @param {string} message */
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
/** @param {Id} id @param {unknown} result */
const result = (id, result) => ({ jsonrpc: '2.0', id, result });

/** One server: protocol state plus the runner. handle(text) answers one message line (a reply object, or null for none).
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, run?: Runner }} [opts] */
export function createServer({ env = {}, cwd = '.', run = defaultRun } = {}) {
  let initialized = false;

  /** @param {Id} id @param {unknown} params */
  async function callTool(id, params) {
    if (!isObject(params) || typeof params.name !== 'string') return error(id, ERR.PARAMS, 'invalid params: name must be a string');
    if (!TOOL_BY_NAME.has(params.name)) return error(id, ERR.PARAMS, 'unknown tool');
    if (params.arguments !== undefined && !isObject(params.arguments)) return error(id, ERR.PARAMS, 'invalid params: arguments must be an object');
    let argv;
    // an argument problem is a tool execution error (isError), so the model can correct itself (MCP 2025-11-25, SEP-1303)
    try { argv = toolArgv(params.name, isObject(params.arguments) ? params.arguments : {}); } catch (e) {
      if (e instanceof ArgError) return result(id, { content: [{ type: 'text', text: `invalid arguments: ${e.message}` }], isError: true });
      throw e;
    }
    const col = collector();
    const code = await run(argv, col.io, { env, cwd });
    return result(id, { content: [{ type: 'text', text: col.text() }], isError: code >= 2 });
  }

  /** @param {unknown} msg @returns {Promise<object | null>} */
  async function dispatch(msg) {
    if (Array.isArray(msg)) return error(null, ERR.INVALID, msg.length ? 'invalid request: batches are not supported' : 'invalid request');
    if (!isObject(msg)) return error(null, ERR.INVALID, 'invalid request');
    const hasId = Object.hasOwn(msg, 'id'), id = hasId && validId(msg.id) ? msg.id : null;
    if (msg.jsonrpc !== '2.0' || (hasId && id === null)) return error(id, ERR.INVALID, 'invalid request');
    if (typeof msg.method !== 'string') {
      // a response from the client (we never send requests, so there is nothing to match): ignored
      if (hasId && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) return null;
      return hasId ? error(id, ERR.INVALID, 'invalid request') : null;
    }
    const method = msg.method;
    // A notification is never answered. notifications/initialized changes nothing: tools are served once initialize was answered
    // (a client SHOULD send it first; requiring it would only break clients that pipeline). notifications/cancelled: calls are short
    // and answered in order, so there is nothing to cancel.
    if (id === null) return null;
    switch (method) {
      case 'ping': return result(id, {});
      case 'initialize': {
        if (initialized) return error(id, ERR.INVALID, 'already initialized');
        const p = msg.params;
        if (!isObject(p) || typeof p.protocolVersion !== 'string') return error(id, ERR.PARAMS, 'invalid params: protocolVersion must be a string');
        initialized = true;
        const version = PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : LATEST_PROTOCOL;
        return result(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'project-brain', version: SERVER_VERSION } });
      }
      case 'tools/list':
        if (!initialized) return error(id, ERR.INVALID, 'server not initialized');
        if (isObject(msg.params) && msg.params.cursor !== undefined) return error(id, ERR.PARAMS, 'invalid params: unknown cursor');
        return result(id, { tools: TOOLS });
      case 'tools/call':
        if (!initialized) return error(id, ERR.INVALID, 'server not initialized');
        return callTool(id, msg.params);
      default: return error(id, ERR.METHOD, 'method not found');
    }
  }

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return {
    /** @param {Uint8Array} bytes one message line, newline excluded @returns {Promise<object | null>} */
    async handle(bytes) {
      let msg;
      try { msg = JSON.parse(decoder.decode(bytes)); } catch { return error(null, ERR.PARSE, 'parse error'); }
      try { return await dispatch(msg); } catch {
        const id = isObject(msg) && validId(msg.id) ? msg.id : null;
        return id === null ? null : error(id, ERR.INTERNAL, 'internal error');
      }
    },
  };
}

const NL = 0x0a;
/** @param {Uint8Array} b */
const blank = (b) => b.every((c) => c === 0x20 || c === 0x09 || c === 0x0d);

/** Serve newline-delimited JSON-RPC from an async iterable of byte chunks until it ends, one message at a time, in order.
 * Memory is bounded: a line longer than MAX_MESSAGE is answered with one error and skipped up to its newline without being kept.
 * The iterator is only pulled after the previous chunk's messages are answered (natural backpressure).
 * @param {AsyncIterable<Uint8Array | string>} input @param {(line: string) => void} write @param {ReturnType<typeof createServer>} server */
export async function serve(input, write, server) {
  /** @type {Buffer[]} */ let parts = []; let size = 0, skipping = false;
  const reply = (/** @type {object | null} */ r) => { if (r) write(JSON.stringify(r)); };
  const tooLarge = () => reply(error(null, ERR.INVALID, 'message too large'));
  const line = async (/** @type {Buffer} */ b) => { if (!blank(b)) reply(await server.handle(b)); };
  for await (const raw of input) {
    let chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    while (chunk.length) {
      const i = chunk.indexOf(NL);
      const head = i < 0 ? chunk : chunk.subarray(0, i);
      chunk = i < 0 ? Buffer.alloc(0) : chunk.subarray(i + 1);
      if (!skipping) {
        if (size + head.length > MAX_MESSAGE) { skipping = true; parts = []; size = 0; tooLarge(); }
        else { parts.push(head); size += head.length; }
      }
      if (i < 0) break;
      if (skipping) { skipping = false; continue; }
      const msg = Buffer.concat(parts, size); parts = []; size = 0;
      await line(msg);
    }
  }
  if (!skipping && size) await line(Buffer.concat(parts, size)); // a last line without a newline is still answered at end of input
}
