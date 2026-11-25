// Re-pins mutation pins (scripts/mutate.ts) and equivalents (scripts/mutate/equivalent.json) after a mechanical text edit of the sources.
// A pin or equivalent is read from the old tree (`--before <git-ref>`), the old-side text gets the whole-token substitutions (`--subst old=new`),
// and the result must occur exactly once in the working-tree file (a pin) or match exactly one generated mutant (an equivalent). It never
// guesses: a pin it cannot place, or can place twice, is reported and the exit code is 1; fix those by hand.
// Usage: node scripts/repin.ts [--root <dir>] --before <git-ref> [--subst old=new]... [--only <globs>] [--write] [--check-tokens]
// Output: `mapped: N`, `unmapped: M`, `token-mismatch: K`, `ambiguous: A` (exit 1 when M + K + A > 0).
// --check-tokens compares the comment-free token stream of every source file (old side with the substitutions applied) with the working tree.
// --write replaces the pin literals in scripts/mutate.ts (rows matched by position) and rewrites scripts/mutate/equivalent.json (2-space JSON).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { tokenize, mutantsFor, checkEquivalents, isSource } from './mutate-all.ts';
import type { Equivalent, Token } from './mutate-all.ts';

export type Pin = [string, string, string, string[]];
export type Subst = Array<[string, string]>;

const WORD = /[A-Za-z0-9_]/;

/** Replace every whole-token occurrence of an old name by its new name, longest old name first. A name is whole when the characters around
 * it are not word characters (letters, digits, `_`); an old name that starts or ends with `_` is a prefix or suffix and is not checked on that side.
 * `brainstorm` is never touched (`brain` is not whole inside it).
 * @param {string} text @param {Subst} subst */
export function applySubst(text: string, subst: Subst): string {
  if (!subst.length) return text;
  const order = [...subst].sort((a, b) => b[0].length - a[0].length);
  let out = '', i = 0;
  const word = (c: string | undefined) => c !== undefined && WORD.test(c);
  scan: while (i < text.length) {
    for (const [from, to] of order) {
      if (!from || !text.startsWith(from, i)) continue;
      const last = from[from.length - 1];
      if (word(from[0]) && from[0] !== '_' && word(text[i - 1])) continue;
      if (word(last) && last !== '_' && word(text[i + from.length])) continue;
      out += to; i += from.length; continue scan;
    }
    out += text[i++];
  }
  return out;
}

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

export type Verdict = { status: 'mapped'; value: Pin } | { status: 'unmapped' | 'ambiguous'; why: string };

/** Re-pin one mutation pin. `before` is the old text of the pin's file, `after` the new text (or null when the file is gone).
 * @param {Pin} pin @param {string} before @param {string | null} after @param {Subst} subst */
export function repinPin(pin: Pin, before: string, after: string | null, subst: Subst): Verdict {
  const [, from, to, tests] = pin;
  if (count(before, from) !== 1) return { status: 'unmapped', why: 'the old text does not occur exactly once in the old file' };
  if (after === null) return { status: 'unmapped', why: 'the file is gone' };
  const nf = applySubst(from, subst);
  const n = count(after, nf);
  if (n === 0) return { status: 'unmapped', why: 'the substituted text is not in the new file' };
  if (n > 1) return { status: 'ambiguous', why: `the substituted text occurs ${n} times in the new file` };
  return { status: 'mapped', value: [applySubst(pin[0], subst), nf, applySubst(to, subst), tests.map((t) => applySubst(t, subst))] };
}

/** Re-pin one equivalent: line and mutated get the substitutions, the line must be one trimmed line of the new file and the pair must match
 * exactly one mutant mutantsFor generates for it.
 * @param {Equivalent} e @param {string | null} after @param {Subst} subst */
export function repinEquivalent(e: Equivalent, after: string | null, subst: Subst): { status: 'mapped'; value: Equivalent } | { status: 'unmapped' | 'ambiguous'; why: string } {
  const file = applySubst(e.file, subst), line = applySubst(e.line, subst), mutated = applySubst(e.mutated, subst);
  if (after === null) return { status: 'unmapped', why: 'the file is gone' };
  const here = after.split('\n').filter((l) => l.trim() === line).length;
  if (here === 0) return { status: 'unmapped', why: 'the substituted line is not a line of the new file' };
  if (here > 1) return { status: 'ambiguous', why: `the substituted line occurs ${here} times in the new file` };
  const hits = mutantsFor(file, after).filter((m) => m.lineText === line && m.mutatedLine === mutated).length;
  if (hits !== 1) return { status: 'ambiguous', why: `${hits} generated mutants match the substituted line and mutated text` };
  return { status: 'mapped', value: { ...e, file, line, mutated } };
}

/** Comment-free token values of a source text. @param {string} src */
export const significantTokens = (src: string): string[] => tokenize(src).filter((t: Token) => t.type !== 'comment').map((t: Token) => t.value);

// ------------------------------------------------------------------ pin literals in scripts/mutate.ts
interface Lit { start: number; end: number; raw: string; value: string }
/** Rows of a mutate.ts text (file, old text, new text, tests): the three string literals of each row and the string literals of an inline tests array.
 * @param {string} src */
export function pinRows(src: string): Array<{ lits: [Lit, Lit, Lit]; tests: Lit[] | null; pin: Pin }> {
  const t = tokenize(src).filter((x: Token) => x.type !== 'comment');
  const lit = (x: Token): Lit | null => {
    if (x.type !== 'string') return null;
    const raw = src.slice(x.start, x.end);
    return { start: x.start, end: x.end, raw, value: vm.runInNewContext(raw, Object.create(null)) as string };
  };
  const rows: Array<{ lits: [Lit, Lit, Lit]; tests: Lit[] | null; pin: Pin }> = [];
  for (let k = 0; k + 6 < t.length; k++) {
    if (t[k].value !== '[' || t[k + 2].value !== ',' || t[k + 4].value !== ',' || t[k + 6].value !== ',') continue;
    const a = lit(t[k + 1]), b = lit(t[k + 3]), c = lit(t[k + 5]);
    if (!a || !b || !c) continue;
    let tests: Lit[] | null = null;
    if (t[k + 7]?.value === '[') {
      tests = [];
      for (let j = k + 8; j < t.length && t[j].value !== ']'; j++) { const l = lit(t[j]); if (l) tests.push(l); }
    }
    rows.push({ lits: [a, b, c], tests, pin: [a.value, b.value, c.value, tests ? tests.map((x) => x.value) : []] });
  }
  return rows;
}

/** A JavaScript string literal for `value`, in the quote of `likeRaw` unless `value` holds it (then the other quote).
 * @param {string} value @param {string} likeRaw */
export function quoteLike(value: string, likeRaw: string): string {
  let q = likeRaw[0];
  if (value.includes(q) && !value.includes(q === "'" ? '"' : "'")) q = q === "'" ? '"' : "'";
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += `\\${q}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ' || ch === '\u2028' || ch === '\u2029') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return q + out + q;
}

/** mutate.ts text with row k's literals replaced by `pins[k]` (null keeps the row); literals whose value is unchanged are left as written.
 * @param {string} src @param {Array<Pin | null>} pins */
export function writePins(src: string, pins: Array<Pin | null>): string {
  const rows = pinRows(src);
  if (rows.length !== pins.length) throw new Error(`mutate.ts has ${rows.length} pin rows, the old tree had ${pins.length}`);
  const edits: Array<[number, number, string]> = [];
  rows.forEach((r, k) => {
    const p = pins[k];
    if (!p) return;
    r.lits.forEach((l, i) => { if (l.value !== p[i]) edits.push([l.start, l.end, quoteLike(p[i] as string, l.raw)]); });
    if (r.tests) r.tests.forEach((l, i) => { if (l.value !== p[3][i]) edits.push([l.start, l.end, quoteLike(p[3][i], l.raw)]); });
  });
  edits.sort((a, b) => b[0] - a[0]);
  for (const [s, e, text] of edits) src = src.slice(0, s) + text + src.slice(e);
  return src;
}

// ------------------------------------------------------------------ CLI
const globRe = (g: string) => new RegExp(`^${g.split('**').map((p) => p.split('*').map((q) => q.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);

export interface Report { mapped: number; unmapped: number; tokenMismatch: number; ambiguous: number; problems: string[] }

/** Run the tool against `root` (a git work tree). @param {string[]} argv @param {string} root */
export function run(argv: string[], root0: string): Report {
  let root = root0;
  const opt = { before: '', write: false, check: false, only: null as RegExp[] | null, subst: [] as Subst };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--before') opt.before = next();
    else if (a === '--root') root = path.resolve(next());
    else if (a === '--write') opt.write = true;
    else if (a === '--check-tokens') opt.check = true;
    else if (a === '--only') opt.only = next().split(',').filter(Boolean).map(globRe);
    else if (a === '--subst') { const v = next(), at = v.indexOf('='); if (at <= 0) throw new Error(`--subst needs old=new, got ${v}`); opt.subst.push([v.slice(0, at), v.slice(at + 1)]); }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opt.before) throw new Error('--before <git-ref> is required');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  const old = (f: string): string | null => { try { return git(['show', `${opt.before}:${f}`]); } catch { return null; } };
  const cur = (f: string): string | null => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
  const keep = (f: string) => !opt.only || opt.only.some((r) => r.test(f));
  const rep: Report = { mapped: 0, unmapped: 0, tokenMismatch: 0, ambiguous: 0, problems: [] };
  const bad = (kind: 'unmapped' | 'ambiguous', what: string, why: string) => { rep[kind]++; rep.problems.push(`${kind}: ${what}: ${why}`); };

  const MUT = 'scripts/mutate.ts', EQ = 'scripts/mutate/equivalent.json';
  const oldMut = old(MUT);
  const pins = oldMut === null ? [] : pinRows(oldMut).map((r) => r.pin);
  const newPins: Array<Pin | null> = [];
  const texts = new Map<string, [string | null, string | null]>();
  const both = (f: string) => { let v = texts.get(f); if (!v) texts.set(f, v = [old(f), cur(applySubst(f, opt.subst))]); return v; };
  for (const p of pins) {
    if (!keep(p[0])) { newPins.push(null); continue; }
    const [b, a] = both(p[0]);
    const v = repinPin(p, b ?? '', a, opt.subst);
    if (v.status === 'mapped') { rep.mapped++; newPins.push(v.value); } else { newPins.push(null); bad(v.status, `${p[0]}: ${p[1].slice(0, 70)}`, v.why); }
  }

  const oldEq = old(EQ);
  const eqs = oldEq === null ? [] : checkEquivalents(JSON.parse(oldEq));
  const newEqs: Equivalent[] = [];
  for (const e of eqs) {
    if (!keep(e.file)) { newEqs.push(e); continue; }
    const v = repinEquivalent(e, cur(applySubst(e.file, opt.subst)), opt.subst);
    if (v.status === 'mapped') { rep.mapped++; newEqs.push(v.value); } else { newEqs.push(e); bad(v.status, `${e.file}: ${e.line.slice(0, 70)}`, v.why); }
  }

  if (opt.check) {
    for (const f of git(['ls-tree', '-r', '--name-only', opt.before]).split('\n').filter((x) => x && isSource(x) && keep(x))) {
      const b = old(f), a = cur(applySubst(f, opt.subst));
      let same = false;
      try { same = b !== null && a !== null && JSON.stringify(significantTokens(applySubst(b, opt.subst))) === JSON.stringify(significantTokens(a)); } catch { same = false; }
      if (!same) { rep.tokenMismatch++; rep.problems.push(`token-mismatch: ${f}`); }
    }
  }

  if (opt.write && rep.unmapped + rep.ambiguous + rep.tokenMismatch === 0) {
    const m = cur(MUT);
    if (m !== null && pins.length) fs.writeFileSync(path.join(root, MUT), writePins(m, newPins));
    if (oldEq !== null) fs.writeFileSync(path.join(root, EQ), `${JSON.stringify(newEqs, null, 2)}\n`);
  }
  return rep;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const r = run(process.argv.slice(2), path.resolve(import.meta.dirname, '..'));
    for (const p of r.problems) console.log(p);
    console.log(`mapped: ${r.mapped}\nunmapped: ${r.unmapped}\ntoken-mismatch: ${r.tokenMismatch}\nambiguous: ${r.ambiguous}`);
    process.exitCode = r.unmapped + r.tokenMismatch + r.ambiguous > 0 ? 1 : 0;
  } catch (e) { console.error((e as Error).message); process.exitCode = 2; }
}
