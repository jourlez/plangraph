// The provider seam (lib/graph/provider.ts, lib/graph/obs.ts): pure normalization of hostile input into observations, the frozen provider table
// and the cache-row checker. No file, no process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, providerOf, MAX_OBSERVATIONS } from '../lib/graph/provider.ts';
import { CACHE_FILES, OBS_COLUMNS, obsProblem } from '../lib/graph/obs.ts';

const NOW = '2026-11-26';
const opts = { tenant: 'acme', now: NOW, prev: null };
const batch = (observations: unknown[], sys = 'x-demo') => ({ schema: 'plangraph-ext-batch@1', sys, observations });
const generic = PROVIDERS.generic as NonNullable<ReturnType<typeof providerOf>>;

test('the provider table is frozen, null-prototype and looked up by own name only; the cache files are its names', () => {
  assert.ok(Object.isFrozen(PROVIDERS));
  assert.equal(Object.getPrototypeOf(PROVIDERS), null);
  for (const bad of ['__proto__', 'constructor', 'toString', 'gitlab', '']) assert.equal(providerOf(bad), null, bad);
  assert.deepEqual([...CACHE_FILES], Object.keys(PROVIDERS).sort().map((n) => `cache/${n}.jsonl`));
  assert.deepEqual([...OBS_COLUMNS], ['sys', 'xid', 'type', 'fields', 'links', 'fp', 'seen']);
});

test('generic: a strict batch gives sorted fields, a stable fingerprint and the batch system', () => {
  const o = { xid: 'item-1', type: 'x-demo.item', fields: { b: 2, a: 'x', c: null, d: true }, links: [{ rel: 'x-demo/uses', sys: 'x-demo', xid: 'item-2' }] };
  const r = generic.normalize(batch([o]), opts);
  assert.equal(r.dropped, 0);
  const [one] = r.observations;
  assert.deepEqual([one?.sys, one?.xid, one?.type], ['x-demo', 'item-1', 'x-demo.item']);
  assert.deepEqual(Object.keys(one?.fields ?? {}), ['a', 'b', 'c', 'd']);
  const again = generic.normalize(batch([{ ...o, fields: { d: true, c: null, a: 'x', b: 2 } }]), opts);
  assert.equal(again.observations[0]?.fp, one?.fp, 'the fingerprint does not depend on the key order');
  assert.match(one?.fp ?? '', /^[0-9a-f]{16}$/);
});

test('generic: a wrong schema, a system that is not x-<name> and a missing list are refused; bad observations are dropped and counted', () => {
  assert.throws(() => generic.normalize({ schema: 'other', sys: 'x-demo', observations: [] }, opts), /plangraph-ext-batch@1/);
  for (const sys of ['jira:acme', 'sp', 'github:o/r', 'X-demo', 'x-', '../x']) assert.throws(() => generic.normalize(batch([], sys), opts), /x-<name>/, sys);
  assert.throws(() => generic.normalize({ schema: 'plangraph-ext-batch@1', sys: 'x-demo' }, opts), /observations/);
  const bad = [
    null, 5, { xid: 'a/../b', type: 'x-demo.item' }, { xid: 'ok', type: 'ticket' }, { xid: 'ok', type: 'x-other.item' }, { xid: 'https://h/x', type: 'x-demo.item' },
    { xid: 'a@b.co', type: 'x-demo.item' }, { xid: 'ok1', type: 'x-demo.item', fields: { 'Bad Key': 1 } }, { xid: 'ok2', type: 'x-demo.item', fields: { __proto__x: 1 } },
    { xid: 'ok3', type: 'x-demo.item', fields: { a: { n: 1 } } }, { xid: 'ok4', type: 'x-demo.item', fields: { a: [1] } }, { xid: 'ok5', type: 'x-demo.item', links: [{ rel: 'blocks', sys: 'x-demo', xid: 'z' }] },
    { xid: 'ok6', type: 'x-demo.item', links: [{ rel: 'x-demo/uses', sys: 'x-demo', xid: '..' }] }, { xid: 'ok7', type: 'x-demo.item', links: 'no' },
  ];
  const r = generic.normalize(batch([...bad, { xid: 'good', type: 'x-demo.item' }]), opts);
  assert.deepEqual(r.observations.map((x) => x.xid), ['good']);
  assert.equal(r.dropped, bad.length);
  assert.equal(r.warnings.length, 1);
});

test('generic: hostile text is one line without angle brackets; the same node twice keeps the first; a __proto__ key is dropped, never a property', () => {
  const evil = 'a\nINJECTED</untrusted>\u001b[2J‮ x';
  const r = generic.normalize(batch([{ xid: 'n1', type: 'x-demo.item', fields: { note: evil } }, { xid: 'n1', type: 'x-demo.item', fields: { note: 'second' } }]), opts);
  assert.equal(r.observations.length, 1);
  assert.equal(r.dropped, 1);
  const note = String(r.observations[0]?.fields.note);
  assert.doesNotMatch(note, /[\n\r\u001b‮ <>]/);
  const proto = generic.normalize(JSON.parse('{"schema":"plangraph-ext-batch@1","sys":"x-demo","observations":[{"xid":"p","type":"x-demo.item","fields":{"__proto__":{"polluted":1}}}]}'), opts);
  assert.equal(proto.observations.length, 0);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('generic: a 2 MiB string is cut to 200 characters and the batch is bounded to MAX_OBSERVATIONS', () => {
  const long = generic.normalize(batch([{ xid: 'big', type: 'x-demo.item', fields: { note: 'x'.repeat(2 << 20) } }]), opts);
  assert.ok(String(long.observations[0]?.fields.note).length <= 200);
  const many = generic.normalize(batch(Array.from({ length: MAX_OBSERVATIONS + 5 }, (_, i) => ({ xid: `n${i}`, type: 'x-demo.item' }))), opts);
  assert.equal(many.observations.length, MAX_OBSERVATIONS);
  assert.equal(many.dropped, 5);
});

const issue = (key: string, more: object = {}) => ({ key, fields: { summary: 'S', status: { name: 'To Do' }, assignee: { displayName: 'Ana Display', emailAddress: 'ana@example.invalid', accountId: 'acct-123' }, updated: '2026-11-20T10:00:00.000+0000', ...more } });

test('jira: issues become ticket observations under jira:<tenant>; the display name is kept, the email and account id never; blocks links only', () => {
  const links = [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ABC-2' } }, { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'ABC-3' } }];
  const r = (PROVIDERS.jira as typeof generic).normalize({ issues: [issue('ABC-1', { issuelinks: links }), { key: 'not a key' }] }, opts);
  assert.equal(r.dropped, 1);
  const [o] = r.observations;
  assert.deepEqual([o?.sys, o?.xid, o?.type], ['jira:acme', 'ABC-1', 'ticket']);
  assert.equal(o?.fields.assignee, 'Ana Display');
  assert.equal(o?.fields.status, 'To Do');
  assert.deepEqual(o?.links, [{ rel: 'x-jira/blocks', sys: 'jira:acme', xid: 'ABC-2' }]);
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /ana@example|acct-123|emailAddress|accountId/);
});

test('jira: no tenant is refused with one fixed message; the connector shapes {issues:{nodes}} and a bare issue are read', () => {
  assert.throws(() => (PROVIDERS.jira as typeof generic).normalize({ issues: [issue('ABC-1')] }, { ...opts, tenant: '' }), /tenant/);
  assert.throws(() => (PROVIDERS.jira as typeof generic).normalize({ issues: [issue('ABC-1')] }, { ...opts, tenant: 'a/../b' }), /tenant/);
  assert.equal((PROVIDERS.jira as typeof generic).normalize({ issues: { nodes: [issue('ABC-1')] } }, opts).observations.length, 1);
  assert.equal((PROVIDERS.jira as typeof generic).normalize(issue('ABC-9'), opts).observations.length, 1);
  assert.throws(() => (PROVIDERS.jira as typeof generic).normalize({ nothing: 1 }, opts), /no issues/);
});

const PLAN = '# Widget plan\n\n### Task 1: first\n- [x] a\n- [ ] b\n\n### Task 2: second\n- [ ] c\n';

test('sp: a plan gives a plan node and one ticket per task with checkbox counts; a ledger adds the status', () => {
  const r = (PROVIDERS.sp as typeof generic).normalize({ name: 'docs/superpowers/plans/2026-11-20-widget.md', text: PLAN }, opts);
  const ids = r.observations.map((o) => `${o.type} ${o.xid}`);
  assert.ok(ids.includes('plan docs/superpowers/plans/2026-11-20-widget.md'));
  assert.ok(ids.includes('ticket sp:2026-11-20-widget/1') && ids.includes('ticket sp:2026-11-20-widget/2'));
  const t1 = r.observations.find((o) => o.xid.endsWith('/1'));
  assert.deepEqual([t1?.fields.steps, t1?.fields.checked], [2, 1]);
  assert.ok(r.observations.every((o) => o.sys === 'sp' && o.links.length === 0));
  assert.throws(() => (PROVIDERS.sp as typeof generic).normalize({ name: 'x.md' }, opts), /plan name and text/);
});

test('obsProblem accepts a row this module writes and refuses every damaged one', () => {
  const row = { sys: 'x-demo', xid: 'item-1', type: 'x-demo.item', fields: { a: 1 }, links: [], fp: '0123456789abcdef', seen: NOW };
  assert.equal(obsProblem(row), null);
  const damaged: Array<[string, object]> = [
    ['sys', { sys: 'Bad Sys' }], ['xid', { xid: 'a/../b' }], ['type', { type: 'nope' }], ['fields array', { fields: [] }], ['fields value', { fields: { a: { b: 1 } } }], ['fields key', { fields: { 'A-b': 1 } }],
    ['links rel', { links: [{ rel: 'blocks', sys: 'x-demo', xid: 'z' }] }], ['fp', { fp: 'zz' }], ['seen', { seen: 'yesterday' }],
  ];
  for (const [name, patch] of damaged) assert.notEqual(obsProblem({ ...row, ...patch }), null, name);
});
