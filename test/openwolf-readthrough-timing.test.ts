// Timing file (Task 21A): the OpenWolf parsers stay linear on hostile lines (N vs 4N, in a child process, ratio only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { factor } from './helpers/perf.ts';

const MOD = path.join(import.meta.dirname, '../lib/integrations/openwolf.ts');

// ---------- linear time (child process; a ratio between two sizes, never an absolute limit) ----------
test('parsers are linear: 4x longer hostile lines take about 4x (not 16x) as long', () => {
  // The child times the whole hostile set at N and at 4N (min of 3 and 2 runs); a backtracking or quadratic parser blows the ratio
  // (16x or worse) . Relative timing is immune to a uniformly loaded machine.
  const script = `
    import { parseCerebrum, parseStatus, scanKeys } from ${JSON.stringify(MOD)};
    const once = (N) => {
      const lines = [' '.repeat(N) + 'x', '\\t'.repeat(N) + '#', '1.'.repeat(N / 2), '#'.repeat(N) + ' ', '\`'.repeat(N), '- ' + '[2031-01-01'.repeat(N / 11),
        '<!--'.repeat(N / 4), '-->'.repeat(N / 3) + '<!--', 'A-'.repeat(N / 2) + '1', 'sp:'.repeat(N / 3), '-'.repeat(N) + '!', ' \\r'.repeat(N / 2), '## ' + ' '.repeat(N) + '!'];
      const t0 = performance.now();
      for (const l of lines) { parseCerebrum('## Do-Not-Repeat\\n- ' + l + '\\n  ' + l + '\\n' + l); parseStatus('## Next\\n- ' + l + '\\n' + l); scanKeys(l); }
      return performance.now() - t0;
    };
    const best = (N, reps) => { let m = Infinity; for (let k = 0; k < reps; k++) m = Math.min(m, once(N)); return m; };
    const U = 1024 * 1024; once(U / 8);
    const small = best(U / 2, 3), large = best(2 * U, 2);
    console.log(JSON.stringify({ small, large }));`;
  // Timing noise (GC, a busy machine) can inflate one measurement; a truly super-linear parser is slow in EVERY attempt, so the best of 3 is judged.
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(r.stdout.trim());
    if (!best || m.large / Math.max(m.small, 1) < best.large / Math.max(best.small, 1)) best = m;
    if (best.large / Math.max(best.small, 1) < 9 * factor()) break;
  }
  const { small, large } = best;
  assert.ok(large / Math.max(small, 1) < 9 * factor(), `not linear: N took ${small.toFixed(0)} ms, 4N took ${large.toFixed(0)} ms (best of 3 attempts)`);
});

