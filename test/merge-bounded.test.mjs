// bin/brain-merge reads the three files git hands it through the capped, regular-files-only reader: a FIFO (or device) given as an input
// fails fast with exit 2 instead of blocking the merge forever, and an input over the cap is refused the same way. Windows: no mkfifo.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const MERGE = path.join(import.meta.dirname, '../bin/brain-merge');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const skip = process.platform === 'win32' ? 'no mkfifo on Windows' : false;

test('a FIFO as a merge input exits 2 at once (no hang), naming no content', { skip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-fifo-')); made.push(d);
  const fifo = path.join(d, 'base'), a = path.join(d, 'ours'), b = path.join(d, 'theirs');
  execFileSync('mkfifo', [fifo]); fs.writeFileSync(a, '{"key":"T-1"}\n'); fs.writeFileSync(b, '{"key":"T-1"}\n');
  const r = spawnSync(process.execPath, [MERGE, fifo, a, b, '.brain/tickets.jsonl'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.signal, null, 'not killed by the timeout: it did not block');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'brain-merge: not a regular file\n');
  assert.equal(fs.readFileSync(a, 'utf8'), '{"key":"T-1"}\n', 'ours untouched');
});
