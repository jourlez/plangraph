// Type-check ratchet (dev only; needs the devDependency `typescript`, installed with `npm ci`). Runs tsc twice:
//   tsconfig.json         non-strict, every checked file (lib, src, scripts, test)
//   tsconfig.strict.json  strict, counted only for the files its "include" list names (imports outside it are checked by the first run)
// and counts errors per file. Exit 1 when any count is above scripts/typecheck-baseline.json (a new error anywhere fails), 2 when tsc
// cannot run, else 0. A count below the baseline is reported so the baseline can be lowered by hand; it is never raised by this script.
// Usage: npm run typecheck   (node scripts/typecheck.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_OUTPUT = 1 << 26; // 64 MiB of tsc output is far beyond any real run
const LINE = /^([^\s(][^(]*)\(\d+,\d+\): error TS\d+:/;
const GLOBAL = /^error TS\d+:/; // a config or option error has no file position

/** Errors per file from tsc's plain-text output; an error without a file position counts under '(tsc)'.
 * @param {string} text @returns {Map<string, number>} */
export function parseTsc(text) {
  const counts = new Map();
  for (const line of String(text).split('\n')) {
    const m = LINE.exec(line), key = m ? m[1].split(path.sep).join('/') : GLOBAL.test(line) ? '(tsc)' : null;
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Keep only the files that match one of the glob patterns (and '(tsc)', which always counts).
 * @param {Map<string, number>} counts @param {string[]} patterns @returns {Map<string, number>} */
export function scoped(counts, patterns) {
  return new Map([...counts].filter(([f]) => f === '(tsc)' || patterns.some((p) => path.posix.matchesGlob(f, p))));
}

/** Files whose count rose above the baseline (a file absent from the baseline has a baseline of 0), and files whose count fell.
 * @param {Record<string, number>} baseline @param {Map<string, number>} current
 * @returns {{ rises: Array<[string, number, number]>, drops: Array<[string, number, number]> }} [file, baseline, now] */
export function compare(baseline, current) {
  const rises = [], drops = [];
  const files = [...new Set([...Object.keys(baseline), ...current.keys()])].sort();
  for (const f of files) {
    const was = Object.hasOwn(baseline, f) ? baseline[f] : 0, now = current.get(f) ?? 0;
    if (now > was) rises.push(/** @type {[string, number, number]} */ ([f, was, now]));
    else if (now < was) drops.push(/** @type {[string, number, number]} */ ([f, was, now]));
  }
  return { rises, drops };
}

/** @param {string} config @returns {Map<string, number> | null} null when tsc could not run */
function runTsc(config) {
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(tsc)) return null;
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', config], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 600000 });
  if (r.error || (r.status !== 0 && r.status !== 1 && r.status !== 2)) return null;
  return parseTsc(`${r.stdout}\n${r.stderr}`);
}

/** @param {string} p @returns {any} */
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function main() {
  const baseline = readJson('scripts/typecheck-baseline.json');
  const strictScope = readJson('tsconfig.strict.json').include;
  const runs = [['non-strict', 'tsconfig.json', null], ['strict', 'tsconfig.strict.json', strictScope]];
  let failed = false;
  for (const [name, config, scope] of /** @type {Array<[string, string, string[] | null]>} */ (runs)) {
    const all = runTsc(config);
    if (all === null) { console.error('typecheck: tsc did not run (install the dev dependencies with `npm ci`)'); return 2; }
    const counts = scope ? scoped(all, scope) : all;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const { rises, drops } = compare(baseline[name] ?? {}, counts);
    for (const [f, was, now] of rises) console.error(`typecheck: ${name}: ${f}: ${was} -> ${now} errors (above the baseline)`);
    for (const [f, was, now] of drops) console.log(`typecheck: ${name}: ${f}: ${was} -> ${now} errors (lower the baseline in scripts/typecheck-baseline.json)`);
    console.log(`typecheck: ${name}: ${total} error(s)`);
    if (rises.length) failed = true;
  }
  if (failed) console.error('typecheck: error count rose; run `npx tsc --noEmit -p tsconfig.json` or `-p tsconfig.strict.json` for details');
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
