// lib/fetch/gh.ts: GitHub PR fetch through an injected Runner. Recorded responses only: no network, no gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchGithub, DEFAULT_MAX_ITEMS, DEFAULT_MAX_BYTES } from '../lib/fetch/gh.ts';
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
const WRITE = /^(-X|--method|-f|-F|--field|--raw-field|--input|POST|PUT|PATCH|DELETE)$/;
function assertReadOnly(calls: string[][]): void {
  for (const argv of calls) {
    argv.forEach((a, i) => {
      if (a === '--method') assert.equal(argv[i + 1], 'GET');
      else assert.ok(!WRITE.test(a), `write flag or verb in argv: ${a}`);
    });
    assert.ok(argv.includes('--method'), 'GET is explicit');
  }
}
const repo = 'example/widgets';

test('two serial pages: argv, rows, etag of the first page, watermark', async () => {
  const { run, calls } = rec(['gh-page1.http', 'gh-page2.http']);
  const r = await fetchGithub(run, { repo });
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(0, 2), ['api', '--include']);
  const p = calls[0]?.at(-1) ?? '';
  for (const q of ['repos/example/widgets/pulls', 'per_page=100', 'sort=updated', 'direction=asc', 'state=all']) assert.ok(p.includes(q), q);
  assert.ok(!calls[1]?.at(-1)?.includes('example.invalid'), 'a next link never chooses the host');
  assert.ok(calls[1]?.at(-1)?.includes('page=2'));
  assert.deepEqual(r.rows.map((x) => [x.number, x.state, x.headRefName]), [[11, 'merged', 'abc-1-parser'], [12, 'open', 'feature/abc-2-x'], [13, 'open', 'abc-3-docs']]);
  assert.equal(r.etag, 'W/"aaa111"');
  assert.equal(r.next.watermark, '2026-11-03T10:00:00Z');
  assert.equal(r.next.page, '');
  assertReadOnly(calls);
});

test('304 keeps the cache and the etag and sends if-none-match', async () => {
  const { run, calls } = rec(['gh-304.http']);
  const r = await fetchGithub(run, { repo, etag: 'W/"aaa111"', since: '2026-11-01T00:00:00Z' });
  assert.equal(r.status, 'not-modified');
  assert.deepEqual(r.rows, []);
  assert.equal(r.etag, 'W/"aaa111"');
  assert.equal(r.next.watermark, '2026-11-01T00:00:00Z');
  assert.ok(calls[0]?.includes('If-None-Match: W/"aaa111"'));
});

test('retry-after stops, keeps what was read and records where to resume; the new etag is not recorded', async () => {
  const { run, calls } = rec(['gh-page1.http', 'gh-retry.http']);
  const r = await fetchGithub(run, { repo, etag: 'old' });
  assert.equal(r.status, 'retry-after');
  assert.equal(r.retryAfter, 30);
  assert.equal(calls.length, 2);
  assert.equal(r.rows.length, 2);
  assert.ok(r.next.page.includes('page=2'));
  assert.equal(r.next.etag, 'old');
  assert.equal(r.next.watermark, '2026-11-02T10:00:00Z');
  const again = rec(['gh-page2.http']);
  const r2 = await fetchGithub(again.run, { repo, etag: r.next.etag, page: r.next.page, since: r.next.watermark });
  assert.ok(again.calls[0]?.at(-1)?.includes('page=2'), 'resumes at the recorded page');
  assert.ok(!again.calls[0]?.some((a) => a.startsWith('If-None-Match')), 'no etag while resuming');
  assert.equal(r2.rows.length, 1);
});

test('429 and a network error give a soft result that changes nothing and never throws', async () => {
  for (const step of ['gh-429.http', new Error('connect ETIMEDOUT'), { code: 1, out: '', err: 'gh: Could not resolve host' }] as const) {
    const { run } = rec([step]);
    const r = await fetchGithub(run, { repo, etag: 'e1', since: '2026-11-01T00:00:00Z', page: '' });
    assert.equal(r.status, 'soft');
    assert.deepEqual(r.rows, []);
    assert.deepEqual(r.next, { watermark: '2026-11-01T00:00:00Z', etag: 'e1', page: '' });
    assert.ok(r.notes.length > 0);
  }
});

test('full ignores the cursor; since drops older rows otherwise', async () => {
  const a = rec(['gh-page1.http', 'gh-page2.http']);
  const full = await fetchGithub(a.run, { repo, etag: 'e1', since: '2026-12-01T00:00:00Z', page: '/x?page=9', full: true });
  assert.equal(full.rows.length, 3);
  assert.ok(!a.calls[0]?.some((x) => x.startsWith('If-None-Match')));
  assert.ok(!a.calls[0]?.at(-1)?.includes('page=9'));
  const b = rec(['gh-page1.http', 'gh-page2.http']);
  const since = await fetchGithub(b.run, { repo, since: '2026-11-02T00:00:00Z' });
  assert.deepEqual(since.rows.map((x) => x.number), [12, 13]);
});

test('a sentinel token in the environment appears in no result', async () => {
  const TOKEN = 'ghp_SENTINELSENTINEL0123456789';
  const old = process.env.GH_TOKEN; process.env.GH_TOKEN = TOKEN;
  try {
    const { run } = rec([{ code: 1, out: '', err: `HTTP 401 bad credentials for ${TOKEN}` }]);
    const r = await fetchGithub(run, { repo });
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    const ok = await fetchGithub(rec(['gh-page1.http']).run, { repo });
    assert.ok(!JSON.stringify(ok).includes(TOKEN));
  } finally { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old; }
});

test('caps are enforced and reported, never silent', async () => {
  assert.equal(DEFAULT_MAX_ITEMS, 50000);
  assert.equal(DEFAULT_MAX_BYTES, 64 * 1024 * 1024);
  const items = await fetchGithub(rec(['gh-page1.http', 'gh-page2.http']).run, { repo, maxItems: 2 });
  assert.equal(items.status, 'capped');
  assert.equal(items.rows.length, 2);
  assert.ok(items.notes.some((n) => n.includes('fetch.max_items')));
  assert.ok(items.next.page.includes('page=2'));
  const bytes = await fetchGithub(rec(['gh-page1.http', 'gh-page2.http']).run, { repo, maxBytes: 500 });
  assert.equal(bytes.status, 'capped');
  assert.ok(bytes.notes.some((n) => n.includes('fetch.max_bytes')));
});

test('a repeated next link stops the paging', async () => {
  const { run, calls } = rec(['gh-page1.http']);
  const r = await fetchGithub(run, { repo });
  assert.equal(r.status, 'soft');
  assert.ok(calls.length <= 3);
  assert.ok(r.notes.some((n) => n.includes('paging loop')));
});

test('a bad repo name is refused softly', async () => {
  const { run, calls } = rec(['gh-page1.http']);
  const r = await fetchGithub(run, { repo: '../etc/passwd' });
  assert.equal(r.status, 'soft');
  assert.equal(calls.length, 0);
});
