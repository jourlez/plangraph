// SOURCE_DATE_EPOCH makes "today" injectable: the same value gives the same bytes, another value another date, and a parent value
// never leaks into a harness that forces its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { sourceNow, isoDay } from '../lib/clock.ts';
import { readPlanFile } from './helpers/plan-dir.ts';

// a nested `node --test` must not inherit the parent run's context, or Node warns that run() is called recursively
const { NODE_TEST_CONTEXT: _ctx, ...CLEAN_ENV } = process.env;

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const D1 = 1795305600; // 2026-11-22T00:00:00Z
const D2 = D1 + 86400;
const ENV = (epoch?: number) => ({ PATH: process.env.PATH, HOME: os.tmpdir(), LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...(epoch === undefined ? {} : { SOURCE_DATE_EPOCH: String(epoch) }) });
const plangraph = (cwd: string, epoch: number | undefined, ...a: string[]) => { const r = spawnSync(process.execPath, [BRAIN, ...a], { cwd, env: ENV(epoch), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

function repo(epoch: number) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-clock-')));
  execFileSync('git', ['init', '-q'], { cwd: root, env: ENV() });
  plangraph(root, epoch, 'init'); plangraph(root, epoch, 'build');
  plangraph(root, epoch, 'open-items', '--register', 'T-1', 'followup', '--owner', 'Ana', '--text', 'x', '--write');
  plangraph(root, epoch, 'build');
  plangraph(root, epoch, 'open-items', '--close', 'T-1', 'followup', '--write');
  plangraph(root, epoch, 'build');
  return root;
}
const observe = (epoch: number) => { const root = repo(epoch); return { items: readPlanFile(path.join(root, '.plangraph'), 'open-items.jsonl'), line: plangraph(root, epoch, 'card', '--line') }; };

test('sourceNow: honors a valid SOURCE_DATE_EPOCH, ignores everything else', () => {
  const clock = () => new Date(5000);
  assert.equal(sourceNow({ SOURCE_DATE_EPOCH: String(D1) }, clock).toISOString(), '2026-11-22T00:00:00.000Z');
  for (const bad of ['', ' ', 'abc', '-1', '1.5', '1e3', 'Infinity', 'NaN', '0x10', '99999999999999999999']) assert.equal(sourceNow({ SOURCE_DATE_EPOCH: bad }, clock).getTime(), 5000, JSON.stringify(bad));
  assert.equal(sourceNow({}, clock).getTime(), 5000);
  assert.equal(sourceNow({ SOURCE_DATE_EPOCH: '0' }, clock).getTime(), 0);
  assert.equal(isoDay(new Date(D2 * 1000)), '2026-11-23');
});

test('close and card --line: the date follows SOURCE_DATE_EPOCH', () => {
  const a = observe(D1), a2 = observe(D1), b = observe(D2);
  assert.match(a.items, /"closed_at":"2026-11-22"/);
  assert.match(b.items, /"closed_at":"2026-11-23"/);
  assert.equal(a.items, a2.items); assert.equal(a.line, a2.line);
  assert.notEqual(a.line, b.line);
});

test('the golden harness forces its own epoch over the parent environment', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'golden.test.ts'), 'utf8');
  assert.match(src, /SOURCE_DATE_EPOCH: '1795305600'/);
  const run = (parent: Record<string, string>) => spawnSync(process.execPath, ['--test', '--test-name-pattern=golden: (open-items-findings|card-line)', path.join(import.meta.dirname, 'golden.test.ts')], { env: { ...CLEAN_ENV, ...parent }, encoding: 'utf8' });
  const r = run({ SOURCE_DATE_EPOCH: String(D2) });
  assert.equal(r.status, 0, r.stdout.slice(-1500));
});
