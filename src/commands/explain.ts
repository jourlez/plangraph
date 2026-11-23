// brain explain [COMMAND]: the CLI describes itself, generated from the registry (summary, options, positionals, writes class) and the
// error table, so it cannot drift from the code. No brain directory or index is needed. Output is deterministic and bounded: the full
// list stays under 400 estimated tokens (names grouped by what they write), one command is a few lines. --json gives the same facts.
import { EXIT_MEANING, BrainError, didYouMean } from '../errors.ts';
import type { Ctx, Args } from '../context.ts';
import type { Command, CommandMap, OptionSpec } from '../registry.ts';

// Grouped by the registry's `writes` class: what a command may change: the brain data (text files or the index), or only output files
// on request (`file`: --out, card --write). `none` means it writes nothing at all.
const WRITES = Object.freeze([['none', 'writes none'], ['file', 'writes files'], ['index', 'writes index'], ['text', 'writes text']]);
const GLOBAL = '--json -v --dir DIR --if-present';
const exitLine = () => `exit: ${EXIT_MEANING.map(([c, m]) => `${c} ${m}`).join(', ')}`;
const VALUE = Object.freeze({ string: 'S', integer: 'N', number: 'X' });
const MAX_OPTIONS = 30;

const optionText = (name: string, o: OptionSpec) => `--${name}${o.short ? `|-${o.short}` : ''}${o.type === 'boolean' ? '' : ` ${(VALUE as Record<string, string>)[o.type] ?? 'S'}`}`; // a lookup by any type name: ?? covers the rest
const argsText = ([min, max]: readonly [number, number]) => {
  if (max === 0) return '';
  const req = Array.from({ length: Math.min(min, 3) }, () => 'ARG').join(' ');
  const opt = max === Infinity ? ' [ARG...]' : Array.from({ length: Math.min(max - min, 3) }, () => ' [ARG]').join('');
  return ` ${(req + opt).trim()}`;
};
const describe = (name: string, c: Command) => ({
  name, summary: c.summary, positionals: [c.positionals[0], c.positionals[1] === Infinity ? null : c.positionals[1]],
  options: Object.keys(c.options).toSorted().map((k) => ({ name: k, type: (c.options[k] as OptionSpec).type, ...((c.options[k] as OptionSpec).short ? { short: (c.options[k] as OptionSpec).short } : {}), ...((c.options[k] as OptionSpec).writes ? { writes: [...(c.options[k] as OptionSpec).writes as readonly string[]] } : {}) })), // k is one of c.options' own keys; writes tested on the same line
  writes: c.writes, ...(c.also ? { also: [...c.also] } : {}),
});
// `writes: CLASS[, also...][; --flag: writes...]`: the class, what the command always writes besides it, and what each flag adds.
const writesText = (c: Command) => {
  const flags = Object.keys(c.options).toSorted().filter((k) => (c.options[k] as OptionSpec).writes).map((k) => `; --${k}: ${((c.options[k] as OptionSpec).writes as readonly string[]).join(' ')}`); // k is one of c.options' own keys, filtered on writes
  return `writes: ${c.writes}${c.also ? `, ${c.also.join(' ')}` : ''}${flags.join('')}`;
};
const SIDE_LABEL = Object.freeze({ 'git-config': 'git config', gitattributes: '.gitattributes', 'merge-shim': 'merge shim' });

async function explain(ctx: Ctx, args: Args): Promise<number> {
  const { registry } = await import('../registry.ts'); // lazy: the registry imports this module
  const [name] = args.positionals, out = ctx.io.out;
  const names = [...registry.keys()].toSorted();
  if (name !== undefined) {
    const c = registry.get(name);
    if (!c) {
      const near = didYouMean(name, names);
      // the try line (src/cli.ts passes `explain` as the failing command) is replaced by the near command's explain
      throw new BrainError('USAGE', `unknown command ${String(name).replace(/[^\w-]/g, '?').slice(0, 40)}${near ? `; did you mean ${near}?` : ''}`, { hint: near ? `\`brain explain ${near}\`` : '`brain explain`' });
    }
    const opts = Object.keys(c.options).toSorted();
    out(`${name}: ${c.summary}`);
    out(`usage: brain ${name}${argsText(c.positionals)}${opts.length ? ' [options]' : ''}`);
    if (opts.length) out(`options: ${opts.slice(0, MAX_OPTIONS).map((k) => optionText(k, c.options[k] as OptionSpec)).join(' ')}${opts.length > MAX_OPTIONS ? ` +${opts.length - MAX_OPTIONS} more` : ''}`); // opts holds c.options' own keys
    out(`global: ${GLOBAL}`);
    out(writesText(c));
    out(exitLine());
    ctx.io.data?.({ commands: [describe(name, c)], exit: Object.fromEntries(EXIT_MEANING) }, { next: [] });
    return 0;
  }
  out('brain: one plan question per command. terse by default; -v detail; --json envelope v2 {v,cmd,ok,exit,data,fresh,next}');
  out(exitLine());
  for (const [w, label] of WRITES) {
    const group = names.filter((n) => (registry.get(n) as Command).writes === w); // n is one of the registry's own keys
    if (group.length) out(`${label}: ${group.join(' ')}`);
  }
  // the side writes (merge-driver wiring) in one line: who does them (a command always, or one flag), and what they are
  const who: string[] = [], what = new Set<string>();
  for (const n of names) {
    const c = (registry.get(n) as Command); // n is one of the registry's own keys
    if (c.also) { who.push(n); for (const x of c.also) what.add(x); }
    for (const k of Object.keys(c.options).toSorted()) if ((c.options[k] as OptionSpec).writes) { who.push(`${n} --${k}`); for (const x of (c.options[k] as OptionSpec).writes as readonly string[]) what.add(x); } // k is one of c.options' own keys; writes tested first
  }
  if (who.length) out(`also writes: ${who.join(', ')}: ${[...what].map((x) => (SIDE_LABEL as Record<string, string>)[x] ?? x).join(', ')}`); // lookup by any name: ?? covers the rest
  out(`global: ${GLOBAL}`);
  out('more: brain explain COMMAND | brain explain --json');
  ctx.io.data?.({ commands: names.map((n) => describe(n, registry.get(n) as Command)), exit: Object.fromEntries(EXIT_MEANING) }, { next: [] }); // registry keys
  return 0;
}

export const commands: CommandMap = {
  explain: { run: explain, positionals: [0, 1], guard: 'none', summary: 'what each command does: options, arguments, what it writes, exit codes (from the registry)' },
};
