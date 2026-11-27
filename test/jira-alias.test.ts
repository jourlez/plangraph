// The neutral tenant alias (src/jira-tenant.ts, lib/jira/registry.ts, src/commands/plan.ts doctor --fix --alias). A committed `"tenant": "work"`
// keeps the company host out of the repository; each person binds the alias in their own jira-sites.json, and an alias resolves only for a
// repository the user approved in an interactive terminal. Every trust decision has an attack test: a recording exec counts credential-helper
// calls and a stub fetch counts requests, through the production wiring (makeContext({ exec, fetch, stdin }) and main).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.ts';
import { makeContext } from '../src/context.ts';
import { resolveTenant, repoKey, effectiveJira } from '../src/jira-tenant.ts';
import { JiraError, parseSiteRegistry } from '../lib/jira.ts';
import { ALIAS_RE } from '../lib/jira/registry.ts';
import { PROBES } from '../scripts/baseline.ts';
import type { ContextOptions, Stdin } from '../src/context.ts';
import type { JiraSettings } from '../src/jira-tenant.ts';
import type { Exec, FetchLike } from '../lib/jira.ts';

const made: string[] = [];
const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'))); made.push(d); return d; };
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** A real git repository (the approval key is its common directory) with a .plangraph/config.json holding `jira`. */
function repo(jira: unknown = { tenant: 'work', jql: 'project = TST' }): string {
  const d = tmp();
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: d, env: GIT_ENV }).status, 0);
  fs.mkdirSync(path.join(d, '.plangraph'));
  fs.writeFileSync(path.join(d, '.plangraph', 'config.json'), JSON.stringify(jira === undefined ? {} : { jira }));
  return d;
}
/** The approval key, computed independently of repoKey: SHA-256 hex of the real path of the git common directory. */
const keyOf = (root: string): string => crypto.createHash('sha256').update(fs.realpathSync(path.join(root, '.git'))).digest('hex');
const OTHER_KEY = 'ab'.repeat(32);
const CLOUD = 'work-cloud-0001';
const alias = (root: string | null, over: Record<string, unknown> = {}) => ({ cloud_id: CLOUD, jql: 'project = WORK', credentials: { email_env: 'WORK_MAIL', token_env: 'WORK_TOKEN' }, ...(root ? { repos: [keyOf(root)] } : {}), ...over });
/** A user config dir holding jira-sites.json. */
function cfgDir(obj: unknown): string { const d = tmp(); fs.writeFileSync(path.join(d, 'jira-sites.json'), typeof obj === 'string' ? obj : JSON.stringify(obj)); return d; }
const envFor = (cfg: string, extra: Record<string, string> = {}): Record<string, string> => { const h = tmp(); return { PATH: process.env.PATH as string, HOME: h, CLAUDE_PLUGIN_DATA: path.join(h, 'data'), PLANGRAPH_CONFIG_DIR: cfg, ...extra }; };
function recorders() {
  const execCalls: string[] = [], urls: string[] = [], auth: string[] = [];
  const exec: Exec = async (file, args) => { execCalls.push([file, ...args].join(' ')); throw new Error('no helper item'); };
  const fetch: FetchLike = async (url, init) => {
    urls.push(url); auth.push(String((init.headers as Record<string, string>)?.Authorization ?? ''));
    const u = new URL(url), method = String(init.method || 'GET');
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith('/myself')) return reply({ accountId: 'acct-1', timeZone: 'UTC' });
    if (method === 'POST' && /\/search\/(jql|approximate-count)$/.test(u.pathname)) return reply({ issues: [], isLast: true, count: 0 });
    return new Response('{}', { status: 404 });
  };
  return { execCalls, urls, auth, exec, fetch };
}
const fakeStdin = (isTTY: boolean, line = ''): Stdin & { reads: number } => { const s = { reads: 0, isTTY, read() { s.reads++; return line; } }; return s; };
async function run(argv: string[], cwd: string, env: Record<string, string>, extra: Partial<ContextOptions> = {}) {
  const out: string[] = [], err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), raw: (t: string) => out.push(t) };
  const code = await main(argv, { io, env, cwd, makeContext: (o) => makeContext({ ...o, ...extra }) });
  return { code, out, err, text: [...out, ...err].join('\n') };
}
const pull = (root: string, env: Record<string, string>, r: ReturnType<typeof recorders>) => run(['jira-pull', '--out', path.join(root, 'snap.jsonl')], root, env, { exec: r.exec, fetch: r.fetch });

test('an alias supplies site, jql and credentials names', async () => {
  const root = repo(), cfg = cfgDir({ aliases: { work: alias(root) } });
  const env = envFor(cfg, { WORK_MAIL: 'me@example.invalid', WORK_TOKEN: 'work-secret-token' });
  const t = resolveTenant({ tenant: 'work' }, root, env);
  assert.deepEqual([t.alias, t.aliasMissing, t.aliasProblem, t.tenant, t.jira.jql, t.jira.userTenant, t.allowGeneric], ['work', false, null, CLOUD, 'project = WORK', true, true]);
  assert.deepEqual(t.entry, { email_env: 'WORK_MAIL', token_env: 'WORK_TOKEN' });
  const r = recorders(), res = await pull(root, env, r);
  assert.equal(res.code, 0, res.text);
  assert.ok(r.urls.length > 0 && r.urls.every((u) => u.startsWith(`https://api.atlassian.com/ex/jira/${CLOUD}/`)), r.urls.join());
  assert.ok(r.auth.every((a) => Buffer.from(a.replace('Basic ', ''), 'base64').toString() === 'me@example.invalid:work-secret-token'));
  assert.deepEqual(r.execCalls, []);
});

test('projects[root] wins over the alias, the alias wins over committed fields', () => {
  const root = repo(), committed = { tenant: 'work', cloud_id: 'committed-cloud-1', jql: 'project = C', sprint_field: 'customfield_9' };
  const mk = (extra: Record<string, unknown>) => envFor(cfgDir({ aliases: { work: alias(root, { jql: 'project = A' }) }, ...extra }));
  const viaAlias = resolveTenant(committed, root, mk({}));
  assert.deepEqual([viaAlias.tenant, viaAlias.jira.jql, viaAlias.jira.sprint_field, viaAlias.jira.userTenant], [CLOUD, 'project = A', 'customfield_9', true]);
  const viaProject = resolveTenant(committed, root, mk({ projects: { [root]: { cloud_id: 'project-cloud-1' } } }));
  assert.deepEqual([viaProject.tenant, viaProject.jira.jql, viaProject.alias, viaProject.jira.userTenant], ['project-cloud-1', 'project = A', null, true]);
  assert.equal(viaProject.entry, null, 'the alias credentials are for the alias tenant only');
  const projectJql = resolveTenant(committed, root, mk({ projects: { [root]: { jql: 'project = P' } } }));
  assert.deepEqual([projectJql.tenant, projectJql.jira.jql], [CLOUD, 'project = P']);
  const committedOnly = resolveTenant({ cloud_id: 'committed-cloud-1', jql: 'project = C' }, root, mk({}));
  assert.deepEqual([committedOnly.tenant, committedOnly.alias, committedOnly.jira.userTenant], ['committed-cloud-1', null, false]);
  // a projects entry that decides the tenant makes an unapproved alias irrelevant: no refusal, and the alias contributes nothing
  const unapproved = resolveTenant(committed, root, envFor(cfgDir({ aliases: { work: alias(null) }, projects: { [root]: { cloud_id: 'project-cloud-1' } } })));
  assert.deepEqual([unapproved.tenant, unapproved.aliasProblem, unapproved.alias, unapproved.jira.jql], ['project-cloud-1', null, null, 'project = C']);
});

test('an alias equal to a committed site is trusted', () => {
  const root = repo(), site = 'https://same-example.atlassian.net';
  const env = envFor(cfgDir({ aliases: { work: alias(root, { cloud_id: undefined, auth: { mode: 'site-token' }, base_url: site }) } }));
  const t = resolveTenant({ tenant: 'work', auth: { mode: 'site-token' }, base_url: site }, root, env);
  assert.deepEqual([t.tenant, t.jira.userTenant, t.allowGeneric], ['same-example.atlassian.net', true, true]);
  const committedOnly = resolveTenant({ auth: { mode: 'site-token' }, base_url: site }, root, env);
  assert.deepEqual([committedOnly.jira.userTenant, committedOnly.allowGeneric], [false, false]);
});

test('a resolved alias drops committed base_url, cloud_id and auth', () => {
  const root = repo(), env = envFor(cfgDir({ aliases: { work: alias(root) } }));
  const j = effectiveJira({ tenant: 'work', auth: { mode: 'site-token' }, base_url: 'https://evil.atlassian.net', cloud_id: 'attacker-cloud-1', jql: 'project = C' }, root, env, { alias: { cloud_id: CLOUD } });
  assert.deepEqual([j.auth, j.base_url, j.cloud_id, j.userTenant, j.jql], [undefined, undefined, CLOUD, true, 'project = C']);
  const t = resolveTenant({ tenant: 'work', auth: { mode: 'site-token' }, base_url: 'https://evil.atlassian.net', cloud_id: 'attacker-cloud-1' }, root, env);
  assert.deepEqual([t.jira.auth, t.jira.base_url, t.jira.cloud_id, t.mode, t.tenant], [undefined, undefined, CLOUD, 'scoped', CLOUD]);
});

test('a missing alias is not an error for ticket and check, and is exit 3 naming the alias and the file for jira-pull, even with committed base_url or cloud_id', async () => {
  const cfg = cfgDir({ aliases: { other: alias(null) } }), r = recorders();
  for (const jira of [{ tenant: 'work' }, { tenant: 'work', cloud_id: 'committed-cloud-1' }, { tenant: 'work', auth: { mode: 'site-token' as const }, base_url: 'https://evil.atlassian.net', jql: 'project = TST' }] as JiraSettings[]) {
    const root = repo(jira), env = envFor(cfg, { JIRA_EMAIL: 'me@example.invalid', JIRA_API_TOKEN: 'generic-token-1', JIRA_BASE_URL: 'https://evil.atlassian.net' });
    const res = await pull(root, env, r);
    assert.equal(res.code, 3, res.text);
    const lines = res.err.filter((l) => l.startsWith('error:'));
    assert.equal(lines.length, 1, res.text);
    assert.match(lines[0] as string, /alias work, which is not defined in .*jira-sites\.json/);
    assert.ok((lines[0] as string).includes(path.join(cfg, 'jira-sites.json')));
    assert.equal(fs.existsSync(path.join(root, 'snap.jsonl')), false);
    const t = resolveTenant(jira, root, env);
    assert.deepEqual([t.aliasMissing, t.alias, t.tenant, t.jira.base_url, t.jira.cloud_id], [true, null, '', undefined, undefined]);
    // ticket and check never read the tracker settings: they answer as they do for a repository with no jira block
    const plain = repo(undefined);
    for (const argv of [['check'], ['ticket', 'TST-1']]) assert.equal((await run(argv, root, env)).code, (await run(argv, plain, env)).code, argv.join(' '));
  }
  assert.deepEqual(r.execCalls, []); assert.deepEqual(r.urls, []);
});

test('parseSiteRegistry drops unknown alias fields and reports a bad credentials name', () => {
  const p = parseSiteRegistry(JSON.stringify({ aliases: {
    work: { cloud_id: 'c-1', evil: 'drop', credentials: { token_env: 'bad name!', op_ref: 'nope', keychain: 'ok-service', evil: 1 }, repos: [OTHER_KEY, 'not-hex', 7] },
    Bad: { cloud_id: 'c-2' }, nothing: {}, notobject: 5,
  } }));
  assert.deepEqual(Object.keys(p.aliases), ['work']);
  assert.deepEqual(p.aliases.work, { cloud_id: 'c-1', credentials: { keychain: 'ok-service' }, repos: [OTHER_KEY], invalid: 'credentials.token_env is not an env var name' });
  assert.equal(Object.getPrototypeOf(p.aliases), null);
  for (const re of [/credentials\.token_env is not an env var name/, /credentials\.op_ref must look like/, /alias Bad: the name must match ALIAS_RE/, /alias nothing: no usable field/, /alias notobject: needs an object/, /alias work: repos holds only SHA-256 hex/]) assert.ok(p.problems.some((x) => re.test(x)), String(re));
  // an alias name that is an Object.prototype member never enters the map, and a __proto__ key (own after JSON.parse) does not pollute anything
  const q = parseSiteRegistry('{"aliases":{"__proto__":{"cloud_id":"x"},"constructor":{"cloud_id":"y"},"toString":{"cloud_id":"z"}}}');
  assert.deepEqual(Object.keys(q.aliases), []); assert.equal(q.problems.filter((x) => /must match ALIAS_RE/.test(x)).length, 3);
  assert.equal(({} as Record<string, unknown>).cloud_id, undefined);
});

test('alias credentials holding a value that is not an environment-variable name, op reference or keychain name is a bad_config naming the field', async () => {
  for (const [field, bad] of [['token_env', 'not a name'], ['email_env', '1bad'], ['op_ref', 'op://a b'], ['keychain', 'x y;z']] as const) {
    const root = repo(), env = envFor(cfgDir({ aliases: { work: alias(root, { credentials: { [field]: bad } }) } }), { JIRA_EMAIL: 'me@example.invalid', JIRA_API_TOKEN: 'generic-token-1' });
    assert.throws(() => resolveTenant({ tenant: 'work' }, root, env), (e: unknown) => e instanceof JiraError && e.code === 'bad_config' && e.message.includes(`credentials.${field}`));
    const r = recorders(), res = await pull(root, env, r);
    assert.equal(res.code, 3, res.text); assert.match(res.text, new RegExp(`alias work: credentials\\.${field}`));
    assert.deepEqual(r.execCalls, []); assert.deepEqual(r.urls, []);
    const d = await run(['doctor'], root, env);
    assert.match(d.text, /jira: invalid config: alias work: credentials\./);
  }
});

test('jira.tenant "__proto__", "constructor", "toString", "Work", "a b" are exit 2 naming ALIAS_RE for jira-pull, and ticket and check still run', async () => {
  const cfg = cfgDir({ aliases: { work: alias(null) } }), r = recorders();
  const ok = repo(undefined);
  for (const name of ['__proto__', 'constructor', 'toString', 'Work', 'a b', '', 'hasOwnProperty', 'x'.repeat(33), 7, null, ['work']]) {
    const root = repo({ tenant: name, jql: 'project = TST' }), env = envFor(cfg, { JIRA_EMAIL: 'me@example.invalid', JIRA_API_TOKEN: 'generic-token-1' });
    const res = await pull(root, env, r);
    assert.equal(res.code, 2, `${String(name)}: ${res.text}`);
    assert.match(res.text, /jira\.tenant must be an alias name \(ALIAS_RE \^\[a-z\]\[a-z0-9_-\]\{0,31\}\$\)/);
    assert.throws(() => resolveTenant({ tenant: name } as never, root, env), (e: unknown) => e instanceof JiraError && e.code === 'bad_input');
    for (const argv of [['check'], ['ticket', 'TST-1']]) assert.equal((await run(argv, root, env)).code, (await run(argv, ok, env)).code, argv.join(' '));
    const d = await run(['doctor'], root, env);
    assert.match(d.text, /jira: invalid config: jira\.tenant must be an alias name/);
  }
  assert.ok(ALIAS_RE.test('work') && !ALIAS_RE.test('Work'));
  assert.deepEqual(r.execCalls, []); assert.deepEqual(r.urls, []);
});

test('an alias named by a repository that is not in its repos list is exit 3 for jira-pull, tells the user to approve it in an interactive terminal, and runs no credential helper', async () => {
  for (const repos of [undefined, [OTHER_KEY]]) {
    const hostile = repo(), cfg = cfgDir({ aliases: { work: alias(null, repos ? { repos } : {}) } }), out = path.join(hostile, 'snap.jsonl');
    const env = envFor(cfg, { WORK_MAIL: 'me@example.invalid', WORK_TOKEN: 'work-secret-token', JIRA_OP_REF: 'op://Private/jira/generic' }), r = recorders();
    const res = await run(['jira-pull', '--out', out], hostile, env, { exec: r.exec, fetch: r.fetch });
    assert.equal(res.code, 3);
    assert.match(res.err.join('\n'), /alias work is not approved for this repository; approve it yourself in an interactive terminal \(docs\/JIRA\.md, Approving an alias\)/);
    assert.doesNotMatch(res.text, /doctor --fix --alias/);
    assert.equal(r.execCalls.length, 0); assert.equal(r.urls.length, 0); assert.equal(fs.existsSync(out), false);
    const t = resolveTenant({ tenant: 'work', cloud_id: 'committed-cloud-1' }, hostile, env);
    assert.deepEqual([t.alias, t.aliasMissing, t.tenant], [null, false, '']);
    const d = await run(['doctor'], hostile, env);
    assert.match(d.text, /warning: alias work is not approved for this repository/);
  }
});

test('outside a git repository an alias never resolves: exit 3 naming the reason', async () => {
  const d = tmp(); fs.mkdirSync(path.join(d, '.git')); fs.mkdirSync(path.join(d, '.plangraph')); // a .git entry that is not a repository
  fs.writeFileSync(path.join(d, '.plangraph', 'config.json'), JSON.stringify({ jira: { tenant: 'work' } }));
  const env = envFor(cfgDir({ aliases: { work: alias(null, { repos: [OTHER_KEY] }) } })), r = recorders();
  assert.equal(repoKey(d), null);
  const res = await pull(d, env, r);
  assert.equal(res.code, 3); assert.match(res.err.join('\n'), /alias work needs a git repository/);
  assert.equal(r.execCalls.length, 0); assert.equal(r.urls.length, 0);
});

test('doctor prints "(alias work)" and warns for an unresolved alias', async () => {
  const root = repo();
  assert.equal((await run(['init'], root, envFor(cfgDir({ aliases: {} })))).code, 0);
  const good = await run(['doctor'], root, envFor(cfgDir({ aliases: { work: alias(root) } })));
  const line = good.out.join('\n').split('\n').find((l) => l.startsWith('jira:')) as string;
  assert.match(line, new RegExp(`^jira: scoped, tenant ${CLOUD} \\(alias work\\), jql set, bound by registry \\(WORK_TOKEN MISSING\\)$`));
  const missing = await run(['doctor'], root, envFor(cfgDir({ aliases: {} })));
  assert.match(missing.out.join('\n'), /warning: jira\.tenant names alias work, which is not defined in .*jira-sites\.json.*; `plangraph jira-pull` refuses it/);
  assert.doesNotMatch(missing.out.join('\n'), /\(alias work\)/);
});

const approved = (reg: string, root: string): string[] => (JSON.parse(fs.readFileSync(reg, 'utf8')).aliases.work.repos ?? []);
test('doctor --fix --alias work on a TTY shows the alias host and the repository path, and records this repository only after the user types the host', async () => {
  const root = repo(), cfg = cfgDir({ sites: { 'keep.atlassian.net': { token_env: 'KEEP_TOKEN' } }, aliases: { work: alias(null, { repos: [OTHER_KEY] }) } }), reg = path.join(cfg, 'jira-sites.json');
  const env = envFor(cfg);
  assert.equal((await run(['init'], root, env)).code, 0);
  assert.equal(resolveTenant({ tenant: 'work' }, root, env).alias, null);
  // a wrong answer writes nothing
  const before = fs.readFileSync(reg, 'utf8');
  const no = await run(['doctor', '--fix', '--alias', 'work'], root, env, { stdin: fakeStdin(true, 'nope\n') });
  assert.equal(no.code, 1); assert.equal(fs.readFileSync(reg, 'utf8'), before); assert.match(no.out.join('\n'), /not approved; nothing was written/);
  // the typed host approves (read through ctx.stdin.read when the double has no readLine; a trailing newline and case are ignored)
  const s = fakeStdin(true, `${CLOUD.toUpperCase()}\n`);
  const yes = await run(['doctor', '--fix', '--alias', 'work'], root, env, { stdin: s });
  assert.equal(yes.code, 0, yes.text);
  const shown = yes.out.join('\n');
  assert.ok(shown.includes(`approve alias work for the repository ${root}`), shown);
  assert.ok(shown.includes(`alias work points at ${CLOUD}`), shown);
  assert.match(shown, /alias work approved for this repository/);
  assert.equal(s.reads, 1);
  assert.deepEqual(approved(reg, root), [OTHER_KEY, keyOf(root)]);
  assert.equal(fs.statSync(reg).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(reg, 'utf8')).sites, { 'keep.atlassian.net': { token_env: 'KEEP_TOKEN' } });
  assert.deepEqual(fs.readdirSync(cfg), ['jira-sites.json'], 'no temporary file is left behind');
  const t = resolveTenant({ tenant: 'work' }, root, env);
  assert.deepEqual([t.alias, t.tenant, t.aliasProblem], ['work', CLOUD, null]);
  // a second approval does not duplicate the entry
  await run(['doctor', '--fix', '--alias', 'work'], root, env, { stdin: fakeStdin(true, `${CLOUD}\n`) });
  assert.equal(approved(reg, root).filter((k) => k === keyOf(root)).length, 1);
});

test('doctor --fix --alias reads one line with readLine when the terminal offers it', async () => {
  const root = repo(), cfg = cfgDir({ aliases: { work: alias(null) } }), env = envFor(cfg);
  assert.equal((await run(['init'], root, env)).code, 0);
  let lines = 0;
  const stdin: Stdin = { isTTY: true, read() { throw new Error('read must not wait for the end of the input'); }, readLine() { lines++; return CLOUD; } };
  assert.equal((await run(['doctor', '--fix', '--alias', 'work'], root, env, { stdin })).code, 0);
  assert.equal(lines, 1); assert.deepEqual(approved(path.join(cfg, 'jira-sites.json'), root), [keyOf(root)]);
});

test('doctor --fix --alias work without a TTY (stdin.isTTY false) refuses with exit 2 and writes nothing', async () => {
  const root = repo(), cfg = cfgDir({ aliases: { work: alias(null) } }), reg = path.join(cfg, 'jira-sites.json'), env = envFor(cfg);
  assert.equal((await run(['init'], root, env)).code, 0);
  const before = fs.readFileSync(reg, 'utf8'), s = fakeStdin(false, `${CLOUD}\n`);
  const res = await run(['doctor', '--fix', '--alias', 'work'], root, env, { stdin: s });
  assert.equal(res.code, 2); assert.match(res.err.join('\n'), /needs an interactive terminal on stdin/);
  assert.equal(s.reads, 0, 'piped input is never read as the confirmation');
  assert.equal(fs.readFileSync(reg, 'utf8'), before);
  assert.equal(resolveTenant({ tenant: 'work' }, root, env).alias, null);
  // --alias without --fix, an undefined alias and a bad name are refused too, with the registry untouched
  for (const argv of [['doctor', '--alias', 'work'], ['doctor', '--fix', '--alias', 'nope'], ['doctor', '--fix', '--alias', 'constructor'], ['doctor', '--fix', '--alias', 'Work']]) {
    const x = await run(argv, root, env, { stdin: fakeStdin(true, 'work-cloud-0001\n') });
    assert.equal(x.code, 2, `${argv.join(' ')}: ${x.text}`); assert.equal(fs.readFileSync(reg, 'utf8'), before);
  }
  // outside a git repository there is nothing to approve
  const d = tmp(); fs.mkdirSync(path.join(d, '.git')); fs.mkdirSync(path.join(d, '.plangraph'));
  const nogit = await run(['doctor', '--fix', '--alias', 'work'], d, env, { stdin: fakeStdin(true, `${CLOUD}\n`) });
  assert.equal(nogit.code, 2); assert.equal(fs.readFileSync(reg, 'utf8'), before);
});

// ---- baseline probes: the expected outputs ----
const probe = (id: string) => (PROBES.find((p) => p.id === id) as { run(): unknown }).run();
test('probe alias-resolved', async () => {
  assert.deepEqual(await probe('alias-resolved'), { alias: 'work', tenant: 'probe-cloud-0001', jql: 'project = PRB', entry: { email_env: 'PROBE_MAIL', token_env: 'PROBE_TOKEN' }, userTenant: true, urlsAllOnTenant: true, code: 0 });
});
test('probe alias-missing-ticket', async () => { assert.deepEqual(await probe('alias-missing-ticket'), { check: 'same', ticket: 'same' }); });
test('probe alias-missing-pull', async () => {
  const r = await probe('alias-missing-pull') as { code: number; err: string[] };
  assert.equal(r.code, 3); assert.deepEqual(r.err, ['error: jira.tenant names alias work, which is not defined in <cfg>/jira-sites.json; add it under "aliases" (docs/JIRA.md, Keep the tenant out of the repository, portably)']);
});
test('probe alias-proto', async () => {
  const r = await probe('alias-proto') as { codes: Record<string, number>; messages: string[] };
  assert.deepEqual(r.codes, { __proto__: 2, constructor: 2, toString: 2, Work: 2, 'a b': 2 }); assert.equal(new Set(r.messages).size, 1); assert.match(r.messages[0] as string, /ALIAS_RE/);
});
