// lib/graph/uri.ts: the external form of a graph node, `pg:<type>/<pct(id)>`. Pure, no I/O. Storage keeps raw ids; this form is for
// command arguments, `--json` and MCP. Decoding is single pass and canonical: a URI is accepted only when re-encoding the decoded id
// gives the input back, so there is exactly one spelling per node (no `%2e%2e`, no lowercase hex, no needless escapes).
// Deliberate extra rule: an id that itself contains `%` followed by two hex digits is refused (it would read as a double encoding,
// `%252f`); a bare `%` (`100%`) is fine.
const CORE_TYPES: readonly string[] = ['ticket', 'person', 'sprint', 'epic', 'plantask', 'openitem', 'plan', 'doc', 'repo'];
const EXT_TYPE = /^x-[a-z][a-z0-9-]{0,23}\.[a-z][a-z0-9-]{0,23}$/;
const MAX_ID = 200;
// C0, DEL, C1, then bidi marks and embeddings/isolates, and line separators (NEL is in C1).
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const DOUBLE_ENCODED = /%[0-9A-Fa-f]{2}/;
// Left raw: printable ASCII except these. Everything else (controls, non-ASCII) is percent-encoded as UTF-8.
const RESERVED = new Set(['%', '/', '#', '|', '?', ' ']);

const typeOk = (type: string): boolean => CORE_TYPES.includes(type) || EXT_TYPE.test(type);

function idOk(id: string): boolean {
  if (id.length === 0 || FORBIDDEN.test(id) || DOUBLE_ENCODED.test(id)) return false;
  if (!id.isWellFormed()) return false; // a lone surrogate has no UTF-8 form
  return [...id].length <= MAX_ID;
}

function encodeId(id: string): string {
  let out = '';
  for (const ch of id) {
    const code = ch.codePointAt(0) as number;
    out += code > 0x20 && code < 0x7f && !RESERVED.has(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}

/** Builds the external URI `pg:<type>/<pct(id)>` of a node; throws on a type or id outside the grammar. */
export function nodeUri(type: string, id: string): string {
  if (!typeOk(type)) throw new Error(`node type outside the grammar: ${JSON.stringify(type)}`);
  if (!idOk(id)) throw new Error('node id outside the rules (1-200 characters, no controls, bidi, line breaks, lone surrogates or %XX)');
  return `pg:${type}/${encodeId(id)}`;
}

/** Parses an external node URI into `{ type, id }`, or returns null when it is not exactly the canonical form of a valid node. */
export function parseNodeUri(uri: string): { type: string; id: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith('pg:')) return null;
  const slash = uri.indexOf('/', 3);
  if (slash < 0) return null;
  const type = uri.slice(3, slash);
  if (!typeOk(type)) return null;
  const raw = uri.slice(slash + 1);
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!idOk(id) || encodeId(id) !== raw) return null;
  return { type, id };
}
