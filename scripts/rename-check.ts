// The command-word half of the 0.3.0 rename (`brain` -> `plangraph`) as ONE ordered rule list, and the check that proves the goldens,
// eval cases and fixtures followed it exactly. The old tree's file (at `--before <git-ref>`) gets the rules applied to its path and its
// text; the working-tree file must then be byte-equal, except the listed deliberate files (each with its reason). Nothing here guesses.
// Usage: node scripts/rename-check.ts --before <git-ref> [--write] [--root <dir>]
//   (no flag)  report: `same: N`, `deliberate: M`, then one line per unexpected difference and per missing file; exit 1 when any
//   --write    write the mapped text to the new path for every file that is not deliberate (this is how goldens are regenerated)
// Old names are assembled from pieces so that this file names them only here.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const B = 'brain';
const SKILLS = 'audit|autopilot|init|onboard|plan|report';
const NOT_WORD = '(?![A-Za-z0-9_])';
const NOT_AFTER = '(?<![A-Za-z0-9_])(?<!open-)(?<!project-)';
const rule = (src: string, to: string): readonly [RegExp, string] => [new RegExp(src, 'g'), to];

/** Old text to new text, applied in this order: regex escapes, error names, skill names (a quoted or backticked skill is its bare name,
 * `plangraph:<name>` in prose), file names, prose, then the bare word. */
export const RULES: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  rule(`\\(\\?:${B}\\(\\?:-\\[a-z\\]\\+\\)\\?\\|whatif\\)`, '(?:plangraph|' + SKILLS + '|whatif)'), // the grader's "any plugin skill" alternation
  rule(`(\\\\+b)${B}${NOT_WORD}`, '$1plangraph'),
  rule(`NO_${B.toUpperCase()}_MESSAGE`, 'NO_PLANGRAPH_MESSAGE'),
  rule(`NO_${B.toUpperCase()}${NOT_WORD}`, 'NO_PLANGRAPH'),
  rule(`${B[0].toUpperCase()}${B.slice(1)}Error`, 'PlangraphError'),
  rule(`(['"])${B}-(${SKILLS})\\1`, '$1$2$1'),
  rule(`trigger-${B}-(${SKILLS})${NOT_WORD}`, 'trigger-$1'),
  rule(`\`${B}-(${SKILLS})\``, '`plangraph:$1`'),
  rule(`${NOT_AFTER}${B}-(${SKILLS})(?= skill)`, 'plangraph:$1'),
  rule(`(?<=\\|)${B}-(${SKILLS})${NOT_WORD}`, '$1'),
  rule(`(?<=\\(\\?:)${B}-(${SKILLS})${NOT_WORD}`, '$1'),
  rule(`plangraph:${B}-(${SKILLS})${NOT_WORD}`, 'plangraph:$1'),
  rule(`plangraph:${B}${NOT_WORD}`, 'plangraph:plangraph'),
  rule(`skills/${B}-(${SKILLS})${NOT_WORD}`, 'skills/$1'),
  rule(`skills/${B}${NOT_WORD}`, 'skills/plangraph'),
  rule(`${NOT_AFTER}${B}-(solve-run|solve|merge|mcp)${NOT_WORD}`, 'plangraph-$1'),
  rule(`no${B}${NOT_WORD}`, 'noplangraph'),
  rule(`the project ${B}${NOT_WORD}`, 'plangraph'),
  rule(`${NOT_AFTER}the ${B} directory${NOT_WORD}`, 'the plan directory'),
  rule(`${NOT_AFTER}${B} directory${NOT_WORD}`, 'plan directory'),
  rule(`${NOT_AFTER}${B} dir${NOT_WORD}`, 'plan dir'),
  rule(`${NOT_AFTER}${B} data${NOT_WORD}`, 'plan data'),
  rule(`${NOT_AFTER}the ${B}'s${NOT_WORD}`, "plangraph's"),
  rule(`${NOT_AFTER}the ${B}(?= (?:is|has|does|and|or|will|would|can|now|only|never)${NOT_WORD}|['.,;:)])`, 'plangraph'),
  rule(`${NOT_AFTER}the ${B}${NOT_WORD}`, 'the plangraph'),
  rule(`${NOT_AFTER}${B}${NOT_WORD}`, 'plangraph'),
] as const);

/** The text with every rule applied. @param {string} text */
export const mapText = (text: string): string => RULES.reduce((s, [re, to]) => s.replace(re, to), text);
/** A path with the rules applied (`err-nobrain-x.txt` -> `err-noplangraph-x.txt`). */
export const mapPath = (p: string): string => mapText(p);

/** Files under these prefixes follow the rules; each is compared with its mapped old twin. */
export const CHECKED = Object.freeze(['test/golden/', 'test/fixtures/', 'evals/cases/']);
/** Files that differ from the mapped old file on purpose, with the reason. A JSON file maps to `{ key: reason }` instead: only those
 * top-level entries may differ (they must exist), every other entry must be byte-equal. Everything not listed must be byte-equal. */
export type Deliberate = Readonly<Record<string, string | Readonly<Record<string, string>>>>;
const HASH = 'the text the hash covers is longer (plangraph for the old word)';
const TOKENS = 'estimated tokens (bytes / 4, rounded up) of output that now says plangraph';
export const DELIBERATE: Deliberate = Object.freeze({
  'test/golden/card-write.txt': TOKENS,
  'test/golden/open-items-suggest.txt': `the <untrusted n=...> nonce is a ${HASH}`,
  'test/golden/open-items-suggest-json.txt': `the <untrusted n=...> nonce is a ${HASH}`,
  'test/golden/refs-update.txt': 'the fixture commit hash: the committed .gitattributes and directory name changed in the 0.3.0 rename',
  'test/golden/stale.txt': 'the fixture commit hash (see refs-update)',
  'test/golden/stale-list.txt': 'the fixture commit hash (see refs-update)',
  'test/golden/mutation-kills/cli.json': { writes: TOKENS },
  'test/golden/mutation-kills/forecast.json': { 'fc-refuse-loop': TOKENS },
  'test/golden/mutation-kills/integrations.json': { 'ow-status-sweep': `a nonce hash: the hashed text is longer` },
  'test/golden/mutation-kills/render.json': { 'card-sweep': 'a sweep of prefixes of the card line, whose first word is longer', 'card-fine-sweep': 'same', 'card-sweep-stale': 'same' },
  'test/golden/mutation-kills/report.json': { 'report-limits-html': 'the HTML length: plangraph is 4 bytes longer than the old word, twice in the page' },
});

const git = (root: string, ...args: string[]): Buffer => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });

/** Two JSON objects are equal when every entry but `keys` is byte-equal (as JSON text) and each listed key is present in both. */
function sameExcept(a: string, b: string, keys: string[]): boolean {
  try {
    const x = JSON.parse(a) as Record<string, unknown>, y = JSON.parse(b) as Record<string, unknown>;
    if (JSON.stringify(Object.keys(x)) !== JSON.stringify(Object.keys(y))) return false;
    return Object.keys(x).every((k) => keys.includes(k) || JSON.stringify(x[k]) === JSON.stringify(y[k])) && keys.every((k) => k in x && k in y);
  } catch { return false; }
}

export interface Result { same: string[]; deliberate: string[]; differ: string[]; missing: string[] }
/** Compare (and optionally write) the mapped files of `before` against the working tree of `root`. */
export function check(root: string, before: string, { write = false, deliberate = DELIBERATE }: { write?: boolean; deliberate?: Deliberate } = {}): Result {
  if (before.startsWith('-')) throw new Error('--before must be a git ref, not an option');
  const files = git(root, 'ls-tree', '-r', '--name-only', '-z', before).toString('utf8').split('\0').filter((f) => CHECKED.some((p) => f.startsWith(p)));
  const r: Result = { same: [], deliberate: [], differ: [], missing: [] };
  for (const f of files) {
    const to = mapPath(f), listed = Object.hasOwn(deliberate, to) ? deliberate[to] : undefined, isDeliberate = listed !== undefined;
    const want = mapText(git(root, 'show', `${before}:${f}`).toString('utf8'));
    if (write && !isDeliberate) { fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true }); fs.writeFileSync(path.join(root, to), want); }
    let have: string | null = null;
    try { have = fs.readFileSync(path.join(root, to), 'utf8'); } catch { /* missing */ }
    if (have === null) r.missing.push(to);
    else if (typeof listed === 'object') (sameExcept(want, have, Object.keys(listed)) ? r.deliberate : r.differ).push(to);
    else if (isDeliberate) r.deliberate.push(to);
    else (have === want ? r.same : r.differ).push(to);
  }
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const before = opt('before'), root = path.resolve(opt('root') ?? path.join(import.meta.dirname, '..'));
  if (!before) { process.stderr.write('usage: rename-check.ts --before <git-ref> [--write] [--root <dir>]\n'); process.exit(2); }
  let r: Result;
  try { r = check(root, before, { write: argv.includes('--write') }); } catch (e) { process.stderr.write(`rename-check: ${(e as Error).message}\n`); process.exit(2); } // as Error: whatever git or fs threw
  process.stdout.write(`same: ${r.same.length}\ndeliberate: ${r.deliberate.length}\n${r.differ.map((f) => `  differs: ${f}\n`).join('')}${r.missing.map((f) => `  missing: ${f}\n`).join('')}`);
  process.exitCode = r.differ.length || r.missing.length ? 1 : 0;
}
