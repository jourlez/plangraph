// lib/fetch/cursor.ts: the per-system cursor file cache/<sys>.cursor, mode 0600.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCursor, writeCursor, scrub } from '../lib/fetch/cursor.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cursor-'));
const cur = { sys: 'github', watermark: '2026-11-03T10:00:00Z', etag: 'W/"a"', page: '', at: '2026-11-26T00:00:00.000Z' };

test('write then read round-trips, in cache/<sys>.cursor with mode 0600', () => {
  const d = tmp();
  writeCursor(d, cur);
  const f = path.join(d, 'cache', 'github.cursor');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readCursor(d, 'github'), cur);
  writeCursor(d, { ...cur, etag: 'b' });
  assert.equal(readCursor(d, 'github')?.etag, 'b');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(d, 'cache')), ['github.cursor'], 'no temp file is left');
});

test('a target-qualified sys maps to one safe file name', () => {
  const d = tmp();
  writeCursor(d, { ...cur, sys: 'github:example/widgets' });
  assert.deepEqual(fs.readdirSync(path.join(d, 'cache')).length, 1);
  assert.equal(readCursor(d, 'github:example/widgets')?.sys, 'github:example/widgets');
  assert.equal(readCursor(d, 'github'), null);
});

test('missing, corrupt and wrong-shape files read as null; a bad sys is refused', () => {
  const d = tmp();
  assert.equal(readCursor(d, 'jira'), null);
  fs.mkdirSync(path.join(d, 'cache'));
  fs.writeFileSync(path.join(d, 'cache', 'jira.cursor'), '{nope');
  assert.equal(readCursor(d, 'jira'), null);
  fs.writeFileSync(path.join(d, 'cache', 'jira.cursor'), JSON.stringify({ sys: 'jira', watermark: 5 }));
  assert.equal(readCursor(d, 'jira'), null);
  for (const sys of ['../x', 'a b', '', 'x\n']) assert.throws(() => writeCursor(d, { ...cur, sys }), /sys/);
  assert.equal(readCursor(d, '../x'), null);
});

test('scrub removes secret-looking environment values from text', () => {
  const old = process.env.SOME_API_TOKEN; process.env.SOME_API_TOKEN = 'abcDEF1234567890xyz';
  try {
    assert.equal(scrub('err abcDEF1234567890xyz end'), 'err *** end');
    assert.equal(scrub('nothing here'), 'nothing here');
  } finally { if (old === undefined) delete process.env.SOME_API_TOKEN; else process.env.SOME_API_TOKEN = old; }
});
