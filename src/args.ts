// Strict argument parsing over util.parseArgs. Unknown options, a value on a boolean, a missing value and a bad number are usage errors
// (exit 2) with a short, fixed message; a bad value is never echoed. Option types: string, boolean, integer, number (the last two are
// parsed as strings and converted here with Number.isFinite / Number.isSafeInteger checks). `values` has a null prototype.
import { parseArgs } from 'node:util';
import { oneLine } from '../lib/sanitize.ts';
import { PlangraphError, didYouMean } from './errors.ts';
import { OPTION_TYPES } from './registry.ts';
import type { OptionSpec } from './registry.ts';

// A usage error carries no hint: the error table (src/errors.ts) adds `try: plangraph explain <command>` for the command that failed.
const usage = (message: string, cause?: unknown) => new PlangraphError('USAGE', message, { cause });
const DECIMAL = /^-?\d+(?:\.\d+)?$/; // ASCII digits only: no exponent, hex, sign '+', unicode digits or surrounding space
const MAX_NUM_LEN = 40, MAX_NAME = 60;

function toNumber(name: string, raw: unknown, o: { type: string; min?: number; max?: number }): number {
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

export function parse(spec: { options?: Record<string, OptionSpec>; positionals?: readonly number[] }, argv: string[]): { values: Record<string, unknown>; positionals: string[] } {
  const defs: Record<string, OptionSpec> = Object.create(null), cfg: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = Object.create(null);
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
      const o = defs[t.name] as OptionSpec; // Object.hasOwn(cfg, t.name) above: defs and cfg are filled with the same keys
      if (o.type === 'string' && typeof o.missing === 'string' && (t.value === undefined || (!t.inlineValue && t.value.length > 1 && t.value.startsWith('-')))) throw new PlangraphError('USAGE', o.missing);
      continue;
    }
    const near = t.rawName.startsWith('--') ? didYouMean(t.name, Object.keys(cfg)) : null;
    throw usage(`unknown option ${oneLine(t.rawName, MAX_NAME)}${near ? `; did you mean --${near}?` : ''}`);
  }
  // Pass 2 (strict): a boolean given a value, a string option without one.
  let parsed: { values: Record<string, string | boolean | Array<string | boolean> | undefined>; positionals: string[] };
  try { parsed = parseArgs({ args: argv, options: cfg, strict: true, allowPositionals: true }); }
  catch (e) { throw usage(oneLine((e as Error).message, 200), e); } // parseArgs throws a TypeError with a message
  const values: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(parsed.values)) {
    const o = defs[k] as OptionSpec; // strict parseArgs returns only options named in cfg, whose keys defs shares
    values[k] = o.type === 'integer' || o.type === 'number' ? (Array.isArray(v) ? v.map((x) => toNumber(k, x, o)) : toNumber(k, v, o)) : v;
  }
  const [min, max] = (spec.positionals ?? [0, Infinity]) as readonly [number, number], n = parsed.positionals.length; // the only caller (src/cli.ts) passes Command.positionals, which defineCommand freezes as exactly [min, max]
  if (n < min || n > max) {
    const want = min === max ? `${min} argument${min === 1 ? '' : 's'}` : n < min ? `at least ${min} argument${min === 1 ? '' : 's'}` : `at most ${max} argument${max === 1 ? '' : 's'}`;
    throw usage(`expected ${want}, got ${n}`);
  }
  return { values, positionals: parsed.positionals };
}
