// Timing file (Task 21A): compileHeading's find and nextIndex scale linearly with the text; ratios between sizes, no absolute limit.
// The deterministic twin without a clock is the work-count test of test/gitsafe.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileHeading } from '../lib/gitsafe.ts';
import { scaling } from './helpers/perf.ts';

test('compileHeading: the worst allowed template stays linear on # runs (find and nextIndex, n vs 4n)', () => {
  const worst = compileHeading('#{1,99}#### {id}');
  const s = scaling((n: number) => { const t = `${'#'.repeat(n)}x`; worst.find(t, '1'); worst.nextIndex(t); }, 1 << 18);
  assert.ok(s.ratio < s.maxRatio, `worst-template scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at n, ${s.large.toFixed(1)} ms at 4n; linear ~4, quadratic ~16)`);
});
// Size axis: find() and nextIndex() over hostile plan text of n and 4n characters (min of 3 each): linear gives about 4x, quadratic about 16x.
// Proved by a deliberately quadratic nextIndex (a search from every offset), which scripts/mutate.ts keeps applying.
test('compileHeading: find and nextIndex scale linearly with the text (n vs 4n, worst allowed templates, hostile texts)', () => {
  const hs = ['^#{2,3} Task {id}:', '#{0,99} {id}', '#{1,99}#### x{id}', 'Task {id}:', '{id}'].map((t) => compileHeading(t));
  const texts = [(n: number) => `${'#'.repeat(n)}x`, (n: number) => '## Task 1.\n'.repeat(Math.ceil(n / 11)), (n: number) => `${'#'.repeat(98)} `.repeat(Math.ceil(n / 99))];
  const s = scaling((n: number) => { for (const mk of texts) { const t = mk(n); for (const h of hs) { h.find(t, '1.2'); h.nextIndex(t); } } }, 40000);
  assert.ok(s.ratio < s.maxRatio, `compileHeading scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at n, ${s.large.toFixed(1)} ms at 4n; linear ~4, quadratic ~16)`);
});
