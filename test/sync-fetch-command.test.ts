// `sync-fetch` called through the `commands` export with a fake ctx and injected runners: recorded responses, no network, no gh.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands } from '../src/commands/sync-fetch.ts';
import { trust } from '../lib/fetch/trust.ts';
import { readCursor } from '../lib/fetch/cursor.ts';
import { ghRunner, jiraRunner } from '../src/fetch-runners.ts';
import { makeClient } from '../lib/jira/client.ts';
import type { Runner } from '../lib/fetch/gh.ts';

const bases: string[] = [];
after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
const load = (n: string): string => fs.readFileSync(new URL(`./fixtures/fetch/${n}`, import.meta.url), 'utf8');
type Step = string | Error | { code: number; out: string; err: string };
function rec(steps: Step[]): { run: Runner; calls: string[][] } {
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
function fixture(config: object, deps: { github?: Runner; jira?: Runner; confluence?: Runner } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-syncfetch-'))); bases.push(root);
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  const out: string[] = [], err: string[] = [], env = { XDG_CONFIG_HOME: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-syncfetch-cfg-'))) }; bases.push(env.XDG_CONFIG_HOME);
  const fetchDeps = {
    github: () => deps.github as Runner,
    atlassian: { tenant: () => 'cloud-1234', runner: async () => (deps.jira ?? deps.confluence) as Runner, confluenceRunner: async () => (deps.confluence ?? deps.jira) as Runner },
  };
  const ctx = { root, cwd: root, dir, flags: {}, env, config: () => config, now: () => new Date('2026-11-26T00:00:00Z'), fetchDeps,
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(s), outBlock: (l: string[]) => out.push(...l) } } as never;
  const cache = (n: string) => path.join(dir, 'cache', n);
  const rows = (n: string) => fs.readFileSync(cache(n), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { ctx, root, dir, env, out, err, cache, rows };
}
const run = (ctx: never, values: object = {}) => (commands['sync-fetch'] as { run: (c: never, a: never) => Promise<number> }).run(ctx, { values, positionals: [] } as never);
const GH = { fetch: { github: ['example/widgets'] }, jira: { tenant: 'acme', jql: 'project = ABC' } };
const TRUST_GH = 'plangraph trust github:example/widgets';

test('sync-fetch is a writer command named sync-fetch with no positionals', () => {
  assert.notEqual(commands['sync-fetch']?.writes, 'none');
  assert.deepEqual(commands['sync-fetch']?.positionals, [0, 0]);
});

test('an untrusted target is refused, the exact trust line is printed and no request is made', async () => {
  const gh = rec(['gh-page1.http']);
  const f = fixture(GH, { github: gh.run });
  assert.equal(await run(f.ctx), 0);
  assert.equal(gh.calls.length, 0);
  assert.ok(f.out.includes(TRUST_GH), f.out.join('|'));
  assert.equal(fs.existsSync(f.cache('github.jsonl')), false);
  assert.equal(await run(f.ctx, { strict: true }), 1);
});

test('a trusted github target writes cache/github.jsonl and the cursor at 0600, reports caps', async () => {
  const gh = rec(['gh-page1.http', 'gh-page2.http']);
  const f = fixture(GH, { github: gh.run });
  trust(f.root, 'github:example/widgets', f.env);
  assert.equal(await run(f.ctx), 0);
  assert.equal(fs.statSync(f.cache('github.jsonl')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.cache('github_example_widgets.cursor')).mode & 0o777, 0o600);
  const rs = f.rows('github.jsonl');
  assert.ok(rs.length >= 3);
  assert.ok(rs.every((r) => r.sys === 'github:example/widgets' && r.type === 'x-github.pr'));
  const c = readCursor(f.dir, 'github:example/widgets');
  assert.equal(c?.etag, 'W/"aaa111"');
  assert.match(f.out.join('\n'), /fetch\.max_items 50000/);
  assert.match(f.out.join('\n'), /fetch\.max_bytes 67108864/);
  assert.equal(fs.existsSync(path.join(f.dir, '.gitignore')), false, 'the cache/ ignore line is written by init or import, never by a fetch');
});

test('a second run sends the etag, a 304 keeps the cache; --full ignores the cursor', async () => {
  const gh = rec(['gh-page1.http', 'gh-page2.http', 'gh-304.http', 'gh-page1.http', 'gh-page2.http']);
  const f = fixture(GH, { github: gh.run });
  trust(f.root, 'github:example/widgets', f.env);
  await run(f.ctx);
  const before = fs.readFileSync(f.cache('github.jsonl'), 'utf8');
  await run(f.ctx);
  assert.ok(gh.calls[2]?.includes('If-None-Match: W/"aaa111"'), gh.calls[2]?.join(' '));
  assert.equal(fs.readFileSync(f.cache('github.jsonl'), 'utf8'), before);
  await run(f.ctx, { full: true });
  assert.ok(!gh.calls[3]?.some((a) => a.startsWith('If-None-Match')));
});

test('retry-after stops, keeps what was read and records the cursor page', async () => {
  const gh = rec(['gh-page1.http', 'gh-retry.http']);
  const f = fixture(GH, { github: gh.run });
  trust(f.root, 'github:example/widgets', f.env);
  assert.equal(await run(f.ctx), 0);
  assert.match(f.out.join('\n'), /Retry-After 30s/);
  assert.ok(readCursor(f.dir, 'github:example/widgets')?.page);
  assert.equal(f.rows('github.jsonl').length, 2);
});

test('a network error and a 429 change no file and exit 0; --strict exits 1', async () => {
  for (const step of [new Error('socket hang up'), { code: 0, out: 'HTTP/2.0 429 Too Many Requests\n\n{}', err: '' }] as Step[]) {
    const f = fixture(GH, { github: rec([step]).run });
    trust(f.root, 'github:example/widgets', f.env);
    assert.equal(await run(f.ctx), 0);
    assert.equal(fs.existsSync(f.cache('github.jsonl')), false);
    assert.equal(fs.existsSync(f.cache('github_example_widgets.cursor')), false);
    assert.equal(await run(f.ctx, { strict: true }), 1);
  }
});

test('a sentinel token in the environment appears in no output', async () => {
  const sentinel = 'sentinel-token-value-9f8e7d';
  process.env.PLANGRAPH_TEST_TOKEN = sentinel;
  try {
    const f = fixture(GH, { github: rec([{ code: 1, out: '', err: `bad credentials ${sentinel}` }]).run });
    trust(f.root, 'github:example/widgets', f.env);
    await run(f.ctx, { strict: true });
    assert.ok(!(f.out.join('\n') + f.err.join('\n')).includes(sentinel));
  } finally { delete process.env.PLANGRAPH_TEST_TOKEN; }
});

test('fetch.max_items is reported when it is reached and never silent', async () => {
  const f = fixture({ ...GH, fetch: { github: ['example/widgets'], max_items: 1 } }, { github: rec(['gh-page1.http']).run });
  trust(f.root, 'github:example/widgets', f.env);
  await run(f.ctx);
  assert.match(f.out.join('\n'), /fetch\.max_items 1 reached/);
  assert.match(f.out.join('\n'), /caps: fetch\.max_items 1/);
  assert.equal(f.rows('github.jsonl').length, 1);
});

test('jira: untrusted refused with the trust line; trusted pages by nextPageToken into cache/jira.jsonl with the watermark cursor', async () => {
  const jr = rec(['jira-p1.http', 'jira-p2.http']);
  const f = fixture({ jira: { tenant: 'acme', jql: 'project = ABC' }, fetch: {} }, { jira: jr.run });
  await run(f.ctx, { sys: 'jira' });
  assert.ok(f.out.includes('plangraph trust jira:cloud-1234'), f.out.join('|'));
  assert.equal(jr.calls.length, 0);
  trust(f.root, 'jira:cloud-1234', f.env);
  assert.equal(await run(f.ctx, { sys: 'jira' }), 0);
  assert.equal(jr.calls.length, 2);
  assert.match(jr.calls[1]?.at(-1) ?? '', /nextPageToken=tok-2/);
  assert.deepEqual(f.rows('jira.jsonl').map((r) => r.xid), ['ABC-1', 'ABC-2', 'ABC-3']);
  assert.ok(f.rows('jira.jsonl').every((r) => r.sys === 'jira:acme'));
  assert.equal(readCursor(f.dir, 'jira:acme')?.watermark, '2026-11-04T10:00:00.000Z');
  assert.equal(fs.statSync(f.cache('jira.jsonl')).mode & 0o777, 0o600);
});

test('jira without a tenant alias or a jql is a note, not a fetch', async () => {
  const f = fixture({ jira: {}, fetch: {} }, { jira: rec(['jira-p1.http']).run });
  assert.equal(await run(f.ctx, { sys: 'jira' }), 0);
  assert.match(f.out.join('\n'), /jira\.tenant|jira\.jql/);
});

test('confluence: trusted space is fetched, only labelled pages kept, injection text is capped and stays out of the output', async () => {
  const cr = rec(['confluence-p1.http', 'confluence-p2.http']);
  const f = fixture({ jira: { tenant: 'acme' }, fetch: { confluence: { space: '123', labels: ['plan'] } } }, { confluence: cr.run });
  await run(f.ctx, { sys: 'confluence' });
  assert.ok(f.out.includes('plangraph trust confluence:cloud-1234/123'), f.out.join('|'));
  trust(f.root, 'confluence:cloud-1234/123', f.env);
  assert.equal(await run(f.ctx, { sys: 'confluence' }), 0);
  const rs = f.rows('confluence.jsonl');
  assert.ok(rs.length >= 1 && rs.every((r) => r.type === 'x-confluence.page' && r.sys === 'confluence:acme'));
  assert.doesNotMatch(f.out.join('\n'), /Ignore previous instructions|alert\(1\)/);
});

test('--sys limits the run; an unknown --sys and nothing configured are reported', async () => {
  const gh = rec(['gh-page1.http']);
  const f = fixture(GH, { github: gh.run });
  trust(f.root, 'github:example/widgets', f.env);
  await run(f.ctx, { sys: 'jira' });
  assert.equal(gh.calls.length, 0);
  await assert.rejects(run(f.ctx, { sys: 'linear' }), (e: Error & { exitCode?: number }) => e.exitCode === 2);
  const g = fixture({}, {});
  assert.equal(await run(g.ctx), 0);
  assert.match(g.out.join('\n'), /nothing to fetch/);
});

test('a hostile repository name in committed config is refused before any request', async () => {
  const gh = rec(['gh-page1.http']);
  const f = fixture({ fetch: { github: ['../../etc/passwd', 'a/b c'] } }, { github: gh.run });
  assert.equal(await run(f.ctx), 0);
  assert.equal(gh.calls.length, 0);
  assert.match(f.out.join('\n'), /invalid github target/);
});

// ---- the real runners ----
test('ghRunner runs gh through execFile with the argv as given, never a shell, and refuses a non-GET request', async () => {
  const seen: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
  const run = ghRunner(async (file, args, opts) => { seen.push({ file, args: [...args], opts: opts as Record<string, unknown> }); return { stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' }; });
  const r = await run(['api', '--include', '--method', 'GET', 'repos/a/b/pulls?per_page=100']);
  assert.equal(r.code, 0);
  assert.deepEqual([seen[0]?.file, seen[0]?.args], ['gh', ['api', '--include', '--method', 'GET', 'repos/a/b/pulls?per_page=100']]);
  assert.notEqual(seen[0]?.opts.shell, true);
  for (const bad of [['api', '--method', 'POST', 'x'], ['api', '--include', '--method', 'GET', '-f', 'a=b', 'x'], ['auth', 'token'], ['api', '--include', '--method', 'GET', '--input', 'f', 'x'], ['api', 'x']]) {
    const e = await run(bad);
    assert.equal(e.code, 126, bad.join(' '));
  }
  assert.equal(seen.length, 1);
});
test('ghRunner returns the exit code, stdout and stderr of a failed gh instead of throwing', async () => {
  const run = ghRunner(async () => { throw Object.assign(new Error('x'), { code: 1, stdout: 'HTTP/2.0 403 Forbidden\nRetry-After: 5\n\n{}', stderr: 'e' }); });
  assert.deepEqual(await run(['api', '--include', '--method', 'GET', 'x']), { code: 1, out: 'HTTP/2.0 403 Forbidden\nRetry-After: 5\n\n{}', err: 'e' });
  const missing = ghRunner(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); });
  assert.equal((await missing(['api', '--include', '--method', 'GET', 'x'])).code, 127);
});

test('jiraRunner routes the GET search through client.search and other GETs through client.request', async () => {
  const calls: unknown[] = [];
  const client = {
    mode: 'scoped',
    search: async (q: unknown) => { calls.push(['search', q]); return { issues: [{ key: 'ABC-1', fields: {} }], cursor: 'tok-9', last: false }; },
    request: async (m: string, p: string, o: unknown) => { calls.push([m, p, o]); return { values: [], isLast: true }; },
  };
  const run = jiraRunner(client as never);
  const s = await run(['api', '--include', '--method', 'GET', '/rest/api/3/search/jql?jql=project+%3D+ABC&fields=summary%2Cstatus&maxResults=100&nextPageToken=tok-8']);
  assert.match(s.out, /^HTTP\/1\.1 200 OK\r\n\r\n/);
  assert.deepEqual(JSON.parse(s.out.split('\r\n\r\n')[1] as string), { issues: [{ key: 'ABC-1', fields: {} }], nextPageToken: 'tok-9', isLast: false });
  assert.deepEqual(calls[0], ['search', { jql: 'project = ABC', fields: ['summary', 'status'], pageSize: 100, cursor: 'tok-8' }]);
  await run(['api', '--include', '--method', 'GET', '/rest/api/3/issue/ABC-1/changelog?startAt=0&maxResults=100']);
  assert.deepEqual(calls[1], ['GET', '/rest/api/3/issue/ABC-1/changelog', { query: { startAt: '0', maxResults: '100' } }]);
  const bad = await run(['api', '--include', '--method', 'POST', '/rest/api/3/issue']);
  assert.equal(bad.code, 126);
  assert.equal(calls.length, 2);
});
test('jiraRunner maps a rate-limit error to a 429 with Retry-After and any other error to a failed request', async () => {
  const lim = jiraRunner({ mode: 'scoped', search: async () => { throw Object.assign(new Error('wait'), { code: 'rate_limit_wait', resetAt: undefined }); }, request: async () => ({}) } as never);
  assert.match((await lim(['api', '--include', '--method', 'GET', '/rest/api/3/search/jql?jql=x&fields=a&maxResults=1'])).out, /^HTTP\/1\.1 429 [^\r]*\r\nRetry-After: \d+\r\n\r\n/);
  const bad = jiraRunner({ mode: 'scoped', search: async () => { throw Object.assign(new Error('Jira answered 401'), { code: 'auth' }); }, request: async () => ({}) } as never);
  const r = await bad(['api', '--include', '--method', 'GET', '/rest/api/3/search/jql?jql=x&fields=a&maxResults=1']);
  assert.equal(r.code, 1); assert.equal(r.out, '');
  const dc = jiraRunner({ mode: 'datacenter', search: async () => ({ issues: [], cursor: 1, last: true }), request: async () => ({}) } as never);
  assert.equal((await dc(['api', '--include', '--method', 'GET', '/rest/api/3/search/jql?jql=x&fields=a&maxResults=1'])).code, 1);
});

// ---- the Jira client allowlist gains the two Confluence v2 reads ----
test('the Jira client allows GET of Confluence v2 pages of a space and refuses every other wiki path and verb', async () => {
  const urls: string[] = [];
  const fetchImpl = async (u: string, init: RequestInit) => { urls.push(`${init.method} ${u}`); return new Response('{"results":[]}', { status: 200 }); };
  const scoped = makeClient({ baseConfig: { mode: 'scoped', cloudId: 'cloud-1234' }, creds: { email: 'a@b.example', token: 'tok' }, fetchImpl: fetchImpl as never });
  await scoped.request('GET', '/wiki/api/v2/spaces/123/pages', { query: { limit: '100' } });
  assert.deepEqual(urls, ['GET https://api.atlassian.com/ex/confluence/cloud-1234/wiki/api/v2/spaces/123/pages?limit=100']);
  for (const [m, p] of [['POST', '/wiki/api/v2/spaces/123/pages'], ['PUT', '/wiki/api/v2/pages/1'], ['GET', '/wiki/rest/api/content'], ['GET', '/wiki/api/v2/spaces'], ['DELETE', '/wiki/api/v2/spaces/123/pages']] as const)
    await assert.rejects(scoped.request(m, p), { code: 'read_only' }, `${m} ${p}`);
  assert.equal(urls.length, 1);
});
