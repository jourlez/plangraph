// The command registry: a Map from command name to a frozen spec. Lookup is Map.get only, never an object property, so a name such
// as `constructor` or `__proto__` is never a command. The default registry holds every group of src/commands/ (registered at the end).
import { GROUPS } from './commands/index.ts';
import type { Ctx, Args } from './context.ts';
export interface OptionSpec { type: string; short?: string; multiple?: boolean; min?: number; max?: number; missing?: string }
type Options = Record<string, OptionSpec>;
type Writes = 'text' | 'index' | 'file' | 'none';
type GuardMode = 'none' | 'soft' | 'strict';
type Guard = GuardMode | ((values: Record<string, unknown>) => GuardMode);
/** A command handler: prints through ctx.io and returns its exit code (undefined: 0); most are async, a few return at once (src/cli.ts
 * awaits either). Method syntax: a handler names the option values it reads (Args<V>), which parse() produced from that same command's
 * option spec. */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler that returns nothing exits 0 (src/cli.ts); `async () => {}` is Promise<void>
interface Handler { run(ctx: Ctx, args: Args): Promise<number | void> | number | void }
/** One command as a group of src/commands/ declares it (defineCommand fills the defaults). */
interface CommandSpec { run: Handler['run']; summary: string; positionals: readonly number[]; options?: Options; writes?: Writes; guard?: Guard }
/** A group of src/commands/: command name -> spec. */
export type CommandMap = Record<string, CommandSpec>;
/** A registered command: frozen, every default filled. */
export interface Command { run: Handler['run']; options: Options; positionals: readonly [number, number]; summary: string; writes: Writes; guard: Guard }

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
// writes: text/index = plan data; file = no plan data, but output files on request (--out, card --write); none = read-only.
const WRITES = new Set(['text', 'index', 'file', 'none']);
// Data-format guard (lib/store.ts checkFormat) run by src/cli.ts before the command when the plan dir exists:
// 'none' skips it; 'soft' runs after the check; 'strict' (commands that write text) refuses on any format problem.
// A TOO_NEW directory is refused by 'soft' and 'strict' alike. A function gets the parsed option values and returns one of the three.
const GUARDS = new Set<unknown>(['none', 'soft', 'strict']);
export const OPTION_TYPES = new Set<unknown>(['string', 'boolean', 'integer', 'number']);

export const createRegistry = (): Map<string, Command> => new Map();
export const registry = createRegistry();

export const lookup = (reg: Map<string, Command>, name: unknown): Command | undefined => (typeof name === 'string' ? reg.get(name) : undefined);

/** Validate and register one command. Throws TypeError on a malformed spec (a programming error, not a user error). */
export function defineCommand(reg: Map<string, Command>, name: unknown, spec: unknown): Command {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('command name must be lowercase letters, digits and dashes');
  if (reg.has(name)) throw new TypeError(`command ${name} is already registered`);
  const { run, options = {}, positionals, summary, writes = 'none', guard = 'soft' } = (spec ?? {}) as Partial<CommandSpec>; // untrusted spec: every field is checked below
  if (typeof run !== 'function') throw new TypeError(`${name}: run must be a function`);
  if (typeof summary !== 'string' || !summary) throw new TypeError(`${name}: summary must be a non-empty string`);
  if (!WRITES.has(writes)) throw new TypeError(`${name}: writes must be text, index, file or none`);
  if (typeof guard !== 'function' && !GUARDS.has(guard)) throw new TypeError(`${name}: guard must be none, soft, strict or a function`);
  const [min, max] = Array.isArray(positionals) && positionals.length === 2 ? positionals : [NaN, NaN];
  if (!Number.isSafeInteger(min) || min < 0 || !(Number.isSafeInteger(max) || max === Infinity) || max < min) throw new TypeError(`${name}: positionals must be [min, max] with 0 <= min <= max`);
  const opts: Options = Object.create(null);
  for (const [k, o] of Object.entries(options)) {
    if (!OPTION_TYPES.has(o?.type)) throw new TypeError(`${name}: option type of --${k} must be string, boolean, integer or number`);
    opts[k] = Object.freeze({ ...o });
  }
  const cmd = Object.freeze({ run, options: Object.freeze(opts), positionals: Object.freeze([min, max] as const), summary, writes, guard });
  reg.set(name, cmd);
  return cmd;
}

// ---------- the plangraph commands ----------
for (const group of Object.values(GROUPS)) for (const [name, spec] of Object.entries(group)) defineCommand(registry, name, spec);
