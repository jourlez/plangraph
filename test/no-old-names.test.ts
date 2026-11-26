// After the 0.3.0 rename no tracked file may name the old plugin: its command word, its variable prefix or its config folder name. Exempt
// are the files that must name the old names (the migration, its tests, the baseline and re-pin tools), the config key that keeps its
// name until the format-2 migration, superpowers' own skill names that merely start with the old word, and history (past CHANGELOG
// entries, research, plans and specs dated up to the rename, the owner's decision log, the controller's task reports). The old names
// are assembled below so that this file does not name them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const W = 'br' + 'ain';
const OLD = new RegExp(`(?<![A-Za-z0-9_])${W}(?![A-Za-z0-9_])|${W.toUpperCase()}_|project-${W}`);

const EXEMPT = new Set([
  'test/env-names.test.ts', 'scripts/baseline.ts', 'test/baseline.test.ts', 'scripts/repin.ts', 'test/repin.test.ts',
  'docs/audit/compat-inventory.md', // lists the old names it proposes to remove
  'test/superpowers-ingest.test.ts', // cites the historical plan file `2026-11-22-project-<old>-excellence.md`
  'CHANGELOG.md', 'PENDING_DECISIONS.md', // history
  'docs/superpowers/plans/2026-11-26-graph-v2-requoted.md', // the graph brief carries the old-to-new name map
]);
const RENAME_DATE = '2026-11-25'; // plans and specs of that day define the rename (the name map) or amend plans that predate it, so they name the old names too
/** True for a file that may name the old names: the exempt list, research, the controller's reports and dated plans and specs before the rename. */
export function exempt(file: string): boolean {
  if (EXEMPT.has(file) || file.startsWith('docs/research/') || file.startsWith('.superpowers/') || file.startsWith('test/fixtures/release-')) return true; // a frozen release keeps the names of its time (scripts/freeze-release.ts)
  const m = /^docs\/superpowers\/(?:plans|specs)\/(\d{4}-\d{2}-\d{2})-/.exec(file);
  return m !== null && m[1] <= RENAME_DATE;
}
/** The 1-based line numbers of `text` that name an old name. */
export const strays = (text: string): number[] => text.split('\n').flatMap((l, i) => (OLD.test(l) ? [i + 1] : []));

test('no tracked file outside the exemptions names the old plugin', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean).filter((f) => !exempt(f));
  assert.ok(files.length > 300, `scanned ${files.length} files`);
  const found: string[] = [];
  for (const f of files) {
    let text: string;
    try { const b = fs.readFileSync(path.join(ROOT, f)); if (b.includes(0)) continue; text = b.toString('utf8'); } catch { continue; }
    for (const n of strays(text)) found.push(`${f}:${n}`);
  }
  assert.deepEqual(found, []);
});

test('the scan can fail: it flags the word, the variable prefix and the old config folder, and nothing it must keep', () => {
  assert.deepEqual(strays(`ok\nrun ${W} doctor\n.${W}/x\nhow ${W.toUpperCase()}_DIR is read\n~/.config/project-${W}/y\nmerge=${W}-jsonl\n`), [2, 3, 4, 5, 6]);
  assert.deepEqual(strays(`${W}storming ${W}_rules_version no${W} ${W}Dir resolve${W[0].toUpperCase()}${W.slice(1)}Dir plangraph\n`), []);
  assert.equal(exempt('src/cli.ts'), false);
  assert.equal(exempt('test/fixtures/release-1.0.0/lib/x.ts'), true);
  assert.equal(exempt('docs/superpowers/plans/2026-11-25-plangraph-0.3.0-revised.md'), true);
  assert.equal(exempt('docs/superpowers/plans/2026-11-26-later.md'), false);
  assert.equal(exempt('docs/ADOPT.md'), false);
  assert.equal(exempt('docs/superpowers/plans/2026-11-24-zero-gaps-0.3.0.md'), true);
  assert.equal(exempt('docs/research/x/y.md'), true);
  assert.equal(exempt('CHANGELOG.md'), true);
});
