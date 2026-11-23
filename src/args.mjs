// Strict argument parsing over util.parseArgs. Unknown options, a value on a boolean, a missing value and a bad number are usage errors
// (exit 2) with a short, fixed message; a bad value is never echoed. Option types: string, boolean, integer, number (the last two are
// parsed as strings and converted here with Number.isFinite / Number.isSafeInteger checks). `values` has a null prototype.
import { parseArgs } from 'node:util';
import { oneLine } from '../lib/sanitize.mjs';
import { BrainError, didYouMean } from './errors.mjs';
import { OPTION_TYPES } from './registry.mjs';

// A usage error carries no hint: the error table (src/errors.mjs) adds `try: brain explain <command>` for the command that failed.
/** @param {string} message @param {unknown} [cause] */
const usage = (message, cause) => new BrainError('USAGE', message, { cause });
const DECIMAL = /^-?\d+(?:\.\d+)?$/; // ASCII digits only: no exponent, hex, sign '+', unicode digits or surrounding space
const MAX_NUM_LEN = 40, MAX_NAME = 60;

/** @param {string} name @param {unknown} raw @param {{ type: string, min?: number, max?: number }} o */
function toNumber(name, raw, o) {
  const integer = o.type === 'integer';
  const bad = () => usage(`--${name}: expected ${integer ? 'an integer' : 'a number'}`);
  if (typeof raw !== 'string' || raw.length > MAX_NUM_LEN || !DECIMAL.test(raw)) throw bad();
  let n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n))) throw bad();
  if (n === 0) n = 0; // -0 -> 0
  const min = o.min ?? -Infinity, max = o.max ?? Infinity;
  if (n < min || n > max) throw usage(`--${name}: must be between ${min} and ${max}`);
  return n;
}

/** @param {{ options?: Record<string, { type: string, short?: string, multiple?: boolean, min?: number, max?: number }>, positionals?: readonly number[] }} spec
 *  @param {string[]} argv @returns {{ values: Record<string, unknown>, positionals: string[] }} */
export function parse(spec, argv) {
  const defs = Object.create(null), cfg = Object.create(null);
  for (const [name, o] of Object.entries(spec.options ?? {})) {
    if (!OPTION_TYPES.has(o?.type)) throw new TypeError(`option type of --${name} must be string, boolean, integer or number`);
    defs[name] = o;
    cfg[name] = { type: o.type === 'boolean' ? 'boolean' : 'string', ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) };
  }
  // Pass 1 (lenient, tokens only): find an unknown option ourselves, so the message names it and can suggest the near one.
  const { tokens } = parseArgs({ args: argv, options: cfg, strict: false, allowPositionals: true, tokens: true });
  for (const t of tokens) {
    if (t.kind !== 'option') continue;
    if (Object.hasOwn(cfg, t.name)) {
      // A string option with its own `missing` message (a command's long-standing wording) reports a missing or dash-led value with
      // that message and no hint, instead of parseArgs' generic text.
      const o = defs[t.name];
      if (o.type === 'string' && typeof o.missing === 'string' && (t.value === undefined || (!t.inlineValue && t.value.length > 1 && t.value.startsWith('-')))) throw new BrainError('USAGE', o.missing);
      continue;
    }
    const near = t.rawName.startsWith('--') ? didYouMean(t.name, Object.keys(cfg)) : null;
    throw usage(`unknown option ${oneLine(t.rawName, MAX_NAME)}${near ? `; did you mean --${near}?` : ''}`);
  }
  // Pass 2 (strict): a boolean given a value, a string option without one.
  let parsed;
  try { parsed = parseArgs({ args: argv, options: cfg, strict: true, allowPositionals: true }); }
  catch (/** @type {any} */ e) { throw usage(oneLine(e.message, 200), e); }
  const values = Object.create(null);
  for (const [k, v] of Object.entries(parsed.values)) {
    const o = defs[k];
    values[k] = o.type === 'integer' || o.type === 'number' ? (Array.isArray(v) ? v.map((x) => toNumber(k, x, o)) : toNumber(k, v, o)) : v;
  }
  const [min, max] = spec.positionals ?? [0, Infinity], n = parsed.positionals.length;
  if (n < min || n > max) {
    const want = min === max ? `${min} argument${min === 1 ? '' : 's'}` : n < min ? `at least ${min} argument${min === 1 ? '' : 's'}` : `at most ${max} argument${max === 1 ? '' : 's'}`;
    throw usage(`expected ${want}, got ${n}`);
  }
  return { values, positionals: parsed.positionals };
}
