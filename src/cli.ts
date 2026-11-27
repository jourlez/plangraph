// The CLI runner: argv -> command (registry Map) -> strict args -> Context -> run -> bounded output -> exit code.
// main() never calls process.exit and never replaces console.*: commands write through ctx.io.out (exactly ONE line per call; see
// makeCollector) and ctx.io.outBlock (an array of lines), the collected lines are rendered once
// (clean, terse bound of 40 lines plus one "... N more" marker, -v unbounded, --json the v2 envelope of lib/render.ts), and the exit
// code is data. A command with a data builder hands its structured answer to ctx.io.data(data, { next }); --json prints that instead of
// the collected lines (the text output is unchanged).
// Only the entry point at the bottom touches the process, and only to set process.exitCode.
// ctx.io.raw(text) is the one exception to collection: card and bundle print their prepared text as is (no bound), in order, exactly as
// bin/plangraph always did; with --json those lines go into the envelope as { lines } instead, so --json always prints JSON.
import fs from 'node:fs';
import path from 'node:path';
import { clean, envelope } from '../lib/render.ts';
import { oneLine, guardOutput, sanitizeText } from '../lib/sanitize.ts';
import { FormatError, checkFormat } from '../lib/store.ts';
import { PlangraphError, EXIT, exitCodeOf, errorLines, didYouMean } from './errors.ts';
import { registry as defaultRegistry, lookup } from './registry.ts';
import { parse } from './args.ts';
import { makeContext as defaultMakeContext } from './context.ts';
import type { Ctx, ShellCtx, IO, ContextOptions } from './context.ts';
import type { Command } from './registry.ts';

export const GLOBAL_OPTIONS = Object.freeze({ json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' }, dir: { type: 'string' }, 'if-present': { type: 'boolean' } });
export const OUTPUT_LIMIT = 40;
const MAX_STORED = 10000;

const MAX_NEXT = 3;
// The output contract: ctx.io.out(line) receives exactly ONE line. A line break of any kind in it (LF, CR, VT, FF, NEL, U+2028, U+2029)
// is a programmer error: a value from the data reached an output line without oneLine/fence and could forge a line of our own. In strict
// mode (tests: PLANGRAPH_STRICT_OUT=1, or under node --test) it throws a TypeError, so the command fails with exit 5; in production every run
// of breaks becomes one space, so the line stays one line (never silently several). Intended multi-line output (a fence block, a report)
// goes through ctx.io.outBlock(lines): an array of single lines, each held to the same rule.
const BREAK = /[\n\r\u000b\u000c\u0085\u2028\u2029]/, BREAKS = /[\n\r\u000b\u000c\u0085\u2028\u2029]+/g;
export const strictOutput = (env: Record<string, string | undefined>): boolean => env.PLANGRAPH_STRICT_OUT === '1' || (env.PLANGRAPH_STRICT_OUT !== '0' && process.env.NODE_TEST_CONTEXT !== undefined);
/** Collects output lines, one per out() call (outBlock: one per element). Memory is bounded: past maxStored lines are only counted.
 * data(d, { next }) keeps the last structured answer of the command and at most 3 next commands (strings). */
interface Structured { data: unknown; next: string[] }
export function makeCollector({ maxStored = MAX_STORED, strict = false }: { maxStored?: number; strict?: boolean } = {}) {
  const lines: string[] = []; let dropped = 0, structured: Structured | null = null;
  const one = (line: unknown) => {
    let l = String(line);
    if (BREAK.test(l)) {
      if (strict) throw new TypeError('io.out takes exactly one line (it got a line break): use io.outBlock(lines) for multi-line output');
      l = l.replace(BREAKS, ' ');
    }
    if (lines.length < maxStored) lines.push(l); else dropped++;
  };
  return {
    lines,
    get dropped() { return dropped; },
    get structured() { return structured; },
    out: one,
    outBlock(block: unknown) {
      if (!Array.isArray(block)) { if (strict) throw new TypeError('io.outBlock takes an array of lines'); one(block); return; }
      for (const l of block) one(l);
    },
    data(d: unknown, { next = [] }: { next?: unknown } = {}) { structured = { data: d, next: (Array.isArray(next) ? next : []).filter((c) => typeof c === 'string').slice(0, MAX_NEXT) }; },
  };
}

/** The text to print for collected output, or '' when there is none. --json: ALWAYS the v2 envelope (docs/CONTRACT.md: on any command),
 * with the command's structured data when it gave one, else { lines } (an empty list when the command printed nothing or failed first). */
export function render(col: ReturnType<typeof makeCollector>, { name, code, json = false, verbose = false, fresh = null }: { name: string | undefined; code: number; json?: unknown; verbose?: unknown; fresh?: unknown }): string {
  // guardOutput (lib/sanitize.ts) over all collected lines at once (a fence may span several out() calls): a fence tag that is not part
  // of one of our own fences is neutralized here, whatever the command printed.
  const text = clean(guardOutput(col.lines.join('\n'))), st = col.structured;
  if (json && st) return envelope(name, st.data, { ok: code === 0, exit: code, fresh, next: st.next });
  const all = text ? text.split('\n') : [];
  if (json) return envelope(name, { lines: col.dropped ? [...all, `... ${col.dropped} more`] : all }, { ok: code === 0, exit: code, fresh });
  if (!text) return '';
  const total = all.length + col.dropped, limit = verbose ? Math.min(all.length, MAX_STORED) : OUTPUT_LIMIT;
  return total <= limit ? all.join('\n') : [...all.slice(0, limit), `... ${total - limit} more`].join('\n');
}

const processIo = (): IO => ({ out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) });
const FORMAT_HINTS = new Map([['TOO_NEW', 'upgrade the plangraph plugin, then retry']]);

/** A format message names the plan dir by its absolute path (lib/store.ts); printed, it names it relative to the repository root. */
export const relDir = (ctx: { dir?: string; root?: string } | null | undefined, msg: unknown): string => (ctx?.dir && ctx?.root ? String(msg).split(ctx.dir).join(path.relative(ctx.root, ctx.dir) || '.') : String(msg));

/** The data-format guard of one command (see GUARDS in src/registry.ts). Runs only when the plan dir exists. */
export function formatGuard(ctx: Ctx, cmd: Pick<Command, 'guard'>, values: Record<string, unknown>): void {
  const mode = typeof cmd.guard === 'function' ? cmd.guard(values) : cmd.guard;
  if (mode === 'none' || !fs.existsSync(ctx.dir)) return;
  try { checkFormat(ctx.dir); } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    throw new PlangraphError('DATA', relDir(ctx, e.message), { hint: FORMAT_HINTS.get(e.code), cause: e });
  }
}
// The envelope's fresh object, read after the run (the handle's fingerprints outlive its close).
const freshOf = (ctx: Pick<ShellCtx, 'fresh'> | null | undefined) => { try { return typeof ctx?.fresh === 'function' ? ctx.fresh() : null; } catch { return null; } };
// Raw passthrough: the prepared text is printed as given (one trailing newline is the line end of io.out), after sanitizeText (no escape
// sequence, control character or U+2028/2029 can reach the terminal; prepared text has none, so its bytes are unchanged) and the guard.
// With --json the same lines go into the envelope instead (`{ lines }`), so --json always prints JSON.
const rawText = (text: unknown): string => { const s = guardOutput(sanitizeText(text, { max: Infinity })); return s.endsWith('\n') ? s.slice(0, -1) : s; };
const rawOf = (io: IO) => (text: unknown): void => { const s = rawText(text); if (s) io.out(s); };

/** Run one command line. Returns the exit code; never exits the process. */
export async function main(argv: string[], { registry = defaultRegistry, makeContext = defaultMakeContext, io = processIo(), env = process.env, cwd = process.cwd() }:
  { registry?: Map<string, Command>; makeContext?: (opts: ContextOptions) => ShellCtx; io?: IO; env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<number> {
  const [name, ...rest] = argv;
  // The SessionStart hook runs `card --if-present --refresh`: it must never print and never exit non-zero. Any failure there (a bad
  // .plangraphrc, a refused plan dir, a corrupt index, a bad option, any thrown error) returns 0 with no output; success prints the card.
  const hook = (name === 'card' && rest.includes('--if-present')) || name === 'hook-prompt' || (name === 'refresh' && rest.includes('--quiet')); // hook-prompt and refresh --quiet obey the same rule
  const col = makeCollector({ strict: strictOutput(env) });
  let values: Record<string, unknown> = Object.create(null), code: number, shown: ShellCtx | undefined, command: string | undefined;
  // --json seen on the command line: an error before or during option parsing still prints the envelope (cmd: a registered name or null)
  const cmdName = lookup(registry, name) ? name : undefined, jsonAsked = () => (values.json === undefined ? rest.includes('--json') : Boolean(values.json));
  try {
    const cmd = lookup(registry, name);
    if (!cmd) {
      // No command list here (that is `plangraph explain`): a near name is suggested, and the try line explains it.
      const near = didYouMean(name, registry.keys());
      command = near ?? undefined;
      throw new PlangraphError('USAGE', name === undefined ? 'no command' : `unknown command ${oneLine(String(name), 40)}${near ? `; did you mean ${near}?` : ''}`);
    }
    command = name;
    const args = parse({ options: { ...GLOBAL_OPTIONS, ...cmd.options }, positionals: cmd.positionals }, rest);
    values = args.values;
    using scope = new DisposableStack();
    const ctx = makeContext({ cwd, env, flags: values, io: { out: col.out, outBlock: col.outBlock, err: io.err, raw: values.json ? (t: unknown) => { const s = rawText(t); if (s) col.outBlock(s.split('\n')); } : rawOf(io), data: col.data } });
    if (typeof ctx?.[Symbol.dispose] === 'function') scope.use(ctx as Disposable); // its dispose method is checked on this line
    shown = ctx;
    if (cmd.guard !== undefined && ctx?.dir) formatGuard(ctx, cmd, values);
    const r = await cmd.run(ctx, args);
    code = r === undefined ? EXIT.OK : typeof r === 'number' && Number.isSafeInteger(r) && r >= 0 && r <= 6 ? r : EXIT.UNKNOWN;
    if (hook && code !== EXIT.OK) return EXIT.OK;
  } catch (e) {
    if (hook) return EXIT.OK;
    code = exitCodeOf(e);
    if (e instanceof FormatError) e.message = relDir(shown, e.message); // doctor: lib format errors thrown by the command itself
    const out = render(col, { name: cmdName, code, json: jsonAsked(), verbose: values.verbose, fresh: freshOf(shown) });
    if (out) io.out(out);
    for (const l of errorLines(e, { command, root: shown?.root })) io.err(l);
    return code;
  }
  const out = render(col, { name: cmdName, code, json: values.json, verbose: values.verbose, fresh: freshOf(shown) });
  if (out) io.out(out);
  return code;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
