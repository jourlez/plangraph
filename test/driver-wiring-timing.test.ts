// Timing file (Task 21A): the merge-driver wiring scales linearly with the .gitattributes size; a ratio between two sizes, no absolute limit.
// The deterministic twin without a clock is the `work:` test of test/driver-wiring.test.ts.
import baseTest, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as S from '../lib/store.ts';
import { scaling } from './helpers/perf.ts';

const test = (name: string, fn: () => void | Promise<void>) => baseTest(name, { skip: process.platform === 'win32' }, fn);
const made: string[] = [];
const tmp = (p = 'dw-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const BASE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });

// Size axis: the wiring path (installMergeDriver, then doctorMergeDriver) over a .gitattributes of n and 4n lines (4n stays under the
// 256 KiB cap), in process, min of 3 each (test/helpers/perf.ts scaling): the git config calls are a constant part, so linear stays
// near 1x and quadratic heads for 16x. The plangraph line is last (both scans read every line) and already present (nothing is written).
// Proved by a deliberately quadratic line scan in doctorMergeDriver (ratio about 12), which scripts/mutate.ts keeps applying.
test('timing: merge-driver wiring scales linearly with the .gitattributes size (n vs 4n lines, in process, min of 3)', () => {
  const n = 3500, repos = new Map();
  for (const m of [n >> 2, n, 4 * n]) {
    const d = tmp('dw-attr-'); git(d, 'init', '-q');
    fs.writeFileSync(path.join(d, '.gitattributes'), `${Array.from({ length: m }, (_, i) => `d${i} -text`).join('\n')}\n.plangraph/*.jsonl merge=plangraph-jsonl\n`);
    repos.set(m, d);
  }
  assert.ok(fs.statSync(path.join(repos.get(4 * n), '.gitattributes')).size < S.GITATTRIBUTES_MAX);
  const wire = (m: number) => {
    const d = repos.get(m);
    S.installMergeDriver(d, { dir: '.plangraph', driverPath: '/opt/plangraph/plangraph-merge' });
    assert.equal(S.doctorMergeDriver(d, { dir: '.plangraph' }).attributes, true);
  };
  const s = scaling(wire, n);
  console.log(`# wiring ms: ${s.small.toFixed(1)} at ${n} lines, ${s.large.toFixed(1)} at ${4 * n} (ratio ${s.ratio.toFixed(1)})`);
  assert.ok(s.ratio < s.maxRatio, `wiring scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at ${n} lines, ${s.large.toFixed(1)} ms at ${4 * n}; linear ~1-4, quadratic ~16)`);
});

