// Coverage margin for lib/fetch/gh.ts: the odd paths, the odd answers and the odd rows of the GitHub fetch, through a scripted runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { httpGet, nextPath, fetchGithub, note } from '../lib/fetch/gh.ts';
import type { Runner } from '../lib/fetch/gh.ts';

const reply = (status: number, headers: Record<string, string> = {}, body = '[]'): string => `HTTP/2 ${status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`;
const script = (...answers: Array<string | Error | { code: number; out: unknown; err?: string }>): { run: Runner; argvs: string[][] } => {
  const argvs: string[][] = [], queue = [...answers];
  const run: Runner = async (argv) => {
    argvs.push(argv);
    const a = queue.shift();
    if (a instanceof Error) throw a;
    if (typeof a === 'string') return { code: 0, out: a, err: '' };
    return { code: a?.code ?? 0, out: a?.out as string, err: a?.err ?? '' };
  };
  return { run, argvs };
};

test('httpGet refuses a URL, a leading dash and odd characters before it runs anything', async () => {
  const s = script(reply(200));
  for (const p of ['https://example.invalid/x', '-H', 'a b', 'repos/x\n', '']) assert.deepEqual(await httpGet(s.run, p), { kind: 'soft', note: 'refused a request path with odd characters' }, JSON.stringify(p));
  assert.equal(s.argvs.length, 0);
});

test('httpGet turns a failing runner, a missing out and a missing status line into soft results', async () => {
  assert.match(((await httpGet(script(new Error('spawn failed')).run, 'repos/a/b')) as { note: string }).note, /^request failed: spawn failed$/);
  assert.match(((await httpGet(script(Object.assign(new Error(''), { message: undefined })).run, 'repos/a/b')) as { note: string }).note, /^request failed: /);
  assert.deepEqual(await httpGet(script({ code: 1, out: undefined, err: 'gh: not logged in' }).run, 'repos/a/b'), { kind: 'soft', note: 'request failed: gh: not logged in' });
  assert.deepEqual(await httpGet(script({ code: 1, out: 'garbage' }).run, 'repos/a/b'), { kind: 'soft', note: 'request failed: no answer' });
  assert.deepEqual(await httpGet(script('HTTP/2 200').run, 'repos/a/b'), { kind: 'ok', status: 200, headers: new Map(), body: '', bytes: 10 });
});

test('httpGet reads Retry-After for 429, 403 and 503 (a bad value is 60, a huge one is capped), and a 429 without it is soft', async () => {
  const after = async (status: number, ra: string) => httpGet(script(reply(status, { 'Retry-After': ra })).run, 'repos/a/b');
  assert.deepEqual(await after(429, '7'), { kind: 'retry', after: 7 });
  assert.deepEqual(await after(403, 'soon'), { kind: 'retry', after: 60 });
  assert.deepEqual(await after(503, '-3'), { kind: 'retry', after: 60 });
  assert.deepEqual(await after(429, '999999'), { kind: 'retry', after: 86400 });
  assert.deepEqual(await httpGet(script(reply(429)).run, 'repos/a/b'), { kind: 'soft', note: 'rate limited (429) without Retry-After' });
  assert.deepEqual(await httpGet(script(reply(404)).run, 'repos/a/b'), { kind: 'soft', note: 'answered 404' });
  assert.deepEqual(await httpGet(script(reply(500, { 'Retry-After': '5' })).run, 'repos/a/b'), { kind: 'soft', note: 'answered 500' });
  const ok = await httpGet(script(reply(304, { ETag: '"e"', 'x-no-colon-line': '' }, '')).run, 'repos/a/b', ['Accept: x']);
  assert.equal(ok.kind, 'ok');
});

test('nextPath keeps the path and query of the next link only, and answers empty for anything else', () => {
  assert.equal(nextPath(undefined), '');
  assert.equal(nextPath(''), '');
  assert.equal(nextPath('<https://api.example.invalid/repos/a/b/pulls?page=2>; rel="prev"'), '');
  assert.equal(nextPath('<https://api.example.invalid/repos/a/b/pulls?page=2>; rel="next", <https://x/last>; rel="last"'), '/repos/a/b/pulls?page=2');
  assert.equal(nextPath('<//[bad>; rel=next'), '');
  assert.ok(note(new Error('x'.repeat(500))).length < 300);
});

const pr = (over: Record<string, unknown>): unknown => ({ number: 1, title: 't', state: 'open', updated_at: '2026-01-01T00:00:00Z', head: { ref: 'feature' }, ...over });
const ok = (list: unknown, headers: Record<string, string> = {}): string => reply(200, headers, typeof list === 'string' ? list : JSON.stringify(list));

test('fetchGithub keeps only well-formed pull requests and fills the fields an answer leaves out', async () => {
  const s = script(ok([
    null, 'text', 5, { number: 'x' }, { number: 1.5 }, pr({ number: 2, title: 7, head: null, state: 9, updated_at: 3 }), pr({ number: 3, merged_at: '2026-01-02T00:00:00Z' }),
    pr({ number: 4, head: { ref: 7 }, state: 'closed' }), pr({ number: 5 }),
  ]));
  const r = await fetchGithub(s.run, { repo: 'o/r' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows.map((x) => [x.number, x.title, x.headRefName, x.state, x.updated]), [
    [2, '', '', 'unknown', ''], [3, 't', 'feature', 'merged', '2026-01-01T00:00:00Z'], [4, 't', '', 'closed', '2026-01-01T00:00:00Z'], [5, 't', 'feature', 'open', '2026-01-01T00:00:00Z']]);
  assert.equal(r.etag, '');
  assert.equal(r.next.watermark, '2026-01-01T00:00:00Z');
});

test('fetchGithub answers soft for a body that is not JSON or not a list, and for a bad repository, and never throws', async () => {
  for (const body of ['not json', '{"a":1}', 'null']) {
    const r = await fetchGithub(script(ok(body)).run, { repo: 'o/r', etag: '"old"', since: '2026-01-01T00:00:00Z' });
    assert.equal(r.status, 'soft', body);
    assert.deepEqual(r.notes, ['fetch github: the answer is not a list']);
    assert.equal(r.etag, '"old"');
    assert.equal(r.next.watermark, '2026-01-01T00:00:00Z');
  }
  for (const repo of ['o', 'o/r/x', '../x', 'o/..', 'a b/c', 42 as unknown as string]) assert.equal((await fetchGithub(script().run, { repo })).status, 'soft', String(repo));
  assert.equal((await fetchGithub(script(reply(404)).run, { repo: 'o/r' })).notes[0], 'fetch github: answered 404');
});

test('fetchGithub keeps the first page etag, skips rows older than the watermark, follows the next link under its own path and stops on a loop', async () => {
  const s = script(
    ok([pr({ number: 1, updated_at: '2025-12-31T00:00:00Z' }), pr({ number: 2, updated_at: '2026-02-01T00:00:00Z' })], { ETag: '"first"', Link: '<https://evil.invalid/other/path?page=2&per_page=100>; rel="next"' }),
    ok([pr({ number: 3, updated_at: '2026-03-01T00:00:00Z' })]),
  );
  const r = await fetchGithub(s.run, { repo: 'o/r', since: '2026-01-01T00:00:00Z' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows.map((x) => x.number), [2, 3]);
  assert.equal(r.etag, '"first"');
  assert.equal(r.next.watermark, '2026-03-01T00:00:00Z');
  assert.equal(s.argvs[1]?.at(-1), 'repos/o/r/pulls?page=2&per_page=100');
  const loop = script(ok([pr({})], { Link: '<https://x.invalid/p?page=2>; rel="next"' }), ok([pr({ number: 2 })], { Link: '<https://x.invalid/p?page=2>; rel="next"' }));
  const l = await fetchGithub(loop.run, { repo: 'o/r' });
  assert.equal(l.status, 'soft');
  assert.deepEqual(l.notes, ['fetch github: paging loop']);
  const noQuery = script(ok([pr({})], { Link: '<https://x.invalid/p>; rel="next"' }));
  assert.equal((await fetchGithub(noQuery.run, { repo: 'o/r' })).status, 'ok');
});

test('fetchGithub sends If-None-Match on the first page only, treats 304 as not modified and a Retry-After as a stop with the cursor kept', async () => {
  const s = script(reply(304, { ETag: '"old"' }, ''));
  const r = await fetchGithub(s.run, { repo: 'o/r', etag: '"old"' });
  assert.equal(r.status, 'not-modified');
  assert.ok(s.argvs[0]?.includes('If-None-Match: "old"'));
  const full = script(ok([]));
  await fetchGithub(full.run, { repo: 'o/r', etag: '"old"', full: true });
  assert.ok(!full.argvs[0]?.some((a) => a.startsWith('If-None-Match')));
  const retry = script(ok([pr({})], { Link: '<https://x.invalid/p?page=2>; rel="next"' }), reply(429, { 'Retry-After': '30' }));
  const t = await fetchGithub(retry.run, { repo: 'o/r', etag: '"old"' });
  assert.equal(t.status, 'retry-after');
  assert.equal(t.retryAfter, 30);
  assert.equal(t.rows.length, 1);
  assert.equal(t.etag, '"old"');
  assert.equal(t.next.page, 'repos/o/r/pulls?page=2');
});

test('fetchGithub resumes only its own stored page, ignores a foreign one and caps by items and bytes', async () => {
  const resumed = script(ok([]));
  await fetchGithub(resumed.run, { repo: 'o/r', page: '/repos/o/r/pulls?page=7&per_page=100' });
  assert.equal(resumed.argvs[0]?.at(-1), 'repos/o/r/pulls?page=7&per_page=100');
  for (const page of ['https://evil.invalid/repos/o/r/pulls?x=1', 'repos/other/x/pulls?page=2', 'repos/o/r/pulls?next=https://evil.invalid/']) {
    const s = script(ok([]));
    await fetchGithub(s.run, { repo: 'o/r', page });
    assert.match(s.argvs[0]?.at(-1) as string, /^repos\/o\/r\/pulls\?per_page=100&sort=updated/, page);
  }
  const items = script(ok([pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })]));
  const a = await fetchGithub(items.run, { repo: 'o/r', maxItems: 2 });
  assert.equal(a.status, 'capped');
  assert.equal(a.rows.length, 2);
  assert.match(a.notes[0] as string, /fetch\.max_items 2 reached/);
  const exact = script(ok([pr({ number: 1 }), pr({ number: 2 })], { Link: '<https://x.invalid/p?page=2>; rel="next"' }));
  const b = await fetchGithub(exact.run, { repo: 'o/r', maxItems: 2 });
  assert.equal(b.status, 'capped');
  assert.equal(b.next.page, 'repos/o/r/pulls?page=2');
  const bytes = await fetchGithub(script(ok([pr({})])).run, { repo: 'o/r', maxBytes: 10 });
  assert.equal(bytes.status, 'capped');
  assert.deepEqual(bytes.rows, []);
  assert.match(bytes.notes[0] as string, /fetch\.max_bytes 10 reached/);
});
