// brain explain [COMMAND]: the CLI describes itself, generated from the registry (summary, options, positionals, writes class) and the
// error table, so it cannot drift from the code. No brain directory or index is needed. Output is deterministic and bounded: the full
// list stays under 400 estimated tokens (names grouped by what they write), one command is a few lines. --json gives the same facts.
import { EXIT_MEANING, BrainError, didYouMean } from '../errors.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

// Grouped by the registry's `writes` class: what a command may change: the brain data (text files or the index), or only output files
// on request (`file`: --out, card --write). `none` means it writes nothing at all.
const WRITES = Object.freeze([['none', 'writes none'], ['file', 'writes files'], ['index', 'writes index'], ['text', 'writes text']]);
const GLOBAL = '--json -v --dir DIR --if-present';
const exitLine = () => `exit: ${EXIT_MEANING.map(([c, m]) => `${c} ${m}`).join(', ')}`;
const VALUE = Object.freeze({ string: 'S', integer: 'N', number: 'X' });
const MAX_OPTIONS = 30;

/** @param {string} name @param {{ type: string, short?: string }} o */
const optionText = (name, o) => `--${name}${o.short ? `|-${o.short}` : ''}${o.type === 'boolean' ? '' : ` ${/** @type {Record<string, string>} */ (VALUE)[o.type] ?? 'S'}`}`;
/** @param {readonly number[]} positionals */
const argsText = ([min, max]) => {
  if (max === 0) return '';
  const req = Array.from({ length: Math.min(min, 3) }, () => 'ARG').join(' ');
  const opt = max === Infinity ? ' [ARG...]' : Array.from({ length: Math.min(max - min, 3) }, () => ' [ARG]').join('');
  return ` ${(req + opt).trim()}`;
};
/** @param {string} name @param {any} c */
const describe = (name, c) => ({
  name, summary: c.summary, positionals: [c.positionals[0], c.positionals[1] === Infinity ? null : c.positionals[1]],
  options: Object.keys(c.options).toSorted().map((k) => ({ name: k, type: c.options[k].type, ...(c.options[k].short ? { short: c.options[k].short } : {}) })),
  writes: c.writes,
});

/** @param {Ctx} ctx @param {Args} args */
async function explain(ctx, args) {
  const { registry } = await import('../registry.mjs'); // lazy: the registry imports this module
  const [name] = args.positionals, out = ctx.io.out;
  const names = [...registry.keys()].toSorted();
  if (name !== undefined) {
    const c = registry.get(name);
    if (!c) {
      const near = didYouMean(name, names);
      // the try line (src/cli.mjs passes `explain` as the failing command) is replaced by the near command's explain
      throw new BrainError('USAGE', `unknown command ${String(name).replace(/[^\w-]/g, '?').slice(0, 40)}${near ? `; did you mean ${near}?` : ''}`, { hint: near ? `\`brain explain ${near}\`` : '`brain explain`' });
    }
    const opts = Object.keys(c.options).toSorted();
    out(`${name}: ${c.summary}`);
    out(`usage: brain ${name}${argsText(c.positionals)}${opts.length ? ' [options]' : ''}`);
    if (opts.length) out(`options: ${opts.slice(0, MAX_OPTIONS).map((k) => optionText(k, c.options[k])).join(' ')}${opts.length > MAX_OPTIONS ? ` +${opts.length - MAX_OPTIONS} more` : ''}`);
    out(`global: ${GLOBAL}`);
    out(`writes: ${c.writes}`);
    out(exitLine());
    ctx.io.data?.({ commands: [describe(name, c)], exit: Object.fromEntries(EXIT_MEANING) }, { next: [] });
    return 0;
  }
  out('brain: one plan question per command. terse by default; -v detail; --json envelope v2 {v,cmd,ok,exit,data,fresh,next}');
  out(exitLine());
  for (const [w, label] of WRITES) {
    const group = names.filter((n) => /** @type {import('../registry.mjs').Command} */ (registry.get(n)).writes === w);
    if (group.length) out(`${label}: ${group.join(' ')}`);
  }
  out(`global: ${GLOBAL}`);
  out('more: brain explain COMMAND | brain explain --json');
  ctx.io.data?.({ commands: names.map((n) => describe(n, registry.get(n))), exit: Object.fromEntries(EXIT_MEANING) }, { next: [] });
  return 0;
}

export const commands = {
  explain: { run: explain, positionals: [0, 1], guard: 'none', summary: 'what each command does: options, arguments, what it writes, exit codes (from the registry)' },
};
