import test, { after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import os from 'node:os'; import path from 'node:path';
import { parseJsonl, readJsonl, IngestError } from '../lib/jsonl.ts'; import { validators } from '../lib/schema.ts';
import { parseJsonlText, readRecords } from '../lib/store.ts'; import { parseItems } from '../lib/openitems.ts'; import { parseSnapshotJsonl } from '../lib/jira.ts';
/** What a failed parse throws (an IngestError), as these tests read it. */
type Thrown = { message: string; total: number; errors: Error[] };
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-schema-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('errors carry file:line and never echo file content', () => {
  const text = '{"key":"A"}\nTOPSECRET-not-json\n';
  try { parseJsonl(text, 'tickets.jsonl'); assert.fail(); } catch (e) { assert.match((e as Thrown).message, /tickets\.jsonl:2: invalid JSON/); assert.ok(!/TOPSECRET/.test((e as Thrown).message)); assert.ok(e instanceof AggregateError); } // an IngestError was thrown
});
test('no leak even when the engine reports a position inside the secret', () => {
  try { parseJsonl('{"a":"TOPSECRET" "b":1}\n', 'x.jsonl'); assert.fail(); } catch (e) { assert.match((e as Thrown).message, /^x\.jsonl:1: invalid JSON( at column \d+)?$/); assert.ok(!/TOPSECRET/.test((e as Thrown).message + (e as Thrown).errors.map((x) => x.message))); } // an IngestError was thrown
});
test('oversized line is rejected without parsing it', () => {
  assert.throws(() => parseJsonl('{"a":"' + 'x'.repeat(2e6) + '"}\n', 'x.jsonl', { maxLine: 1 << 20 }), /x\.jsonl:1: line too long/);
});
test('conflict markers are named', () => assert.throws(() => parseJsonl('<<<<<<< ours\n', 'x.jsonl'), /x\.jsonl:1: unresolved git merge conflict marker/));
test('validators name file:line:field', () => {
  assert.throws(() => parseJsonl('{"consumer":"A"}\n', 'edges.jsonl', { validate: validators['edges.jsonl'] }), /edges\.jsonl:1: missing "producer"/);
  assert.throws(() => parseJsonl('{"key":"T-1","sp":"x"}\n', 'tickets.jsonl', { validate: validators['tickets.jsonl'] }), /tickets\.jsonl:1: "sp" must be a number/);
});
test('every required validator exists and rejects an empty record', () => {
  for (const n of ['tickets', 'edges', 'schedule', 'findings', 'refs', 'open-items']) assert.equal(typeof (validators as Record<string, ((r: object) => unknown) | undefined>)[`${n}.jsonl`]?.({}), 'string', n); // each validator takes one record
  assert.match(validators['open-items.jsonl']({ key: 'A', kind: 'k', status: 3 }) as string, /"status"/); // an invalid record gives a message
  assert.equal(validators['open-items.jsonl']({ key: 'A', kind: 'k', status: 'done' }), null);
  assert.match(validators['refs.jsonl']({ key: 'A', plans: 'x' }) as string, /"plans" must be an array/); // an invalid record gives a message
  assert.match(validators['schedule.jsonl']({ key: 'A', sprint: 'x' }) as string, /"sprint" must be a number/); // an invalid record gives a message
});
test('unknown extra fields are allowed (forward compatibility)', () => {
  assert.equal(parseJsonl('{"key":"T-1","sp":1,"future":true}\n', 'tickets.jsonl', { validate: validators['tickets.jsonl'] }).length, 1);
});
test('IngestError: first 10 lines in message, all in .errors', () => {
  const text = Array.from({ length: 12 }, () => 'nope').join('\n');
  try { parseJsonl(text, 'f.jsonl'); assert.fail(); } catch (e) {
    assert.ok(e instanceof IngestError && e instanceof AggregateError); assert.equal(e.errors.length, 10); assert.equal(e.total, 12); assert.ok(e.errors.every((x) => x instanceof Error));
    assert.equal(e.message.split('\n').length, 11); assert.match(e.message, /\.\.\. and 2 more$/);
  }
});
test('readJsonl: missing file is [], validated by base name, absolute path never named', () => {
  const d = tmp(); assert.deepEqual(readJsonl(path.join(d, 'tickets.jsonl')), []);
  fs.writeFileSync(path.join(d, 'tickets.jsonl'), '{"key":"A"}\n{"key":"B","sp":"x"}\n');
  try { readJsonl(path.join(d, 'tickets.jsonl')); assert.fail(); } catch (e) { assert.match((e as Thrown).message, /^tickets\.jsonl:2: "sp" must be a number$/); } // an IngestError was thrown
});
test('readJsonl refuses oversized files and directories with short errors', () => {
  const d = tmp(); const f = path.join(d, 'big.jsonl'); fs.writeFileSync(f, '{"a":"' + 'x'.repeat(5000) + '"}\n');
  assert.throws(() => readJsonl(f, { maxBytes: 1000 }), (e) => e instanceof IngestError && /file too large/.test(e.message) && !/xxxx/.test(e.message));
  assert.throws(() => readJsonl(d), /not a regular file/);
});
test('delegating parsers use the shared parser (bounded, non-leaking)', () => {
  for (const fn of [(t: string) => parseJsonlText(t, 'f'), (t: string) => parseItems(t), (t: string) => parseSnapshotJsonl(t)]) {
    assert.throws(() => fn('{"schema":1,"meta":{}}\nTOPSECRET\n'), (e) => e instanceof AggregateError && !/TOPSECRET/.test(e.message));
  }
  assert.throws(() => parseItems('{"a":"' + 'x'.repeat(2e6) + '"}\n'), /line too long/);
});

const bad = (n: number) => Array.from({ length: n }, () => 'nope').join('\n') + '\n';
test('error memory is bounded: 2M bad lines stay fast, small, and keep only 10 Error objects', () => {
  const text = 'x\n'.repeat(2_000_000);
  const rss0 = process.memoryUsage().rss, t0 = Date.now();
  let err: unknown; try { parseJsonl(text, 'f.jsonl'); } catch (e) { err = e; }
  const dt = Date.now() - t0, grew = process.memoryUsage().rss - rss0;
  console.log(`# 2M-line probe: ${dt} ms, rss growth ${(grew / 1048576).toFixed(1)} MB`);
  assert.ok(err instanceof IngestError);
  assert.ok(err.errors.length <= 10);
  assert.ok(dt < 5000, `took ${dt} ms`);
  // rss is noisy (GC timing, allocator); the limit is generous versus the ~1.5 GB the unbounded version used.
  assert.ok(grew < 200 * 1048576, `rss grew ${grew}`);
});
test('scan stops after 1000 errors and says "at least"', () => {
  try { parseJsonl(bad(5000), 'f.jsonl'); assert.fail(); } catch (e) {
    assert.equal((e as Thrown).total, 1000); assert.ok((e as Thrown).errors.length <= 10); // an IngestError was thrown
    assert.equal((e as Thrown).message.split('\n').length, 11); assert.match((e as Thrown).message, /\n\.\.\. and at least 990 more$/); // an IngestError was thrown
  }
});
test('exactly 1000 errors is exact; exactly 10 has no more-line; 11 says 1 more; order is line order', () => {
  try { parseJsonl(bad(1000), 'f.jsonl'); assert.fail(); } catch (e) { assert.equal((e as Thrown).total, 1000); assert.match((e as Thrown).message, /\n\.\.\. and 990 more$/); } // an IngestError was thrown
  try { parseJsonl(bad(10), 'f.jsonl'); assert.fail(); } catch (e) { assert.equal((e as Thrown).total, 10); assert.equal((e as Thrown).message.split('\n').length, 10); assert.ok(!/more/.test((e as Thrown).message)); } // an IngestError was thrown
  try { parseJsonl(bad(11), 'f.jsonl'); assert.fail(); } catch (e) {
    assert.equal((e as Thrown).total, 11); assert.match((e as Thrown).message, /\n\.\.\. and 1 more$/); // an IngestError was thrown
    assert.deepEqual((e as Thrown).message.split('\n').slice(0, 10).map((l) => Number((/f\.jsonl:(\d+):/.exec(l) as RegExpExecArray)[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // an IngestError was thrown; every message line names its line
  }
});
test('IngestError stays backward compatible', () => {
  const e = new IngestError('boom');
  assert.ok(e instanceof IngestError && e instanceof AggregateError); assert.equal(e.name, 'IngestError'); assert.equal(e.message, 'boom'); assert.equal(e.errors.length, 1); assert.equal(e.total, 1);
});
test('readRecords refuses a file over the byte cap (sparse file, never read whole)', () => {
  const d = tmp(), f = path.join(d, 'tickets.jsonl'); fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, 70 * 1024 * 1024);
  assert.throws(() => readRecords(d, 'tickets.jsonl'), (e) => e instanceof IngestError && /file too large/.test(e.message));
  assert.deepEqual(readRecords(d, 'missing.jsonl'), []);
});
test('validator lookup ignores prototype names', () => {
  const d = tmp(); for (const n of ['constructor', 'toString']) { fs.writeFileSync(path.join(d, n), '{"a":1}\n'); assert.deepEqual(readJsonl(path.join(d, n)), [{ a: 1 }], n); }
});
test('open-items validator accepts any non-empty status string', () => {
  assert.equal(validators['open-items.jsonl']({ key: 'A', kind: 'k', status: 'wontfix' }), null);
  assert.equal(parseItems('{"key":"A","kind":"k","status":"wontfix"}\n').length, 1);
  assert.match(validators['open-items.jsonl']({ key: 'A', kind: 'k', status: '' }) as string, /"status"/); // an invalid record gives a message
  assert.match(validators['open-items.jsonl']({ key: 'A', kind: 'k', status: 3 }) as string, /"status"/); // an invalid record gives a message
});
test('readRecords names files by base name, parseSnapshotJsonl by snapshot.jsonl', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'edges.jsonl'), 'nope\n');
  assert.throws(() => readRecords(d, 'edges.jsonl'), (e: Error) => /^edges\.jsonl:1: invalid JSON/.test(e.message) && !e.message.includes(d));
  assert.throws(() => parseSnapshotJsonl('{"schema":1,"meta":{}}\nnope\n'), (e: Error) => /^snapshot\.jsonl:2: invalid JSON/.test(e.message));
});
test('parseItems: non-object line and conflict marker carry file:line', () => {
  assert.throws(() => parseItems('[1]\n'), (e) => e instanceof IngestError && /^open-items\.jsonl:1: expected a JSON object$/.test(e.message));
  assert.throws(() => parseItems('{"key":"A","kind":"k"}\n<<<<<<< ours\n'), (e) => e instanceof IngestError && /^open-items\.jsonl:2: unresolved git merge conflict marker$/.test(e.message));
});
test('parseSnapshotJsonl: non-object head line reports "expected a JSON object" (this replaced the old bad_snapshot error for that case)', () => {
  assert.throws(() => parseSnapshotJsonl('[1]\n'), (/** @type {any} */ e) => e instanceof IngestError && /snapshot\.jsonl:1: expected a JSON object/.test(e.message));
});
test('readJsonl: a string sp names the field, not its value', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'tickets.jsonl'), '{"key":"A","sp":"SECRETVALUE"}\n');
  assert.throws(() => readJsonl(path.join(d, 'tickets.jsonl')), (e: Error) => /"sp"/.test(e.message) && !/SECRETVALUE/.test(e.message));
});
test('readJsonl refuses a FIFO', (t) => {
  const d = tmp(), f = path.join(d, 'pipe.jsonl');
  try { execFileSync('mkfifo', [f]); } catch { t.skip('mkfifo unavailable'); return; }
  assert.throws(() => readJsonl(f), (e) => e instanceof IngestError && /not a regular file/.test(e.message));
});

// Review M1/M2: a fractional sprint crashed a whatif dry run (internal error, exit 5) and a negative sp let whatif say OK while the vacated
// cell went over capacity. The schema refuses both with file:line and the field name only.
test('schedule sprint must be a whole number and sp must not be negative (file:line, field name, never the value)', () => {
  const v = validators;
  for (const bad of [2.5, -0.5, 1e300, Number.MAX_SAFE_INTEGER + 2]) assert.equal(v['schedule.jsonl']({ key: 'A', sprint: bad }), '"sprint" must be a whole number', String(bad));
  for (const ok of [0, 3, -1]) assert.equal(v['schedule.jsonl']({ key: 'A', sprint: ok }), null, String(ok));
  assert.equal(v['schedule.jsonl']({ key: 'A', sprint: 'x' }), '"sprint" must be a number');
  for (const bad of [-2, -0.1]) assert.equal(v['tickets.jsonl']({ key: 'A', sp: bad }), '"sp" must not be negative', String(bad));
  for (const ok of [0, 2.6, 13]) assert.equal(v['tickets.jsonl']({ key: 'A', sp: ok }), null, String(ok));
  assert.throws(() => parseJsonl('{"key":"T-1","owner":"Ana","sprint":1}\n{"key":"T-2","owner":"Ana","sprint":2.5}\n', 'schedule.jsonl', { validate: v['schedule.jsonl'] }), /^AggregateError: schedule\.jsonl:2: "sprint" must be a whole number$|schedule\.jsonl:2: "sprint" must be a whole number/);
});
