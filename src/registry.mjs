// The command registry: a Map from command name to a frozen spec. Lookup is Map.get only, never an object property, so a name such
// as `constructor` or `__proto__` is never a command. The default registry holds every group of src/commands/ (registered at the end).
import { GROUPS } from './commands/index.mjs';
/** @typedef {Record<string, { type: string, short?: string, multiple?: boolean, min?: number, max?: number, missing?: string }>} Options */
/** @typedef {{ run(ctx: import('./context.mjs').Context, args: { values: Record<string, unknown>, positionals: string[] }): Promise<number|void>,
 *   options: Options, positionals: readonly number[], summary: string, writes?: 'text'|'index'|'file'|'none',
 *   guard?: 'none'|'soft'|'strict'|((values: Record<string, unknown>) => 'none'|'soft'|'strict') }} Command */

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
// writes: text/index = brain data; file = no brain data, but output files on request (--out, card --write); none = read-only.
const WRITES = new Set(['text', 'index', 'file', 'none']);
// Data-format guard (lib/store.mjs checkFormat) run by src/cli.mjs before the command when the brain dir exists:
// 'none' skips it; 'soft' prints a NEEDS_MIGRATION note and runs; 'strict' (commands that write text) refuses on any format problem.
// A TOO_NEW directory is refused by 'soft' and 'strict' alike. A function gets the parsed option values and returns one of the three.
export const GUARDS = new Set(['none', 'soft', 'strict']);
export const OPTION_TYPES = new Set(['string', 'boolean', 'integer', 'number']);

/** @returns {Map<string, Command>} */
export const createRegistry = () => new Map();
export const registry = createRegistry();

/** @param {Map<string, Command>} reg @param {unknown} name @returns {Command | undefined} */
export const lookup = (reg, name) => (typeof name === 'string' ? reg.get(name) : undefined);

/** Validate and register one command. Throws TypeError on a malformed spec (a programming error, not a user error). */
/** @param {Map<string, Command>} reg @param {unknown} name @param {any} spec */
export function defineCommand(reg, name, spec) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('command name must be lowercase letters, digits and dashes');
  if (reg.has(name)) throw new TypeError(`command ${name} is already registered`);
  const { run, options = {}, positionals, summary, writes = 'none', guard = 'soft' } = spec ?? {};
  if (typeof run !== 'function') throw new TypeError(`${name}: run must be a function`);
  if (typeof summary !== 'string' || !summary) throw new TypeError(`${name}: summary must be a non-empty string`);
  if (!WRITES.has(writes)) throw new TypeError(`${name}: writes must be text, index, file or none`);
  if (typeof guard !== 'function' && !GUARDS.has(guard)) throw new TypeError(`${name}: guard must be none, soft, strict or a function`);
  const [min, max] = Array.isArray(positionals) && positionals.length === 2 ? positionals : [NaN, NaN];
  if (!Number.isSafeInteger(min) || min < 0 || !(Number.isSafeInteger(max) || max === Infinity) || max < min) throw new TypeError(`${name}: positionals must be [min, max] with 0 <= min <= max`);
  const opts = Object.create(null);
  for (const [k, o] of Object.entries(options)) {
    if (!OPTION_TYPES.has(o?.type)) throw new TypeError(`${name}: option type of --${k} must be string, boolean, integer or number`);
    opts[k] = Object.freeze({ ...o });
  }
  const cmd = Object.freeze({ run, options: Object.freeze(opts), positionals: Object.freeze([min, max]), summary, writes, guard });
  reg.set(name, cmd);
  return cmd;
}

// ---------- the brain commands ----------
for (const group of Object.values(GROUPS)) for (const [name, spec] of Object.entries(group)) defineCommand(registry, name, spec);
