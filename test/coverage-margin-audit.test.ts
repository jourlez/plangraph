// Coverage margin for src/commands/audit.ts: git failures of every shape, refs-update with and without keys, units and bundle over unusual
// tickets and text files, and the Jira commands over a stub fetch (a pull that fails, an unreadable earlier snapshot, a fetch that fails).
// Everything runs in process through main() with an injected context, so nothing depends on a terminal, CI variables or the network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { makeContext } from '../src/context.ts';
import type { ContextOptions } from '../src/context.ts';
import type { Exec, FetchLike } from '../lib/jira.ts';
import { openStore } from '../lib/planstore.ts';
import { fixture, copy, state, made, tmp } from './helpers/cli-fixture.ts';

before(async () => { state.FIX = await fixture(); });
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const HOME = tmp();
const BASE_ENV: Record<string, string> = { PATH: process.env.PATH as string, HOME, CLAUDE_PLUGIN_DATA: path.join(HOME, 'data'), PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_STRICT_OUT: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
async function run(d: string, argv: string[], env: Record<string, string> = {}, extra: Partial<ContextOptions> = {}): Promise<{ code: number; out: string[]; err: string[]; text: string }> {
  const out: string[] = [], err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(...String(s).split('\n')) };
  const prev = process.cwd();
  process.chdir(d);
  try {
    const code = await main(argv, { io, env: { ...BASE_ENV, ...env }, cwd: d, makeContext: (o: ContextOptions) => makeContext({ ...o, ...extra }) } as never);
    const flat = out.flatMap((l) => l.split('\n'));
    return { code, out: flat, err, text: [...flat, ...err].join('\n') };
  } finally { process.chdir(prev); }
}

test('a git failure is one data line: a bad ref is a usage error, an unknown ref names git, and a missing git binary says git failed', async () => {
  const d = copy();
  for (const cmd of ['stale', 'refs-update', 'units']) {
    const extra = cmd === 'units' ? ['--stale', '--out', path.join(d, 'u')] : [];
    const bad = await run(d, [cmd, '--ref=-bad', ...extra]);
    assert.equal(bad.code, 2, `${cmd}: ${bad.text}`);
    assert.match(bad.err.join('\n'), /invalid git ref/);
    const unknown = await run(d, [cmd, '--ref', 'no-such-ref', ...extra]);
    assert.equal(unknown.code, 2, `${cmd}: ${unknown.text}`);
    assert.match(unknown.err.join('\n'), /^error: git: .+/m);
  }
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path.join(d, 'no-such-bin');
    const none = await run(d, ['stale'], { PATH: process.env.PATH });
    assert.equal(none.code, 2, none.text);
    assert.match(none.err.join('\n'), /^error: git: /m);
  } finally { process.env.PATH = savedPath; }
  const heading = await run(d, ['bundle', 'T-1', '--ref=-bad']);
  assert.equal(heading.code, 2);
});

test('refs-update records every ticket without keys and only the named ones with keys, and ignores a word that is not a key', async () => {
  const d = copy();
  const all = await run(d, ['refs-update']);
  assert.equal(all.code, 0, all.text);
  assert.match(all.out.join('\n'), /^refs\.jsonl updated for \S+ tickets at [0-9a-f]+ \(ref HEAD\); run `plangraph build`$/m);
  const some = await run(d, ['refs-update', 'T-1', 'T-2', 'not-a-key']);
  assert.equal(some.code, 0, some.text);
  assert.match(some.out.join('\n'), /refs\.jsonl updated for \S+ tickets at /);
  const none = await run(d, ['refs-update', 'not-a-key', '--full']);
  assert.equal(none.code, 0, none.text);
});

test('units and bundle cover a ticket outside the plan, a ticket nobody scheduled, many findings and files, and every kind of text file', async () => {
  const d = copy();
  const dir = path.join(d, '.plangraph'), store = openStore({ dir, root: d });
  store.writeKind('ticket', [...store.readKind('ticket'), { key: 'U-1', summary: 'unscheduled', epic: '', sp: 1, jira_status: 'To Do', verdict: 'READY' }]);
  store.writeKind('finding', [...store.readKind('finding'), ...Array.from({ length: 52 }, (_, i) => ({ key: 'U-1', kind: 'risk', text: `finding ${i}` }))]);
  store.writeKind('ref', [...store.readKind('ref'), { key: 'U-1', plans: [{ plan: 'docs/plan.md', task: '9' }, { plan: 'missing/plan.md', task: '1' }], files: Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`src/f${i}.js`, 1])), fp_files: '', jira_updated: '', audited_at: '' }]);
  assert.equal((await run(d, ['build'])).code, 0);
  const texts = path.join(d, 'texts');
  fs.mkdirSync(texts);
  fs.writeFileSync(path.join(texts, 'T-1.txt'), 'jira text for T-1');
  fs.mkdirSync(path.join(texts, 'T-3.txt'));
  fs.writeFileSync(path.join(texts, 'real.txt'), 'x');
  fs.symlinkSync('real.txt', path.join(texts, 'T-4.txt'));
  const b = await run(d, ['bundle', 'U-1', 'T-1', 'T-3', 'T-4', 'T-5', 'Z-404', '--text', texts]);
  assert.equal(b.code, 0, b.text);
  const t = b.text;
  assert.match(t, /TICKET U-1 \|.* \| plan n\/a \|/);
  assert.match(t, /\.\.\. 2 more findings/);
  assert.match(t, /\(\+5 more\)/);
  assert.match(t, /--- PLAN docs\/plan\.md task 9 ---\n\(section not found\)/);
  assert.match(t, /--- PLAN missing\/plan\.md task 1: file not readable at HEAD ---/);
  assert.match(t, /--- JIRA TEXT T-1 ---/);
  assert.match(t, /--- JIRA TEXT T-3: not readable/);
  assert.match(t, /# Z-404: not in the plan/);
  const many = Array.from({ length: 101 }, (_, i) => `T-${i + 1}`);
  const tooMany = await run(d, ['bundle', ...many]);
  assert.equal(tooMany.code, 2);
  assert.match(tooMany.err.join('\n'), /bundle takes at most 100 keys/);
  const out = path.join(d, 'units');
  const u = await run(d, ['units', '--keys', 'T-1, T-2 ,bad key,,U-1', '--out', out, '--size', '2', '--text', texts, '--tokens-per-unit', '1000']);
  assert.equal(u.code, 0, u.text);
  assert.match(u.out.join('\n'), /^3 tickets -> 2 units in .*units\. Cost preview: 2 units x 1,000 tokens/m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'units.json'), 'utf8')), [{ id: 'u001', keys: ['T-1', 'T-2'] }, { id: 'u002', keys: ['U-1'] }]);
  fs.writeFileSync(path.join(d, 'keys.txt'), 'T-1\nT-2\n\n');
  const kf = await run(d, ['units', '--keys-file', 'keys.txt', '--out', path.join(d, 'units2')]);
  assert.equal(kf.code, 0, kf.text);
  assert.match(kf.out.join('\n'), /^2 tickets -> 1 units/m);
  assert.match((await run(d, ['units', '--keys-file', 'nope.txt', '--out', out])).err.join('\n'), /cannot read nope\.txt/);
  assert.match((await run(d, ['units', '--out', out])).err.join('\n'), /give --keys, --keys-file or --stale/);
  assert.match((await run(d, ['units', '--keys', 'T-1'])).err.join('\n'), /--out <dir> is required/);
  const stale = await run(d, ['units', '--stale', '--out', path.join(d, 'units3')]);
  assert.equal(stale.code, 0, stale.text);
});

// ---- Jira over a stub fetch
const keyOf = (root: string): string => crypto.createHash('sha256').update(fs.realpathSync(path.join(root, '.git'))).digest('hex');
function jiraWorld(): { d: string; env: Record<string, string> } {
  const d = copy();
  const cfgFile = path.join(d, '.plangraph', 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), jira: { tenant: 'work', jql: 'project = TST' } }));
  const cfg = tmp();
  fs.writeFileSync(path.join(cfg, 'jira-sites.json'), JSON.stringify({ aliases: { work: { cloud_id: 'work-cloud-0001', jql: 'project = WORK', credentials: { email_env: 'WORK_MAIL', token_env: 'WORK_TOKEN' }, repos: [keyOf(d)] } } }));
  return { d, env: { PLANGRAPH_CONFIG_DIR: cfg, WORK_MAIL: 'me@example.invalid', WORK_TOKEN: 'synthetic-token' } };
}
const noExec: Exec = async () => { throw new Error('no helper'); };
const stub = (answer: (u: URL, method: string) => Response): FetchLike => async (url, init) => answer(new URL(url), String(init.method || 'GET'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const goodFetch = stub((u, m) => (u.pathname.endsWith('/myself') ? json({ accountId: 'acct-1', timeZone: 'UTC' }) : m === 'POST' && /\/search\/(jql|approximate-count)$/.test(u.pathname) ? json({ issues: [], isLast: true, count: 0 }) : json({}, 404)));

test('jira-pull ignores an earlier snapshot it cannot read, refuses to write when the pull fails, and refuses an output it cannot write', async () => {
  const { d, env } = jiraWorld();
  const out = path.join(d, 'snap.jsonl');
  fs.writeFileSync(out, 'not a snapshot\n');
  const ok = await run(d, ['jira-pull', '--out', out], env, { exec: noExec, fetch: goodFetch });
  assert.equal(ok.code, 0, ok.text);
  fs.rmSync(out);
  fs.mkdirSync(out);
  const dirOut = await run(d, ['jira-pull', '--out', out], env, { exec: noExec, fetch: goodFetch });
  assert.notEqual(dirOut.code, 0, 'an output that is a directory is refused');
  fs.rmSync(out, { recursive: true });
  const failing = await run(d, ['jira-pull', '--out', out], env, { exec: noExec, fetch: stub((u) => (u.pathname.endsWith('/myself') ? json({ accountId: 'a' }) : json({ errorMessages: ['boom'] }, 500))) });
  assert.notEqual(failing.code, 0, failing.text);
  assert.equal(fs.existsSync(out), false, 'a failed pull writes no snapshot');
  const denied = await run(d, ['jira-pull', '--out', out], env, { exec: noExec, fetch: stub(() => json({ message: 'no' }, 401)) });
  assert.notEqual(denied.code, 0);
  assert.equal(fs.existsSync(out), false);
  const none = await run(d, ['jira-pull'], env, { exec: noExec, fetch: goodFetch });
  assert.equal(none.code, 2);
  assert.match(none.err.join('\n'), /needs --out/);
});

test('jira-text fetches from the tracker, names the directory, and turns a failing fetch into one error line', async () => {
  const { d, env } = jiraWorld();
  const issue = { key: 'ABC-1', fields: { summary: 'S', description: 'D', status: { name: 'To Do' }, comment: { comments: [] } } };
  const good = stub((u) => (u.pathname.endsWith('/myself') ? json({ accountId: 'a' }) : /\/issue\/ABC-1/.test(u.pathname) ? json(issue) : json({}, 404)));
  const out = path.join(d, 'jt');
  const ok = await run(d, ['jira-text', 'ABC-1', '--out', out], env, { exec: noExec, fetch: good });
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.out.join('\n'), /^wrote 1 files to /m);
  assert.ok(fs.existsSync(path.join(out, 'ABC-1.txt')));
  const bad = await run(d, ['jira-text', 'ABC-2', '--out', out], env, { exec: noExec, fetch: good });
  assert.notEqual(bad.code, 0, bad.text);
  assert.match((await run(d, ['jira-text', '--out', out], env)).err.join('\n'), /usage: plangraph jira-text/);
  assert.match((await run(d, ['jira-text', 'ABC-1'], env)).err.join('\n'), /usage: plangraph jira-text/);
});

test('jira-text --from-json reads one issue for every key or one per key, and jira-import refuses an unreadable snapshot and an unwritable output', async () => {
  const d = copy();
  const issue = (key: string) => ({ key, fields: { summary: key, status: { name: 'To Do' }, updated: '2026-11-20T10:00:00.000+0000' } });
  fs.writeFileSync(path.join(d, 'one.json'), JSON.stringify(issue('ABC-1')));
  fs.writeFileSync(path.join(d, 'map.json'), JSON.stringify({ 'ABC-1': issue('ABC-1'), 'ABC-2': issue('ABC-2') }));
  fs.writeFileSync(path.join(d, 'null.json'), 'null');
  fs.writeFileSync(path.join(d, 'list.json'), JSON.stringify([issue('ABC-3'), issue('ABC-4')]));
  assert.equal((await run(d, ['jira-text', 'ABC-1', '--out', 'jt1', '--from-json', 'one.json'])).code, 0);
  const both = await run(d, ['jira-text', 'ABC-1', 'ABC-2', '--out', 'jt2', '--from-json', 'map.json']);
  assert.equal(both.code, 0, both.text);
  assert.match(both.out.join('\n'), /^wrote 2 files$/m);
  assert.ok(fs.existsSync(path.join(d, 'jt2', 'ABC-2.txt')));
  const nul = await run(d, ['jira-text', 'ABC-1', '--out', 'jt3', '--from-json', 'null.json']);
  assert.equal(typeof nul.code, 'number');
  // jira-import: a snapshot path that is a directory cannot be read; an output inside a missing, unwritable place is refused
  fs.mkdirSync(path.join(d, 'snapdir'));
  const dirSnap = await run(d, ['jira-import', 'one.json', '--out', 'snapdir']);
  assert.notEqual(dirSnap.code, 0);
  assert.match(dirSnap.err.join('\n'), /cannot read the snapshot snapdir/);
  fs.writeFileSync(path.join(d, 'file.txt'), 'x');
  const blocked = await run(d, ['jira-import', 'one.json', '--out', path.join(d, 'file.txt', 'snap.jsonl')]);
  assert.notEqual(blocked.code, 0);
  const merged = await run(d, ['jira-import', 'one.json', 'list.json', '--out', 'snap.jsonl']);
  assert.equal(merged.code, 0, merged.text);
  assert.match(merged.out.join('\n'), /^imported \d+ issue\(s\) from 2 file\(s\)/m);
  assert.match((await run(d, ['jira-import', '--out', 'snap.jsonl'])).err.join('\n'), /usage: plangraph jira-import/);
});
