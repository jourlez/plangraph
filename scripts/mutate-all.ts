// Whole-library mutation testing, zero dependencies. A small tokenizer (strings, templates, comments, regex literals, numbers, names,
// punctuators) finds mutation points in each target file; every mutant is applied to a temporary COPY of the repository (never the working
// tree), syntax-checked with `node --check` (a mutant that does not parse is "invalid" and left out of the score), then the test files mapped
// to that file run against it. A failing test kills the mutant; a run past the per-mutant timeout is neither killed nor survived: it is
// listed apart (TIMEOUT lines, "timeouts" in --json) and left out of the score. Surviving mutants that a person reviewed as equivalent are listed with a reason in scripts/mutate/equivalent.json.
//
// Operators: relational (< <= > >= == != === !==), arithmetic (+ - * / % += -= *= /= ++ --), logical (&& || and removing a unary !),
// boolean literals (true/false), conditional negation (if/while condition wrapped in !( )), return-value replacement (null, or 0 for
// `return null`, or '' for a returned string), string literal change ('' or 'mutant'), off-by-one on decimal integer literals (n+1, 1->0),
// guard removal (`if (c) return|throw|continue|break` gets the condition false) and throw-statement removal. Comments, JSDoc, regex
// literals and import/export specifiers are never mutated.
//
// Test mapping: tier 1 = test files that import the target directly, plus, for a module under src/ or one no test imports directly, the
// tests that load it in-process through other modules; minus those whose unmutated run takes longer than --tier1-budget ms (default 10000; they move to
// tier 2, the fastest file always stays); tier 2 = test files whose transitive import graph reaches it, or that
// run bin/plangraph, bin/plangraph-merge or mcp/plangraph-mcp.ts (found from the path text in the test) when that entry point reaches it; plus the
// OVERRIDES table below. Tier 2 runs only for mutants tier 1 left alive. Test files that fail on the unmutated copy are dropped from the
// mapping and reported (a red test would kill every mutant).
//
// Resumable: results are kept in <TMPDIR>/plangraph-mutate-all/<repo id>/progress.json. A result is reused while the target file's bytes are
// unchanged; a survivor is re-run when any of its mapped test files changed. --fresh discards the progress file; --state DIR keeps
// it (and the work copies) in DIR instead, so two runs never share one progress file.
//
// Usage: node scripts/mutate-all.ts [--files a,b] [--limit N --seed S] [--shard N/M] [--jobs J] [--max-tier 1|2] [--tier1-budget MS] [--timeout-factor F] [--fresh] [--state DIR]
//        [--list] [--json FILE] [--informational]
// Exit: 0 when no unreviewed mutant survived, 1 when any survived (a mutant with no green mapped test counts as survived) or an
// equivalent entry matches no mutant any more (full runs only), 2 on a usage error.
// --informational always exits 0 (CI uses it: the mutation job reports, it does not gate).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

const ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_TARGETS = ['lib/*', 'lib/integrations/*', 'lib/jira/*', 'src/*', 'src/commands/*', 'mcp/*'];
/** the plain .js files that are mutated: the Node floor guard and the two launcher entry files */
const PLAIN_JS = new Set(['src/floor.js', 'src/entry.js', 'src/merge-entry.js']);
/** a source file whatever its extension during the .mjs to .ts migration; PLAIN_JS lists the plain .js files that count @param {string} f */
export const isSource = (f: string) => /\.(mjs|ts)$/.test(f) || PLAIN_JS.has(f);
/** a test file whatever its extension @param {string} f */
const isTestFile = (f: string) => /^test\/[^/]+\.test\.(mjs|ts)$/.test(f);
// Test files never used: the solver test needs Python and OR-Tools, the bench files are not tests.
const EXCLUDED_TESTS = new Set(['test/solver.test.ts', 'test/solver.test.ts']);
/** Manual additions to the derived mapping: target -> extra test files (tier 2). @type {Record<string, string[]>} */
export const OVERRIDES: Record<string, string[]> = {
  'lib/driver.ts': ['test/driver-wiring.test.ts'],
  'lib/stale.ts': ['test/stale.test.ts'], // loads the module through a computed dynamic import (STALE_MODULE), invisible to the scan
};
/** Test files run in tier 1 for a target no test imports (a launcher script run as a subprocess): without this its tests are all tier 2, behind the whole suite. */
export const TIER1_OVERRIDES: Record<string, string[]> = {
  'src/entry.js': ['test/compile-cache.test.ts', 'test/floor.test.ts', 'test/launchers.test.ts'],
  'src/merge-entry.js': ['test/floor.test.ts', 'test/launchers.test.ts'],
};
const EQUIVALENT_FILE = 'scripts/mutate/equivalent.json';
// bumped when the tier rules change, so survivors recorded under older rules are re-run
const MAPPING_VERSION = 2;

export interface Token { type: 'comment' | 'string' | 'template' | 'regex' | 'number' | 'name' | 'punct'; value: string; start: number; end: number; line: number; nl: boolean }
export interface Mutant { file: string; op: string; start: number; end: number; repl: string; line: number; orig: string; lineText: string; mutatedLine: string }
export interface Options { tier1Budget: number; state: string | null; maxTier: number; files: string[] | null; limit: number; seed: number; shard: [number, number]; jobs: number; timeoutFactor: number; fresh: boolean; list: boolean; json: string | null; informational: boolean }
export interface Equivalent { file: string; line: string; mutated: string; why: string }
export interface Result { status: 'killed' | 'timeout' | 'survived' | 'invalid' | 'notests'; tier?: number; upTo?: number; src: string; tests: string }

// ------------------------------------------------------------------ tokenizer
/** @typedef {{ type: 'comment'|'string'|'template'|'regex'|'number'|'name'|'punct', value: string, start: number, end: number, line: number, nl: boolean }} Token */
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const REGEX_AFTER_NAME = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const ID_START = /[\p{ID_Start}$_#]/u, ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;

/** Tokens of a JavaScript module (whitespace dropped; `nl` marks a token preceded by a line break). Throws on an unterminated literal.
 * @param {string} src @returns {Token[]} */
export function tokenize(src: string) {
  /** @type {Token[]} */ const out: Token[] = [];
  let i = 0, line = 1, /** @type {boolean} */ nl = true;
  /** @type {number[]} brace depth at each open template substitution */ const tpl = [];
  let depth = 0;
  const lineAt = () => line;
  /** @param {Token['type']} type @param {number} s @param {number} sl */
  const push = (type: Token["type"], s: number, sl: number) => { out.push({ type, value: src.slice(s, i), start: s, end: i, line: sl, nl }); nl = false; };
  const count = (/** @type {number} */ s: number) => { for (let k = s; k < i; k++) if (src.charCodeAt(k) === 10) line++; };
  const prevSig = () => out.length ? out[out.length - 1] : null;
  const regexAllowed = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.type === 'name') return REGEX_AFTER_NAME.has(p.value);
    if (p.type === 'punct') return !(p.value === ')' || p.value === ']' || p.value === '++' || p.value === '--');
    return false;
  };
  /** scan the rest of a template from i (just after ` or }) to the closing ` or the next ${ ; returns true at ${ */
  const templateRest = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; return true; }
      i++;
    }
    throw new Error(`unterminated template at line ${line}`);
  };
  if (src.startsWith('#!')) { while (i < src.length && src[i] !== '\n') i++; push('comment', 0, 1); }
  while (i < src.length) {
    const c = src[i], s = i, sl = lineAt();
    if (c === '\n') { line++; i++; nl = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff' || c === '\u2028' || c === '\u2029') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; const keep: boolean = (nl); push('comment', s, sl); nl = keep; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error(`unterminated comment at line ${line}`);
      i = e + 2; const keep: boolean = nl || src.slice(s, i).includes('\n'); count(s); push('comment', s, sl); nl = keep; continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; else if (src[i] === '\n') throw new Error(`unterminated string at line ${line}`); i++; }
      if (i >= src.length) throw new Error(`unterminated string at line ${line}`);
      i++; push('string', s, sl); continue;
    }
    if (c === '`') { i++; const open = templateRest(); count(s); push('template', s, sl); if (open) { tpl.push(depth); depth++; } continue; }
    if (c === '}' && tpl.length && depth - 1 === tpl[tpl.length - 1]) {
      depth--; tpl.pop(); const open = templateRest(); count(s); push('template', s, sl); if (open) { tpl.push(depth); depth++; } continue;
    }
    if (c === '/' && regexAllowed()) {
      i++; let cls = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\n') throw new Error(`unterminated regex at line ${line}`);
        if (d === '\\') { i += 2; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
        i++;
      }
      i++; while (i < src.length && ID_PART.test(src[i])) i++;
      push('regex', s, sl); continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i])) {
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '+' || src[i + 1] === '-') && !/^0[xX]/.test(src.slice(s, i))) i++;
        i++;
      }
      push('number', s, sl); continue;
    }
    if (ID_START.test(c) || c === '\\') { i++; while (i < src.length && ID_PART.test(src[i])) i++; push('name', s, sl); continue; }
    const p = PUNCT.find((q) => src.startsWith(q, i) && !(q === '?.' && /[0-9]/.test(src[i + 2] ?? '')));
    i += p ? p.length : 1;
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    push('punct', s, sl);
  }
  if (tpl.length) throw new Error('unterminated template substitution');
  return out;
}

// ------------------------------------------------------------------ mutants
/** @typedef {{ file: string, op: string, start: number, end: number, repl: string, line: number, orig: string, lineText: string, mutatedLine: string }} Mutant */
const SWAP: Record<string, [string, string]> = ({
  '<': ['relational', '<='], '<=': ['relational', '<'], '>': ['relational', '>='], '>=': ['relational', '>'],
  '===': ['relational', '!=='], '!==': ['relational', '==='], '==': ['relational', '!='], '!=': ['relational', '=='],
  '+': ['arithmetic', '-'], '-': ['arithmetic', '+'], '*': ['arithmetic', '/'], '/': ['arithmetic', '*'], '%': ['arithmetic', '*'],
  '+=': ['arithmetic', '-='], '-=': ['arithmetic', '+='], '*=': ['arithmetic', '/='], '/=': ['arithmetic', '*='], '++': ['arithmetic', '--'], '--': ['arithmetic', '++'],
  '&&': ['logical', '||'], '||': ['logical', '&&'],
});
const OPEN = new Set(['(', '[', '{']), CLOSE = new Set([')', ']', '}']);
const CONT = new Set(['.', '?.', '?', ':', ',', '+', '-', '*', '/', '%', '&&', '||', '??', '===', '!==', '==', '!=', '<', '<=', '>', '>=', '=>', '=', '|', '&', '^', '**']);

/** index of the token closing the bracket opened at tokens[k] @param {Token[]} t @param {number} k */
function matching(t: Token[], k: number) {
  let d = 0;
  for (let j = k; j < t.length; j++) {
    if (t[j].type !== 'punct') continue;
    if (OPEN.has(t[j].value)) d++; else if (CLOSE.has(t[j].value) && --d === 0) return j;
  }
  return -1;
}
/** last token index of the expression starting at tokens[k] (a return value or a throw operand) @param {Token[]} t @param {number} k */
function exprEnd(t: Token[], k: number) {
  let d = 0, j = k;
  for (; j < t.length; j++) {
    const x = t[j];
    if (x.type === 'comment') continue;
    if (j > k && d === 0 && x.nl) {
      const prev = t[j - 1];
      if (!(prev.type === 'punct' && CONT.has(prev.value)) && !(x.type === 'punct' && CONT.has(x.value))) return j - 1;
    }
    if (x.type !== 'punct') continue;
    if (OPEN.has(x.value)) d++;
    else if (CLOSE.has(x.value)) { if (d === 0) return j - 1; d--; }
    else if (d === 0 && (x.value === ';' || x.value === ',')) return j - 1;
  }
  return j - 1;
}

/** All mutants of one file, in source order. @param {string} file repo-relative path @param {string} src @returns {Mutant[]} */
export function mutantsFor(file: string, src: string) {
  const all = tokenize(src), t = all.filter((x) => x.type !== 'comment');
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
  /** @type {Mutant[]} */ const out: Mutant[] = [];
  /** @param {string} op @param {number} start @param {number} end @param {string} repl @param {number} line */
  const add = (op: string, start: number, end: number, repl: string, line: number) => {
    const ls = lineStarts[line - 1], le = src.indexOf('\n', ls) < 0 ? src.length : src.indexOf('\n', ls);
    const lastLineEnd = src.indexOf('\n', end) < 0 ? src.length : src.indexOf('\n', end);
    const lineText = src.slice(ls, le), mutatedLine = (src.slice(ls, start) + repl + src.slice(end, lastLineEnd)).split('\n').join(' ');
    out.push({ file, op, start, end, repl, line, orig: src.slice(start, end), lineText: lineText.trim(), mutatedLine: mutatedLine.trim() });
  };
  // module specifiers (after from, after a bare import, inside a dynamic import call) and the star of a namespace import or export are not mutated (the keyword literals are backtick strings: test/packaging.test.ts scans for a quote right after those words)
  const skip = new Set();
  for (let k = 1; k < t.length; k++) {
    const p = t[k - 1], x = t[k];
    if (x.type === 'string' && p.type === 'name' && (p.value === `from` || p.value === `import`)) skip.add(k);
    if (x.type === 'string' && p.value === '(' && t[k - 2]?.value === `import`) skip.add(k);
    if (x.value === '*' && p.type === 'name' && (p.value === `import` || p.value === 'export')) skip.add(k);
  }
  // A `type X = ...;` alias and an `interface X { ... }` are erased when the types are stripped: a mutated string or boolean in them can never
  // change a run, so none is generated (the statement is skipped as a whole).
  for (let k = 0; k < t.length; k++) {
    const x = t[k], p = t[k - 1];
    if (x.type !== 'name' || (x.value !== 'type' && x.value !== 'interface') || t[k + 1]?.type !== 'name') continue;
    if (p && !(p.type === 'punct' && (p.value === ';' || p.value === '}')) && !(p.type === 'name' && (p.value === 'export' || p.value === 'declare'))) continue;
    if (x.value === 'type' && !(t[k + 2]?.value === '=' || t[k + 2]?.value === '<')) continue;
    let d = 0, j = k, seenBrace = false;
    for (; j < t.length; j++) {
      const v = t[j].type === 'punct' ? t[j].value : '';
      if (OPEN.has(v)) { d++; if (v === '{') seenBrace = true; } else if (CLOSE.has(v)) { d--; if (x.value === 'interface' && seenBrace && d === 0) break; } else if (x.value === 'type' && d === 0 && v === ';') break;
    }
    for (let m = k; m <= Math.min(j, t.length - 1); m++) skip.add(m);
    k = j;
  }
  /** guard: tokens[k] is `if`; returns [condStart, condEnd] token indexes when the body is return/throw/continue/break */
  const guard = (/** @type {number} */ k: number) => {
    if (t[k + 1]?.value !== '(') return null;
    const close = matching(t, k + 1);
    if (close < 0) return null;
    let b = close + 1; if (t[b]?.value === '{') b++;
    return t[b] && t[b].type === 'name' && ['return', 'throw', 'continue', 'break'].includes(t[b].value) ? [k + 2, close - 1, b] : null;
  };
  const guardedThrows = new Set();
  for (let k = 0; k < t.length; k++) {
    if (skip.has(k)) continue;
    const x = t[k];
    if (x.type === 'punct') {
      const sw = SWAP[x.value];
      if (sw) {
        // a leading unary +/- on a number is an off-by-sign change, still a valid mutant; skip `**` and other non-listed ops
        add(sw[0], x.start, x.end, sw[1], x.line);
      } else if (x.value === '!' && t[k + 1] && !(t[k + 1].type === 'punct' && t[k + 1].value === '=')) {
        add('logical', x.start, x.end, '', x.line);
      }
    } else if (x.type === 'name') {
      if (x.value === 'true' || x.value === 'false') add('boolean', x.start, x.end, x.value === 'true' ? 'false' : 'true', x.line);
      else if ((x.value === 'if' || x.value === 'while') && t[k + 1]?.value === '(' && t[k - 1]?.value !== '.') {
        const close = matching(t, k + 1);
        if (close > k + 2) {
          const a = t[k + 2].start, b = t[close - 1].end;
          // `if (!x)` negated is the same program as removing the `!` (a logical mutant): skip the duplicate
          let d = 0, compound = false;
          for (let j = k + 2; j < close; j++) {
            const v = t[j].type === 'punct' ? t[j].value : '';
            if (OPEN.has(v)) d++; else if (CLOSE.has(v)) d--; else if (d === 0 && (v === '&&' || v === '||' || v === '??' || v === '?')) compound = true;
          }
          if (t[k + 2].value !== '!' || compound) add('negate', a, b, `!(${src.slice(a, b)})`, x.line);
          const g = x.value === 'if' ? guard(k) : null;
          if (g) { add('guard', a, b, 'false', x.line); if (t[g[2]].value === 'throw') guardedThrows.add(g[2]); }
        }
      } else if (x.value === 'return' && t[k - 1]?.value !== '.') {
        const n = t[k + 1];
        if (n && !n.nl && !(n.type === 'punct' && (n.value === ';' || n.value === '}'))) {
          const e = exprEnd(t, k + 1), a = n.start, b = t[e].end, expr = src.slice(a, b).trim();
          const repl = expr === 'null' ? '0' : /^(['"]).*\1$/s.test(expr) || /^`[^`$]*`$/.test(expr) ? (expr.length === 2 ? 'null' : "''") : 'null';
          add('return', a, b, repl, x.line);
        }
      } else if (x.value === 'throw' && t[k - 1]?.value !== '.' && !guardedThrows.has(k)) {
        const e = exprEnd(t, k + 1);
        const semi = t[e + 1]?.value === ';' ? t[e + 1].end : t[e].end;
        add('throw', x.start, semi, ';', x.line);
      }
    } else if (x.type === 'string') {
      if (x.value === "'use strict'" || x.value === '"use strict"') continue;
      add('string', x.start, x.end, x.value.length === 2 ? "'mutant'" : "''", x.line);
    } else if (x.type === 'template' && x.value.startsWith('`') && x.value.endsWith('`') && !x.value.includes('${')) {
      add('string', x.start, x.end, x.value.length === 2 ? '`mutant`' : '``', x.line);
    } else if (x.type === 'number' && /^\d+$/.test(x.value)) {
      const n = BigInt(x.value);
      add('number', x.start, x.end, n === 1n ? '0' : String(n + 1n), x.line);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.op < b.op ? -1 : a.op > b.op ? 1 : 0) || (a.repl < b.repl ? -1 : a.repl > b.repl ? 1 : 0));
}

/** @param {string} src @param {Mutant} m */
export const applyMutant = (src: string, m: Mutant) => src.slice(0, m.start) + m.repl + src.slice(m.end);
/** stable id of a mutant for the progress file @param {Mutant} m */
export const mutantId = (m: Mutant) => `${m.file}:${m.start}:${m.end}:${m.op}:${m.repl}`;

// ------------------------------------------------------------------ test mapping
/** relative module specifiers a file imports (static, re-export and literal dynamic import) @param {string} src @returns {string[]} */
export function importsOf(src: string) {
  let t: Token[];
  try { t = tokenize(src).filter((x) => x.type !== 'comment'); } catch { return []; }
  const out = [];
  for (let k = 0; k < t.length; k++) {
    const x = t[k];
    if (x.type === 'name' && x.value === `from` && t[k + 1]?.type === 'string') out.push(t[k + 1].value.slice(1, -1));
    else if (x.type === 'name' && x.value === `import` && t[k + 1]?.type === 'string') out.push(t[k + 1].value.slice(1, -1));
    else if (x.type === 'name' && x.value === `import` && t[k + 1]?.value === '(' && t[k + 2]?.type === 'string') out.push(t[k + 2].value.slice(1, -1));
  }
  return out.filter((s) => s.startsWith('.'));
}

const ENTRY_PATTERNS: Array<[string, RegExp]> = ([
  ['bin/plangraph', /bin(?:\/|['"`]\s*,\s*['"`])plangraph(?:['"`]|$)|['"`]plangraph['"`]\s*\)|PLANGRAPH_BIN/m],
  ['bin/plangraph-merge', /plangraph-merge/],
  ['mcp/plangraph-mcp.ts', /plangraph-mcp\.(?:mjs|ts)/],
]);

/** Tier 1 / tier 2 test files for each target. @param {string} root @param {string[]} targets @param {string[]} tests
 * @returns {Map<string, { direct: string[], extended: string[] }>} */
export function testMap(root: string, targets: string[], tests: string[]) {
  /** @type {Map<string, string[]>} */ const graph = new Map();
  const read = (/** @type {string} */ f: string) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const deps = (/** @type {string} */ f: string) => {
    let d = graph.get(f);
    if (!d) {
      d = importsOf(read(f)).map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(f), s)));
      graph.set(f, d);
    }
    return d;
  };
  /** @param {string} f @returns {Set<string>} */
  const closure = (f: string) => { const seen = new Set([f]), stack = [f]; while (stack.length) for (const d of deps((stack.pop() as string))) if (!seen.has(d)) { seen.add(d); stack.push(d); } return seen; }; // as string: stack.length was tested
  const entries = new Map(ENTRY_PATTERNS.map(([e]) => [e, closure(e)]));
  const map = new Map();
  /** @type {Map<string, string[]>} */ const inProc = new Map();
  for (const target of targets) map.set(target, { direct: /** @type {string[]} */ ([]), extended: /** @type {string[]} */ ([]) });
  for (const test of tests) {
    const text = read(test), direct = new Set(deps(test)), imported = closure(test), reach = new Set(imported);
    for (const [e, re] of ENTRY_PATTERNS) if (re.test(text)) for (const f of (entries.get(e) as Set<string>)) reach.add(f); // as Set: every ENTRY_PATTERNS name has an entry
    for (const target of targets) {
      const m = map.get(target);
      if (direct.has(target)) m.direct.push(test);
      else if (reach.has(target) || (OVERRIDES[target] ?? []).includes(test)) { m.extended.push(test); if (imported.has(target)) inProc.set(target, [...(inProc.get(target) ?? []), test]); }
    }
  }
  for (const [target, extra] of Object.entries(TIER1_OVERRIDES)) {
    const m = map.get(target);
    if (!m) continue;
    for (const t of extra) if (tests.includes(t)) { if (!m.direct.includes(t)) m.direct.push(t); m.extended = m.extended.filter((/** @type {string} */ f: string) => f !== t); }
    m.direct.sort();
  }
  // a module under src/ (driven through the CLI) and a module no test imports directly also get the tests that load it in-process as
  // tier 1 (the tier-1 budget still moves the slow ones to tier 2)
  for (const [target, m] of map) {
    if ((m.direct.length && !target.startsWith('src/')) || !inProc.has(target)) continue;
    m.direct = [...new Set([...m.direct, ...(inProc.get(target) ?? [])])].sort(); m.extended = m.extended.filter((/** @type {string} */ f: string) => !m.direct.includes(f));
  }
  return map;
}

// ------------------------------------------------------------------ options
/** @typedef {{ tier1Budget: number, state: string | null, maxTier: number, files: string[] | null, limit: number, seed: number, shard: [number, number], jobs: number, timeoutFactor: number, fresh: boolean, list: boolean, json: string | null, informational: boolean }} Options */
/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv: string[]) {
  /** @type {Options} */
  const o: Options = { tier1Budget: 10000, state: null, maxTier: 2, files: null, limit: 0, seed: 1, shard: [1, 1], jobs: 1, timeoutFactor: 4, fresh: false, list: false, json: null, informational: false };
  const int = (/** @type {string | undefined} */ v: string | undefined, /** @type {string} */ name: string, min = 0) => {
    if (v === undefined || !/^\d+$/.test(v) || Number(v) < min || Number(v) > 1e9) throw new Error(`${name} needs a whole number >= ${min}`);
    return Number(v);
  };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--files') o.files = String(argv[++k] ?? '').split(',').filter(Boolean);
    else if (a === '--limit') o.limit = int(argv[++k], '--limit', 1);
    else if (a === '--seed') o.seed = int(argv[++k], '--seed');
    else if (a === '--jobs') o.jobs = int(argv[++k], '--jobs', 1);
    else if (a === '--max-tier') { o.maxTier = int(argv[++k], '--max-tier', 1); if (o.maxTier > 2) throw new Error('--max-tier is 1 or 2'); }
    else if (a === '--tier1-budget') o.tier1Budget = int(argv[++k], '--tier1-budget', 1);
    else if (a === '--timeout-factor') o.timeoutFactor = int(argv[++k], '--timeout-factor', 1);
    else if (a === '--shard') {
      const m = /^(\d+)\/(\d+)$/.exec(argv[++k] ?? '');
      if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error('--shard needs N/M with 1 <= N <= M');
      o.shard = [Number(m[1]), Number(m[2])];
    } else if (a === '--fresh') o.fresh = true;
    else if (a === '--state') { o.state = argv[++k] ?? null; if (!o.state) throw new Error('--state needs a directory'); }
    else if (a === '--list') o.list = true;
    else if (a === '--informational') o.informational = true;
    else if (a === '--json') { o.json = argv[++k] ?? null; if (!o.json) throw new Error('--json needs a file'); }
    else throw new Error(`unknown option ${a}`);
  }
  if (o.files && !o.files.length) throw new Error('--files needs at least one path');
  return o;
}

/** mulberry32, same as test/fixtures/gen.ts @param {number} seed */
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Deterministic selection: optional seeded sample of `limit`, then shard N/M by index, in source order. @template T
 * @param {T[]} items @param {Options} o @returns {T[]} */
export function select<T>(items: T[], o: Options): T[] {
  let idx = items.map((_, k) => k);
  if (o.limit && o.limit < idx.length) {
    const r = rng(o.seed);
    for (let k = idx.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [idx[k], idx[j]] = [idx[j], idx[k]]; }
    idx = idx.slice(0, o.limit).sort((a, b) => a - b);
  }
  const [n, m] = o.shard;
  return idx.filter((_, k) => k % m === n - 1).map((k) => items[k]);
}

// ------------------------------------------------------------------ equivalents
/** @typedef {{ file: string, line: string, mutated: string, why: string }} Equivalent */
/** @param {Mutant} m @param {Equivalent[]} list */
export const isEquivalent = (m: Mutant, list: Equivalent[]) => list.some((e) => e.file === m.file && e.line === m.lineText && e.mutated === m.mutatedLine);
/** @param {unknown} data @returns {Equivalent[]} */
export function checkEquivalents(data: unknown) {
  if (!Array.isArray(data)) throw new Error(`${EQUIVALENT_FILE} must be a JSON array`);
  for (const e of data) {
    if (!e || typeof e !== 'object' || ['file', 'line', 'mutated', 'why'].some((k) => typeof e[k] !== 'string' || !e[k])) throw new Error(`${EQUIVALENT_FILE}: every entry needs non-empty file, line, mutated and why`);
  }
  return data;
}

// ------------------------------------------------------------------ files and copies
/** files git would ship from the working tree: tracked plus untracked-not-ignored @param {string} root */
function repoFiles(root: string) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('git ls-files failed: run from a git checkout');
  return r.stdout.split('\0').filter((f) => f && fs.existsSync(path.join(root, f)) && fs.lstatSync(path.join(root, f)).isFile());
}
/** @param {string} root @param {string[]} files @param {string} dest */
export function makeCopy(root: string, files: string[], dest: string) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.copyFileSync(path.join(root, f), path.join(dest, f)); fs.chmodSync(path.join(dest, f), fs.statSync(path.join(root, f)).mode); }
  // tests that run `git ls-files` at the root need a repository: index every copied file (before node_modules is linked in), no hooks
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dest, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a[0]} failed in the mutation copy: ${r.stderr}`); };
  git('init', '-q'); git('add', '-A');
  fs.mkdirSync(path.join(dest, '.git', 'no-hooks'));
  git('config', 'core.hooksPath', path.join(dest, '.git', 'no-hooks'));
  fs.appendFileSync(path.join(dest, '.git', 'info', 'exclude'), 'node_modules\n');
  if (fs.existsSync(path.join(root, 'node_modules'))) fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(dest, 'node_modules'));
}
/** @param {string} pattern */
const globRe = (pattern: string) => new RegExp(`^${pattern.split('**').map((p) => p.split('*').map((q) => q.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
const sha = (/** @type {string} */ s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ------------------------------------------------------------------ running
/** @typedef {{ status: 'killed'|'timeout'|'survived'|'invalid'|'notests', tier?: number, upTo?: number, src: string, tests: string }} Result */
/** the last `n` lines of `text` */
export const tailLines = (text: string, n: number) => text.replace(/\n+$/, '').split('\n').slice(-n).join('\n');
/** Run test files in `cwd`; resolves 'fail' at the first failing test (the process group is killed unless `keep`), 'pass', or 'timeout'.
 * `out` holds the tail of the output (only kept when `keep`, for a baseline whose failure is shown to the person).
 * @param {string} cwd @param {string[]} files @param {number} timeout @param {number} conc @param {boolean} keep @returns {Promise<{ verdict: 'pass'|'fail'|'timeout', ms: number, out: string }>} */
function runTests(cwd: string, files: string[], timeout: number, conc: number, keep = false) {
  return new Promise<{ verdict: 'pass' | 'fail' | 'timeout'; ms: number; out: string }>((resolve) => {
    /** @type {NodeJS.ProcessEnv} */ const env: NodeJS.ProcessEnv = { ...process.env, PLANGRAPH_PERF_FACTOR: process.env.PLANGRAPH_PERF_FACTOR ?? '2' };
    delete env.NODE_TEST_CONTEXT;
    const t0 = performance.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `--test-concurrency=${conc}`, ...files], { cwd, env, detached: true, stdio: ['ignore', 'pipe', keep ? 'pipe' : 'ignore'] }) as ChildProcessByStdio<null, Readable, Readable | null>;
    let done = false, buf = '', all = '';
    const finish = (/** @type {'pass'|'fail'|'timeout'} */ v: 'pass' | 'fail' | 'timeout') => {
      if (done) return; done = true; clearTimeout(timer);
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      resolve({ verdict: v, ms: performance.now() - t0, out: all });
    };
    const timer = setTimeout(() => finish('timeout'), timeout);
    child.stdout.setEncoding('utf8');
    if (keep) { child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (d) => { all = (all + d).slice(-200000); }); }
    child.stdout.on('data', (d) => { if (keep) all = (all + d).slice(-200000); buf = (buf + d).slice(-4096); if (!keep && /^\s*not ok \d+/m.test(buf)) finish('fail'); else buf = buf.slice(buf.lastIndexOf('\n') + 1); });
    child.on('close', (code) => finish(code === 0 ? 'pass' : 'fail'));
    child.on('error', () => finish('fail'));
  });
}
/** @param {string} cwd @param {string} file @returns {Promise<boolean>} */
export function syntaxOk(cwd: string, file: string) {
  return new Promise((resolve) => {
    // `node --check` cannot parse some TypeScript (a generic call such as `new Set<string>()` reads as a comparison): a .ts file is checked
    // after its types are stripped, which also throws on a real syntax error; a plain .js file is checked as it is
    const args = file.endsWith('.ts')
      ? ['--no-warnings', '-e', "const m = require('node:module'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-syntax-')); try { const out = path.join(dir, 'x.mjs'); fs.writeFileSync(out, m.stripTypeScriptTypes(fs.readFileSync(process.argv[1], 'utf8'))); process.exitCode = cp.spawnSync(process.execPath, ['--check', out], { stdio: 'ignore' }).status; } catch { process.exitCode = 1; } finally { fs.rmSync(dir, { recursive: true, force: true }); }", file]
      : ['--check', file];
    const c = spawn(process.execPath, args, { cwd, stdio: 'ignore' });
    c.on('close', (code) => resolve(code === 0)); c.on('error', () => resolve(false));
  });
}

/** kill score in percent: timeouts are neither killed nor survived, so they leave both the numerator and the denominator (K13) */
export const scoreOf = (r: { mutants: number; killed: number; timeout: number; equivalent: number; invalid: number }) => {
  const denom = r.mutants - r.invalid - r.equivalent - r.timeout;
  return denom ? (100 * r.killed) / denom : 100;
};
/** the mutants whose run timed out, in generation order @param {Array<{ file: string, line: number, op: string }>} mutants @param {Array<{ status: string }>} results */
export const timeoutsOf = (mutants: Array<{ file: string; line: number; op: string }>, results: Array<{ status: string }>) =>
  mutants.flatMap((m, k) => (results[k]?.status === 'timeout' ? [{ file: m.file, line: m.line, op: m.op }] : []));
/** the report lines for test files whose unmutated run was red: the file and the tail of its output @param {Array<[string, string | undefined]>} red */
export const redReport = (red: Array<[string, string | undefined]>) =>
  red.flatMap(([f, tail]) => [`RED BASELINE ${f}: fails on the unmutated copy, left out of the mapping`, ...(tail ? tail.split('\n').map((l) => `  | ${l}`) : ['  | (no output kept: re-run with --fresh)'])]);

/** @param {string[]} argv */
async function main(argv: string[]) {
  /** @type {Options} */ let o: Options;
  try { o = parseArgs(argv); } catch (e) { console.error(`mutate-all: ${(e as Error).message}`); return 2; } // as Error: whatever parseArgs threw
  const files = repoFiles(ROOT);
  const patterns = (o.files ?? DEFAULT_TARGETS).map(globRe);
  const targets = files.filter((f) => isSource(f) && patterns.some((re) => re.test(f))).sort();
  if (!targets.length) { console.error('mutate-all: no target file matches'); return 2; }
  const tests = files.filter((f) => isTestFile(f) && !EXCLUDED_TESTS.has(f)).sort();
  /** @type {Mutant[]} */ let mutants = [];
  /** @type {Map<string, string>} */ const srcOf = new Map();
  for (const f of targets) { const s = fs.readFileSync(path.join(ROOT, f), 'utf8'); srcOf.set(f, s); mutants.push(...mutantsFor(f, s)); }
  const totalAll = mutants.length;
  mutants = select(mutants, o);
  if (o.list) { for (const m of mutants) console.log(`${m.file}:${m.line} [${m.op}] ${m.mutatedLine}`); console.log(`${mutants.length} of ${totalAll} mutants`); return 0; }
  const equivalents = checkEquivalents(JSON.parse(fs.readFileSync(path.join(ROOT, EQUIVALENT_FILE), 'utf8')));
  const map = testMap(ROOT, targets, tests);
  const fileHash = new Map(files.filter(isSource).map((f) => [f, sha(fs.readFileSync(path.join(ROOT, f), 'utf8'))]));

  const base = o.state ? path.resolve(o.state) : path.join(os.tmpdir(), 'plangraph-mutate-all', sha(ROOT));
  fs.mkdirSync(base, { recursive: true });
  const progressFile = path.join(base, 'progress.json');
  /** @type {{ results: Record<string, Result>, baseline: Record<string, { hash: string, ok: boolean, ms: number, tail?: string }> }} */
  let progress: { results: Record<string, Result>; baseline: Record<string, { hash: string; ok: boolean; ms: number; tail?: string }> } = { results: {}, baseline: {} };
  if (!o.fresh) { try { progress = JSON.parse(fs.readFileSync(progressFile, 'utf8')); } catch { /* none yet */ } }
  progress.results ??= {}; progress.baseline ??= {};
  let saveAt = 0;
  const save = (force = false) => {
    if (!force && Date.now() - saveAt < 2000) return;
    saveAt = Date.now();
    const tmp = `${progressFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(progress)); fs.renameSync(tmp, progressFile);
  };
  // the baseline of a test file is valid while every source file of the repo is unchanged
  // (the harness and its own test are left out: editing them does not change what the product tests see)
  const repoHash = sha([...fileHash].filter(([f]) => !/^(scripts\/mutate-all\.(mjs|ts)|test\/mutate-all\.test\.(mjs|ts))$/.test(f)).map(([f, h]) => `${f}:${h}`).join('\n'));
  const jobs = Math.max(1, o.jobs);
  const copies = Array.from({ length: jobs }, (_, k) => path.join(base, `work-${o.shard[0]}-${k}`));
  for (const c of copies) makeCopy(ROOT, files, c);
  const free = [...copies];
  const acquire = async () => { while (!free.length) await new Promise((r) => setTimeout(r, 20)); return (free.pop() as string); }; // as string: free.length was tested

  /** @type {Map<string, Promise<boolean>>} */ const baselineRuns = new Map();
  /** @param {string} test @returns {Promise<boolean>} */
  const green = (test: string) => {
    const b = progress.baseline[test];
    if (b && b.hash === repoHash) return Promise.resolve(b.ok);
    let p = baselineRuns.get(test);
    if (!p) {
      p = (async () => {
        const c = await acquire();
        try {
          const r = await runTests(c, [test], 600000, 1, true);
          progress.baseline[test] = { hash: repoHash, ok: r.verdict === 'pass', ms: Math.round(r.ms), ...(r.verdict === 'pass' ? {} : { tail: r.verdict === 'timeout' ? `timed out after 600 s\n${tailLines(r.out, 40)}` : tailLines(r.out, 40) }) };
          save();
          return r.verdict === 'pass';
        } finally { free.push(c); }
      })();
      baselineRuns.set(test, p);
    }
    return p;
  };
  const ms = (/** @type {string} */ test: string) => progress.baseline[test]?.ms ?? 5000;
  /** @param {string[]} list */
  const greenOnly = async (list: string[]) => { const ok = await Promise.all(list.map(green)); return list.filter((_, k) => ok[k]); };

  let done = 0; const t0 = Date.now();
  /** @param {Mutant} m @returns {Promise<Result>} */
  const runOne = async (m: Mutant) => {
    const tiers = map.get(m.file) ?? { direct: [], extended: [] };
    const testsHash = sha(`${MAPPING_VERSION}\n${tiers.direct.join(' ')}\n${[...tiers.direct, ...tiers.extended].map((f) => `${f}:${fileHash.get(f)}`).join('\n')}`);
    const src = (fileHash.get(m.file) as string); // as string: every mutant's file was hashed
    const prev = progress.results[mutantId(m)];
    if (prev && prev.src === src && (prev.status !== 'survived' && prev.status !== 'notests' || (prev.tests === testsHash && (prev.upTo ?? 2) >= o.maxTier))) return prev;
    /** @type {Result} */ let res: Result = { status: 'notests', src, tests: testsHash, upTo: o.maxTier };
    const orig = (srcOf.get(m.file) as string), mutated = applyMutant(orig, m); // as string: every mutant's file was read
    /** run `fn` on a copy holding the mutant; the copy is restored before it goes back to the pool @template T @param {(c: string) => Promise<T>} fn */
    const onCopy = async <T>(fn: (c: string) => Promise<T>) => {
      const c = await acquire();
      try { fs.writeFileSync(path.join(c, m.file), mutated); return await fn(c); } finally { fs.writeFileSync(path.join(c, m.file), orig); free.push(c); }
    };
    if (!(await onCopy((c) => syntaxOk(c, m.file)))) res = { status: 'invalid', src, tests: testsHash };
    else {
      // tier-1 files slower than the budget move to tier 2 (the fastest one always stays), so a survivor does not pay for every heavy
      // CLI test that happens to import the module; tier 2 runs them for whatever tier 1 left alive
      const direct = (await greenOnly(tiers.direct)).sort((x, y) => ms(x) - ms(y) || (x < y ? -1 : 1));
      const quick = direct.filter((f: string, k) => k === 0 || ms(f) <= o.tier1Budget), slow = direct.filter((f: string) => !quick.includes(f));
      for (const [tier, mapped] of ([[1, quick], [2, [...slow, ...tiers.extended]]] as Array<[number, string[]]>)) { // as Array: the literal pairs a tier number with a file list
        // baselines are computed lazily (tier 2 only for mutants tier 1 left alive); the fastest files run first
        const list = (tier === 1 ? mapped : await greenOnly(mapped)).sort((x, y) => ms(x) - ms(y) || (x < y ? -1 : 1));
        if (!list.length || tier > o.maxTier) continue;
        const conc = Math.min(list.length, tier === 1 ? 1 : 2); // one test process per job in tier 1: --jobs J uses about J cores
        const sum = list.reduce((acc: number, f: string) => acc + ms(f), 0), longest = Math.max(...list.map(ms));
        const timeout = 10000 + o.timeoutFactor * Math.max(longest, sum / conc);
        const r = await onCopy((c) => runTests(c, list, timeout, conc));
        if (r.verdict === 'pass') { res = { status: 'survived', src, tests: testsHash, upTo: o.maxTier }; continue; }
        res = { status: r.verdict === 'timeout' ? 'timeout' : 'killed', tier, src, tests: testsHash };
        break;
      }
    }
    progress.results[mutantId(m)] = res;
    save();
    done++;
    if (process.stderr.isTTY || done % 25 === 0) process.stderr.write(`mutate-all: ${done} run, ${Math.round((Date.now() - t0) / 1000)} s\r`);
    return res;
  };
  /** @type {Result[]} */ const results = new Array(mutants.length);
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => { while (next < mutants.length) { const k = next++; results[k] = await runOne(mutants[k]); } }));
  save(true);
  for (const c of copies) fs.rmSync(c, { recursive: true, force: true });

  // ---------------------------------------------------------------- report
  /** @type {Map<string, { mutants: number, killed: number, timeout: number, survived: number, equivalent: number, invalid: number, notests: number }>} */
  const rows = new Map();
  const survivors = [];
  for (let k = 0; k < mutants.length; k++) {
    const m = mutants[k], r = results[k];
    let row = rows.get(m.file);
    if (!row) rows.set(m.file, row = { mutants: 0, killed: 0, timeout: 0, survived: 0, equivalent: 0, invalid: 0, notests: 0 });
    row.mutants++;
    if (r.status === 'killed') row.killed++;
    else if (r.status === 'timeout') row.timeout++;
    else if (r.status === 'invalid') row.invalid++;
    else if (isEquivalent(m, equivalents)) row.equivalent++;
    else { if (r.status === 'notests') row.notests++; row.survived++; survivors.push(m); }
  }
  const score = scoreOf;
  const pad = (/** @type {unknown} */ v: unknown, /** @type {number} */ n: number) => String(v).padStart(n);
  const lines = [`${'file'.padEnd(34)} ${pad('mutants', 7)} ${pad('killed', 7)} ${pad('timeout', 7)} ${pad('survived', 8)} ${pad('equiv', 5)} ${pad('invalid', 7)} ${pad('score', 7)}`];
  const total = { mutants: 0, killed: 0, timeout: 0, survived: 0, equivalent: 0, invalid: 0, notests: 0 };
  for (const [f, r] of [...rows].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const k of (Object.keys(total) as Array<keyof typeof total>)) total[k] += r[k]; // as Array: the keys of total are its own fields
    lines.push(`${f.padEnd(34)} ${pad(r.mutants, 7)} ${pad(r.killed, 7)} ${pad(r.timeout, 7)} ${pad(r.survived, 8)} ${pad(r.equivalent, 5)} ${pad(r.invalid, 7)} ${pad(score(r).toFixed(1), 6)}%`);
  }
  lines.push(`${'total'.padEnd(34)} ${pad(total.mutants, 7)} ${pad(total.killed, 7)} ${pad(total.timeout, 7)} ${pad(total.survived, 8)} ${pad(total.equivalent, 5)} ${pad(total.invalid, 7)} ${pad(score(total).toFixed(1), 6)}%`);
  for (const l of lines) console.log(l);
  const timeouts = timeoutsOf(mutants, results);
  if (timeouts.length) console.log(`${timeouts.length} mutant(s) timed out: neither killed nor survived, left out of the score`);
  for (const t of timeouts) console.log(`TIMEOUT ${t.file}:${t.line} [${t.op}]`);
  const red = Object.entries(progress.baseline).filter(([, b]) => b.hash === repoHash && !b.ok);
  if (red.length) { console.log(`test files red on the unmutated copy, left out of the mapping: ${red.map(([f]) => f).join(' ')}`); for (const l of redReport(red.map(([f, b]) => [f, b.tail]))) console.log(l); }
  const unreached = targets.filter((f) => { const t = map.get(f); return !t || (!t.direct.length && !t.extended.length); });
  if (unreached.length) console.log(`no mapped test file: ${unreached.join(' ')}`);
  for (const m of survivors) console.log(`SURVIVED ${m.file}:${m.line} [${m.op}] ${m.mutatedLine.slice(0, 200)}`);
  const used = new Set(mutants.filter((m: Mutant) => isEquivalent(m, equivalents)).map((m: Mutant) => `${m.file}\0${m.lineText}\0${m.mutatedLine}`));
  const scopeAll = !o.limit && o.shard[1] === 1 && !o.files;
  const staleEq = scopeAll ? equivalents.filter((e) => !used.has(`${e.file}\0${e.line}\0${e.mutated}`)) : [];
  for (const e of staleEq) console.log(`STALE EQUIVALENT (no such mutant now): ${e.file}: ${e.mutated}`);
  if (o.json) fs.writeFileSync(o.json, `${JSON.stringify({ rows: Object.fromEntries(rows), total, score: score(total), timeouts, survivors: survivors.map((m) => ({ file: m.file, line: m.line, op: m.op, mutated: m.mutatedLine })) }, null, 1)}\n`);
  if (o.informational && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### mutation smoke (informational)\n\n\`\`\`\n${lines.join('\n')}\n${survivors.map((m) => `SURVIVED ${m.file}:${m.line} ${m.mutatedLine.slice(0, 160)}`).join('\n')}\n\`\`\`\n`);
  }
  if (o.informational) return 0;
  return survivors.length || staleEq.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
