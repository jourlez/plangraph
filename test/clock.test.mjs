// SOURCE_DATE_EPOCH makes "today" injectable: the same value gives the same bytes, another value another date, and a parent value
// never leaks into a harness that forces its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { sourceNow, isoDay } from '../lib/clock.mjs';

const BRAIN = path.join(import.meta.dirname, '../bin/brain');
const D1 = 1795305600; // 2026-11-22T00:00:00Z
const D2 = D1 + 86400;
const ENV = (epoch) => ({ PATH: process.env.PATH, HOME: os.tmpdir(), LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', BRAIN_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...(epoch === undefined ? {} : { SOURCE_DATE_EPOCH: String(epoch) }) });
const brain = (cwd, epoch, ...a) => { const r = spawnSync(process.execPath, [BRAIN, ...a], { cwd, env: ENV(epoch), encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

function repo(epoch) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-clock-')));
  execFileSync('git', ['init', '-q'], { cwd: root, env: ENV() });
  brain(root, epoch, 'init'); brain(root, epoch, 'build');
  brain(root, epoch, 'open-items', '--register', 'T-1', 'followup', '--owner', 'Ana', '--text', 'x', '--write');
  brain(root, epoch, 'build');
  brain(root, epoch, 'open-items', '--close', 'T-1', 'followup', '--write');
  brain(root, epoch, 'build');
  return root;
}
const observe = (epoch) => { const root = repo(epoch); return { items: fs.readFileSync(path.join(root, '.brain/open-items.jsonl'), 'utf8'), line: brain(root, epoch, 'card', '--line') }; };

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
  const src = fs.readFileSync(path.join(import.meta.dirname, 'golden.test.mjs'), 'utf8');
  assert.match(src, /SOURCE_DATE_EPOCH: '1795305600'/);
  const run = (parent) => spawnSync(process.execPath, ['--test', '--test-name-pattern=golden: (open-items-findings|card-line)', path.join(import.meta.dirname, 'golden.test.mjs')], { env: { ...process.env, ...parent }, encoding: 'utf8' });
  const r = run({ SOURCE_DATE_EPOCH: String(D2) });
  assert.equal(r.status, 0, r.stdout.slice(-1500));
});
