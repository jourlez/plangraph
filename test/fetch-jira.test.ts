// lib/fetch/jira.ts: Jira search and changelog fetch through an injected Runner. Recorded responses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchJira } from '../lib/fetch/jira.ts';
import { PROVIDERS } from '../lib/graph/provider.ts';
import type { Runner } from '../lib/fetch/gh.ts';

const load = (n: string): string => fs.readFileSync(new URL(`./fixtures/fetch/${n}`, import.meta.url), 'utf8');
function rec(steps: Array<string | Error | { code: number; out: string; err: string }>): { run: Runner; calls: string[][] } {
  const calls: string[][] = []; let i = 0;
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s instanceof Error) throw s;
    if (typeof s === 'string') return { code: 0, out: load(s), err: '' };
    return s as { code: number; out: string; err: string };
  };
  return { run, calls };
}
const WRITE = /^(-X|-f|-F|--field|--raw-field|--input|POST|PUT|PATCH|DELETE)$/;
function assertReadOnly(calls: string[][]): void {
  for (const argv of calls) {
    argv.forEach((a, i) => { if (a === '--method') assert.equal(argv[i + 1], 'GET'); else assert.ok(!WRITE.test(a), a); });
    assert.ok(argv.includes('--method'));
  }
}
const q = (argv: string[] | undefined): URLSearchParams => new URLSearchParams((argv?.at(-1) ?? '').split('?')[1] ?? '');
const base = { jql: 'project = ABC', watermark: '2026-11-01T10:00:00.000Z' };

test('two pages: watermark minus 5 minutes in the JQL, nextPageToken, idempotent upsert, next watermark', async () => {
  const { run, calls } = rec(['jira-p1.http', 'jira-p2.http']);
  const r = await fetchJira(run, base);
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 2);
  const a = q(calls[0]);
  assert.equal(a.get('jql'), '(project = ABC) AND updated >= "2026-11-01 09:55" ORDER BY updated ASC');
  assert.equal(a.get('maxResults'), '100');
  assert.ok(a.get('fields')?.includes('summary'));
  assert.equal(a.has('nextPageToken'), false);
  assert.equal(q(calls[1]).get('nextPageToken'), 'tok-2');
  assert.deepEqual(r.issues.map((i) => i.key), ['ABC-1', 'ABC-2', 'ABC-3']);
  assert.equal((r.issues[1] as unknown as { fields: { summary: string } }).fields.summary, 'Second copy', 'the later copy wins');
  assert.equal(r.nextWatermark, '2026-11-04T10:00:00.000Z');
  assertReadOnly(calls);
});

test('a first fetch without a watermark has no updated clause', async () => {
  const { run, calls } = rec(['jira-p2.http']);
  await fetchJira(run, { jql: 'project = ABC' });
  assert.equal(q(calls[0]).get('jql'), 'project = ABC ORDER BY updated ASC');
});

test('a repeated nextPageToken aborts with "fetch jira: paging loop" and keeps the watermark', async () => {
  const { run, calls } = rec(['jira-loop.http']);
  const r = await fetchJira(run, base);
  assert.equal(r.status, 'aborted');
  assert.equal(r.error, 'fetch jira: paging loop');
  assert.equal(r.nextWatermark, base.watermark);
  assert.ok(calls.length <= 3);
});

test('retry-after stops, keeps the pages read and advances the watermark only as far as they went', async () => {
  const { run } = rec(['jira-p1.http', { code: 1, out: 'HTTP/2.0 429 Too Many Requests\nRetry-After: 45\n\n{}', err: '' }]);
  const r = await fetchJira(run, base);
  assert.equal(r.status, 'retry-after');
  assert.equal(r.retryAfter, 45);
  assert.equal(r.issues.length, 2);
  assert.equal(r.nextWatermark, '2026-11-02T10:00:00.000Z');
});

test('429 without retry-after and a network error are soft: nothing changes, nothing throws', async () => {
  for (const step of [{ code: 1, out: 'HTTP/2.0 429 Too Many Requests\n\n{}', err: '' }, new Error('ECONNRESET'), { code: 1, out: '', err: 'dial tcp: lookup failed' }] as const) {
    const r = await fetchJira(rec([step]).run, base);
    assert.equal(r.status, 'soft');
    assert.deepEqual(r.issues, []);
    assert.equal(r.nextWatermark, base.watermark);
  }
});

test('a JQL with its own ORDER BY or no JQL is refused softly, without a request', async () => {
  for (const jql of ['project = ABC ORDER BY key', '', '   ']) {
    const { run, calls } = rec(['jira-p1.http']);
    const r = await fetchJira(run, { jql });
    assert.equal(r.status, 'soft');
    assert.equal(calls.length, 0);
  }
});

test('changelog: one paged GET per planned ticket gives x-jira.transition observations for status changes only', async () => {
  const { run, calls } = rec(['jira-p2.http', 'jira-changelog.http']);
  const r = await fetchJira(run, { ...base, changelog: ['ABC-1'], tenant: 'acme' });
  assert.ok(calls[1]?.at(-1)?.startsWith('/rest/api/3/issue/ABC-1/changelog?'));
  assertReadOnly(calls);
  assert.equal(r.transitions?.sys, 'x-jira');
  assert.equal(r.transitions?.observations.length, 1);
  const o = r.transitions?.observations[0];
  assert.deepEqual([o?.xid, o?.type], ['ABC-1#9001', 'x-jira.transition']);
  assert.deepEqual(o?.fields, { from: 'To Do', to: 'In Progress', at: '2026-11-01T09:00:00.000Z' });
  assert.deepEqual(o?.links, [{ rel: 'x-jira/of', sys: 'jira:acme', xid: 'ABC-1' }]);
  const batch = PROVIDERS.generic?.normalize(r.transitions, { tenant: 'acme', now: '2026-11-26', prev: null });
  assert.equal(batch?.dropped, 0);
  assert.equal(batch?.observations.length, 1);
});

test('a key that is not a ticket key is never requested for a changelog', async () => {
  const { run, calls } = rec(['jira-p2.http', 'jira-changelog.http']);
  await fetchJira(run, { ...base, changelog: ['../x', 'abc-1?x=1'] });
  assert.equal(calls.length, 1);
});

test('the issues feed the existing jira provider unchanged', async () => {
  const r = await fetchJira(rec(['jira-p1.http', 'jira-p2.http']).run, base);
  const b = PROVIDERS.jira?.normalize(r.issues, { tenant: 'acme', now: '2026-11-26', prev: null });
  assert.deepEqual(b?.observations.map((o) => o.xid), ['ABC-1', 'ABC-2', 'ABC-3']);
});

test('a sentinel token in the environment appears in no result', async () => {
  const TOKEN = 'JIRATOKEN_SENTINEL_0123456789abcdef';
  const old = process.env.JIRA_API_TOKEN; process.env.JIRA_API_TOKEN = TOKEN;
  try {
    const r = await fetchJira(rec([{ code: 1, out: '', err: `401 for ${TOKEN}` }]).run, base);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  } finally { if (old === undefined) delete process.env.JIRA_API_TOKEN; else process.env.JIRA_API_TOKEN = old; }
});

test('caps are enforced and reported', async () => {
  const items = await fetchJira(rec(['jira-p1.http', 'jira-p2.http']).run, { ...base, maxItems: 2 });
  assert.equal(items.status, 'capped');
  assert.equal(items.issues.length, 2);
  assert.ok(items.notes.some((n) => n.includes('fetch.max_items')));
  const bytes = await fetchJira(rec(['jira-p1.http', 'jira-p2.http']).run, { ...base, maxBytes: 300 });
  assert.equal(bytes.status, 'capped');
  assert.ok(bytes.notes.some((n) => n.includes('fetch.max_bytes')));
});
