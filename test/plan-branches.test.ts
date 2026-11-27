// Branch coverage of src/commands/plan.ts: whatif --find and unknown tickets, schedule-load refusals, init .gitignore handling and the doctor
// warnings. Every case calls the real command in-process (test/helpers/cli-fixture.ts) and asserts its output, exit code and files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { makeContext } from '../src/context.ts';
import type { Stdin } from '../src/context.ts';
import { fixture, run, copy, state, tmp, git, made } from './helpers/cli-fixture.ts';
import { readPlanFile } from './helpers/plan-dir.ts';

before(async () => { state.FIX = await fixture(); });
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const plan = (d: string) => path.join(d, '.plangraph');
const currentRows = (d: string) => readPlanFile(plan(d), 'schedule.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { key: string; owner: string; sprint: number });
const L = (r: { out: string[] }): string[] => r.out.join('\n').split('\n'); // a command may print one multi-line entry
const data = (r: { out: string[] }) => JSON.parse(r.out.join('\n')) as { ok: boolean; exit: number; data: Record<string, unknown> & { slots: Array<{ sprint: number; command: string }> }; next: string[] };

test('whatif --find --json lists the valid slots of a ticket with their commands, and -v keeps the same list', async () => {
  const d = copy();
  const r = await run(d, ['whatif', 'T-12', '--find', '--json']);
  assert.equal(r.code, 0);
  const j = data(r);
  assert.equal(j.data.status, 'found');
  assert.deepEqual(j.data.from, { owner: 'Ben', sprint: 2 });
  assert.deepEqual(j.data.slots.map((s) => [s.sprint, s.command]), [[3, 'plangraph whatif T-12 --sprint 3'], [4, 'plangraph whatif T-12 --sprint 4']]);
  assert.deepEqual(j.next, ['plangraph whatif T-12 --sprint 3', 'plangraph whatif T-12 --sprint 4']);
  const v = await run(d, ['whatif', 'T-12', '--find', '-v']);
  assert.equal(v.code, 0);
  assert.match(v.out.join('\n'), /^FIND T-12/);
});

test('whatif --find on a key that is not in the plan exits 1 with an empty slot list', async () => {
  const d = copy();
  const r = await run(d, ['whatif', 'NOPE', '--find', '--json']);
  assert.equal(r.code, 1);
  const j = data(r);
  assert.deepEqual([j.data.status, j.data.from, j.data.slots, j.next], ['unknown', null, [], []]);
  assert.deepEqual((await run(d, ['whatif', 'NOPE', '--find'])).out, ['NO: NOPE is not in the plan']);
});

test('whatif on an unknown ticket reports no ripple, no suggestion and no next command', async () => {
  const d = copy();
  const r = await run(d, ['whatif', 'NOPE', '--sprint', '2', '--json']);
  assert.equal(r.code, 1);
  const j = data(r);
  assert.deepEqual([j.data.ripple, j.data.suggestion, j.data.to, j.next], [0, null, null, []]);
  assert.deepEqual(j.data.reasons, [{ code: 'UNKNOWN_TICKET', key: 'NOPE', detail: 'not in plan', fix: 'check the key' }]);
});

test('whatif --apply-plan names the refusal when no repair exists', async () => {
  const d = copy();
  const bad = await run(d, ['whatif', 'T-5', '--to', 'Zed', '--sprint', '2', '--apply-plan']);
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.out, ['NO PLAN: UNKNOWN_PERSON Zed not an owner or capacity person']);
  const far = await run(d, ['whatif', 'T-5', '--sprint', '9', '--apply-plan']);
  assert.equal(far.code, 1);
  assert.match(far.out[0] as string, /^NO PLAN: OUT_OF_RANGE T-5 S9/);
});

test('whatif --apply-plan --write moves the tickets in the index only, then export saves them as text', async () => {
  const d = copy();
  const before = readPlanFile(plan(d), 'schedule.jsonl');
  const r = await run(d, ['whatif', 'T-5', '--sprint', '3', '--apply-plan', '--write']);
  assert.equal(r.code, 0);
  assert.equal(L(r)[0], 'PLAN: 3 move(s), 2 others shifted, 0 owner changes');
  assert.equal(L(r).at(-1), 'written to the index; run `plangraph export` to save it as text');
  assert.equal(readPlanFile(plan(d), 'schedule.jsonl'), before);
  assert.equal((await run(d, ['export'])).code, 0);
  assert.equal(currentRows(d).find((x) => x.key === 'T-5')?.sprint, 3);
});

test('schedule-load refuses a name that is already an archive, owners that are not in the plan, and a file the index rejects', async () => {
  const d = copy(), rows = currentRows(d).map((x) => ({ item: x.key, owner: x.owner, sprint: x.sprint }));
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify(rows));
  const ok = await run(d, ['schedule-load', 's.json', 'old1']);
  assert.equal(ok.code, 0);
  assert.equal(L(ok)[0], 'loaded as current; previous plan kept as old1; run `plangraph export` to save it as text');
  const again = await run(d, ['schedule-load', 's.json', 'old1']);
  assert.equal(again.code, 2);
  assert.match(again.err.join('\n'), /archive name already used: old1/);
  // 12 owners that are no people in the plan: ten are named, the rest counted
  const many = [...rows, ...Array.from({ length: 12 }, (_, i) => ({ item: `X-${i}`, owner: `Ghost${i}`, sprint: 1 }))];
  fs.writeFileSync(path.join(d, 'many.json'), JSON.stringify(many));
  const bad = await run(d, ['schedule-load', 'many.json', 'old2']);
  assert.equal(bad.code, 2);
  assert.match(bad.err.join('\n'), /schedule has owners that are not people in the plan: Ghost0, Ghost1, .*Ghost9 \(\+2 more\)/);
  // a duplicate key breaks the insert: rolled back, the current plan and archives are unchanged
  fs.writeFileSync(path.join(d, 'dup.json'), JSON.stringify([...rows, rows[0]]));
  const dup = await run(d, ['schedule-load', 'dup.json', 'old3']);
  assert.equal(dup.code, 2);
  assert.match(dup.err.join('\n'), /^error: schedule file could not be loaded: /);
  const after = await run(d, ['schedule-load', 's.json', 'old3']);
  assert.equal(after.code, 0, 'the failed load left no archive named old3 behind');
});

test('init adds only the missing ignore lines, keeping the file own line ending and a missing final newline', async () => {
  const d = copy(), gi = path.join(plan(d), '.gitignore');
  fs.writeFileSync(gi, 'keep.me');
  assert.match(L(await run(d, ['init']))[0] as string, /^already initialised: \.plangraph \(added cache\/, plangraph\.sqlite\*, \.txn\/ to \.gitignore\)$/);
  assert.equal(fs.readFileSync(gi, 'utf8'), 'keep.me\ncache/\nplangraph.sqlite*\n.txn/\n');
  fs.writeFileSync(gi, 'cache/\r\nother');
  await run(d, ['init']);
  assert.equal(fs.readFileSync(gi, 'utf8'), 'cache/\r\nother\r\nplangraph.sqlite*\r\n.txn/\r\n');
  fs.writeFileSync(gi, '');
  await run(d, ['init']);
  assert.equal(fs.readFileSync(gi, 'utf8'), 'cache/\nplangraph.sqlite*\n.txn/\n');
  const none = await run(d, ['init']);
  assert.equal(L(none)[0], 'already initialised: .plangraph (no changes)');
});

test('init refuses a symlinked format.json with exit 4 and writes nothing', async () => {
  const d = tmp();
  git(d, 'init', '-q');
  fs.mkdirSync(path.join(d, '.plangraph'));
  fs.symlinkSync(path.join(d, 'elsewhere.json'), path.join(plan(d), 'format.json'));
  const r = await run(d, ['init']);
  assert.equal(r.code, 4);
  assert.match(r.err.join('\n'), /refusing to write/);
  assert.equal(fs.existsSync(path.join(plan(d), 'config.json')), false);
});

test('doctor reports a committed index and journal, a stale ignore file, problem node files, stray files and the companion tools', async () => {
  const d = copy(), P = plan(d), home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'superpowers@mk': [{ scope: 'user', version: '5.1.0' }], 'gitkraken-hooks@mk': [{ scope: 'user', version: '1.2.3' }] } }));
  fs.mkdirSync(path.join(d, '.wolf'));
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'hello\n');
  fs.writeFileSync(path.join(d, 'a.original.md'), 'x');
  fs.mkdirSync(path.join(P, 'nodes/ticket/ab'), { recursive: true }); fs.writeFileSync(path.join(P, 'nodes/ticket/ab/x~00000000.pg'), 'id "x"\n<<<<<<< a\nowner "a"\n=======\nowner "b"\n>>>>>>> b\n');
  fs.writeFileSync(path.join(P, '.gitignore'), '*.sqlite');
  fs.writeFileSync(path.join(P, 'plangraph.sqlite-journal'), '');
  git(d, 'add', '-f', '.plangraph/plangraph.sqlite', '.plangraph/plangraph.sqlite-journal');
  const r = await run(d, ['doctor'], { HOME: home });
  assert.equal(r.code, 1);
  const t = r.out.join('\n');
  assert.match(t, /tracked index: \.plangraph\/plangraph\.sqlite is committed; untrack it with `git rm --cached \.plangraph\/plangraph\.sqlite`/);
  assert.match(t, /warning: \.plangraph\/plangraph\.sqlite-journal: a SQLite journal file beside the index/);
  assert.match(t, /warning: tracked journal: \.plangraph\/plangraph\.sqlite-journal is committed/);
  assert.match(t, /warning: \.plangraph\/\.gitignore does not ignore the derived files \(cache\/, plangraph\.sqlite\*, \.txn\/\)/);
  assert.match(t, /warning: store: 1 problem files \(run plangraph check\)/);
  assert.match(t, /warning: stray file a\.original\.md /);
  assert.match(t, /^superpowers: installed 5\.1\.0$/m);
  assert.match(t, /^gitkraken: installed 1\.2\.3: logs every prompt and tool result/m);
  assert.match(t, /warning: openwolf: rules only: its hooks are not registered/);
  assert.match(t, /info: CLAUDE\.md does not steer plan questions to plangraph/);
});

test('doctor lists at most five stray files', async () => {
  const d = copy();
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(d, `s${i}.original.md`), 'x');
  const t = (await run(d, ['doctor'])).out.join('\n');
  assert.match(t, / {2}\.\.\. and 2 more/);
  assert.equal((t.match(/warning: stray file/g) || []).length, 5);
});

// ---- the jira line of doctor: one case per credential source ----
const jiraLine = (r: { out: string[] }) => L(r).find((l) => l.startsWith('jira:')) as string;
function withJira(jira: unknown, sites?: unknown) {
  const d = copy(), cfg = path.join(plan(d), 'config.json'), c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  c.jira = jira; fs.writeFileSync(cfg, JSON.stringify(c));
  const env: Record<string, string> = {};
  if (sites !== undefined) { const cd = tmp(); fs.writeFileSync(path.join(cd, 'jira-sites.json'), JSON.stringify(sites)); env.PLANGRAPH_CONFIG_DIR = cd; }
  return { d, env };
}
const SITE = { auth: { mode: 'site-token' }, base_url: 'https://acme.atlassian.net', jql: 'project = ABC' };

test('doctor names the credential source of a registry entry without printing a secret', async () => {
  for (const [entry, want] of [[{ token_env: 'ACME_TOKEN' }, 'bound by registry (ACME_TOKEN MISSING)'], [{ token_env: 'ACME_TOKEN' }, 'bound by registry (ACME_TOKEN set)'], [{ op_ref: 'op://v/i/f' }, 'bound by registry (op ref)'], [{ email_env: 'ACME_MAIL' }, 'bound by registry (keychain)']] as const) {
    const { d, env } = withJira(SITE, { sites: { 'acme.atlassian.net': entry } });
    if (want.endsWith('set)')) env.ACME_TOKEN = 'secret-value-1';
    const r = await run(d, ['doctor'], env);
    assert.equal(jiraLine(r), `jira: site-token, tenant acme.atlassian.net, jql set, ${want}`, want);
    assert.ok(!r.out.join('\n').includes('secret-value-1') && !r.out.join('\n').includes('op://v/i/f'));
  }
});

test('doctor names a tenant-bound env credential, a generic op reference, missing generic credentials and an unknown tenant', async () => {
  const { d, env } = withJira(SITE);
  const tagged = await run(d, ['doctor'], { ...env, JIRA_API_TOKEN__ACME: 'secret-value-2' });
  assert.match(jiraLine(tagged), /^jira: site-token, tenant acme\.atlassian\.net, jql set, bound by env JIRA_\*__ACME$/);
  assert.ok(!tagged.out.join('\n').includes('secret-value-2'));
  const op = await run(d, ['doctor'], { ...env, JIRA_OP_REF__ACME: 'op://v/i/f' });
  assert.match(jiraLine(op), /bound by env JIRA_\*__ACME$/);
  const generic = { ...env, PLANGRAPH_JIRA_SITES: 'acme.atlassian.net' };
  assert.match(jiraLine(await run(d, ['doctor'], { ...generic, JIRA_OP_REF: 'op://v/i/f' })), /generic env JIRA_OP_REF set$/);
  assert.match(jiraLine(await run(d, ['doctor'], generic)), /no credentials in env \(OS keychain not checked\)$/);
  const unknown = withJira({ jql: 'project = ABC' });
  assert.match(jiraLine(await run(unknown.d, ['doctor'])), /^jira: \S+, tenant \?, jql set, tenant unknown \(base_url or cloud_id missing\)$/);
});

// ---- doctor --fix --alias: the host shown for each kind of alias, and a registry that cannot be written ----

const keyOf = (root: string): string => crypto.createHash('sha256').update(fs.realpathSync(path.join(root, '.git'))).digest('hex');
async function aliasRun(d: string, cfg: string, line: string, argv: string[] = ['doctor', '--fix', '--alias', 'work']) {
  const out: string[] = [], err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), raw: (t: string) => out.push(t) };
  const stdin: Stdin = { isTTY: true, read() { return line; } };
  const h = tmp(), env = { PATH: process.env.PATH as string, HOME: h, CLAUDE_PLUGIN_DATA: path.join(h, 'data'), PLANGRAPH_CONFIG_DIR: cfg };
  const code = await main(argv, { io, env, cwd: d, makeContext: (o) => makeContext({ ...o, stdin }) });
  return { code, out: out.join('\n').split('\n'), err: err.join('\n') };
}
const aliasCfg = (entry: unknown): string => { const c = tmp(); fs.writeFileSync(path.join(c, 'jira-sites.json'), JSON.stringify({ aliases: { work: entry } })); return c; };

test('doctor --fix --alias asks for the lower-cased host of a base_url alias and approves on a match', async () => {
  const d = copy(), cfg = aliasCfg({ auth: { mode: 'site-token' }, base_url: 'https://Work.Example.NET/x', jql: 'project = W' });
  const no = await aliasRun(d, cfg, 'other\n');
  assert.equal(no.code, 1);
  assert.ok(no.out.includes('alias work points at work.example.net; approving lets this repository\'s jira-pull use the credentials you bound to it'), no.out.join('|'));
  assert.ok(no.out.includes('type work.example.net to approve, anything else to cancel:'));
  assert.ok(no.out.includes('alias work not approved; nothing was written'));
  const yes = await aliasRun(d, cfg, 'WORK.example.net\n');
  assert.equal(yes.code, 0, yes.err);
  assert.ok(yes.out.includes('alias work approved for this repository'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, 'jira-sites.json'), 'utf8')).aliases.work.repos, [keyOf(d)]);
});

test('doctor --fix --alias with an alias that has no host asks for the alias name; an unparsable base_url counts as no host', async () => {
  for (const entry of [{ jql: 'project = W' }, { auth: { mode: 'site-token' }, base_url: 'not a url', jql: 'project = W' }]) {
    const d = copy(), cfg = aliasCfg(entry);
    const r = await aliasRun(d, cfg, 'work\n');
    assert.ok(r.out.some((l) => l.startsWith('alias work points at (no host: the credentials only);')), r.out.join('|') + r.err);
    assert.ok(r.out.includes('type work to approve, anything else to cancel:'));
    assert.equal(r.code, 0, r.err);
  }
});

test('doctor --fix --alias reports a registry that cannot be written as a usage error', async () => {
  const d = copy(), cfg = aliasCfg({ cloud_id: 'work-cloud-0001', jql: 'project = W' });
  fs.chmodSync(cfg, 0o500);
  try {
    const r = await aliasRun(d, cfg, 'work-cloud-0001\n');
    if (process.getuid?.() === 0) return; // root can write anywhere
    assert.equal(r.code, 2);
    assert.match(r.err, /^error: /);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'jira-sites.json'), 'utf8')).aliases.work.repos, undefined);
  } finally { fs.chmodSync(cfg, 0o700); }
});
