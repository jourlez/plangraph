// Branch coverage for `plangraph import` and `plangraph sync --plan`: tenant sources, .gitignore variants, cache path problems, sp input paths,
// empty input, --json, and the sync report caps, staleness config, empty and drifting cases.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { contentDigest, TABLES } from '../src/db.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let BASE = '', n = 0;
const env = () => ({ PATH: process.env.PATH as string, HOME: path.join(BASE, 'home'), CLAUDE_PLUGIN_DATA: path.join(BASE, 'data'), LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', ...GIT });
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, env: env(), encoding: 'utf8', timeout: 60000 });
const put = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const jl = (rows: readonly object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const repo = (tickets: readonly object[] = [{ key: 'T-1', sp: 1 }]): string => {
  const d = path.join(BASE, `r-${n++}`); fs.mkdirSync(d); execFileSync('git', ['init', '-q'], { cwd: d, env: env() });
  assert.equal(run(d, ['init']).status, 0);
  put(d, '.plangraph/tickets.jsonl', jl(tickets));
  return d;
};
const batch = (...xids: string[]) => JSON.stringify({ schema: 'plangraph-ext-batch@1', sys: 'x-demo', observations: xids.map((xid) => ({ xid, type: 'x-demo.item', fields: { state: 'open' }, links: [] })) });
const gi = (d: string) => path.join(d, '.plangraph/.gitignore');
const JIRA = JSON.stringify({ issues: [{ key: 'ABC-1', fields: { summary: 'S', status: { name: 'Done' } } }] });

before(() => { BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-isb-'))); for (const d of ['home', 'data']) fs.mkdirSync(path.join(BASE, d)); });
after(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });

test('import: the tenant comes from --tenant, else config.json jira.tenant; a non-string config tenant counts as none', () => {
  const d = repo(); put(d, 'i.json', JIRA);
  put(d, '.plangraph/config.json', JSON.stringify({ jira: { tenant: 'cfgco' } }));
  const ok = run(d, ['import', '--sys', 'jira', 'i.json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(fs.readFileSync(path.join(d, '.plangraph/cache/jira.jsonl'), 'utf8'), /"sys":"jira:cfgco"/);
  const over = run(d, ['import', '--sys', 'jira', 'i.json', '--tenant', 'other']);
  assert.equal(over.status, 0, over.stderr);
  assert.match(fs.readFileSync(path.join(d, '.plangraph/cache/jira.jsonl'), 'utf8'), /"sys":"jira:other"/);
  const e = repo(); put(e, 'i.json', JIRA);
  put(e, '.plangraph/config.json', JSON.stringify({ jira: { tenant: 7 } }));
  const bad = run(e, ['import', '--sys', 'jira', 'i.json']);
  assert.notEqual(bad.status, 0);
  assert.equal(fs.existsSync(path.join(e, '.plangraph/cache')), false);
});

test('import --json prints the summary object', () => {
  const d = repo(); put(d, 'b.json', batch('a', 'b'));
  const r = run(d, ['import', '--sys', 'generic', 'b.json', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.cmd, 'import'); assert.deepEqual(j.data, { sys: 'generic', imported: 2, changed: 2, dropped: 0, cache: 2 });
});

test('import: several files merge into one cache; a second import with new items keeps the old rows', () => {
  const d = repo(); put(d, 'a.json', batch('a')); put(d, 'b.json', batch('b')); put(d, 'c.json', batch('c'));
  const r = run(d, ['import', '--sys', 'generic', 'a.json', 'b.json']);
  assert.match(r.stdout, /imported 2 observation\(s\) from 2 file\(s\)/);
  const r2 = run(d, ['import', '--sys', 'generic', 'c.json']);
  assert.match(r2.stdout, /imported 1 observation\(s\) from 1 file\(s\).*cache now 3/);
});

test('import: input with no usable observation is a data error and writes nothing', () => {
  const d = repo(); put(d, 'e.json', batch());
  const r = run(d, ['import', '--sys', 'generic', 'e.json']);
  assert.equal(r.status, 2); assert.match(r.stderr, /no observation could be read/);
  assert.equal(fs.existsSync(path.join(d, '.plangraph/cache')), false);
  assert.equal(fs.existsSync(gi(d)) && fs.readFileSync(gi(d), 'utf8').includes('cache/'), false);
});

test('import: a --sys flag without a file, and a file without --sys, are usage errors; an unknown provider names the known ones', () => {
  const d = repo(); put(d, 'b.json', batch('a'));
  const a = run(d, ['import', '--sys', 'generic']); assert.equal(a.status, 2); assert.match(a.stderr, /usage: plangraph import/);
  const b = run(d, ['import', 'b.json']); assert.equal(b.status, 2); assert.match(b.stderr, /usage: plangraph import/);
  const c = run(d, ['import', '--sys', 'nope', 'b.json']); assert.equal(c.status, 2); assert.match(c.stderr, /unknown provider nope; known: generic, github, jira, sp/);
  const e = run(d, ['import', '--sys', 'generic', 'b.json', 'b.json', '--ledger', 'x']); assert.equal(e.status, 2); assert.match(e.stderr, /--ledger goes with --sys sp/);
});

test('import: .gitignore variants keep every user line and gain one cache/ line', () => {
  const cases: [string, string, string][] = [
    ['no trailing newline', 'node_modules', 'node_modules\ncache/\n'],
    ['empty file', '', 'cache/\n'],
    ['CRLF file', 'a\r\nb', 'a\r\nb\r\ncache/\r\n'],
    ['CRLF with trailing newline', 'a\r\n', 'a\r\ncache/\r\n'],
    ['already ignored (cache/)', 'x\ncache/\n', 'x\ncache/\n'],
    ['already ignored (/cache/)', '/cache/\n', '/cache/\n'],
    ['already ignored (cache)', 'cache\n', 'cache\n'],
  ];
  for (const [name, before_, after_] of cases) {
    const d = repo(); put(d, 'b.json', batch('a')); put(d, '.plangraph/.gitignore', before_);
    const r = run(d, ['import', '--sys', 'generic', 'b.json']);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(fs.readFileSync(gi(d), 'utf8'), after_, name);
  }
});

test('import: an unreadable .gitignore (a directory) is a data error and no cache is written', () => {
  const d = repo(); put(d, 'b.json', batch('a'));
  fs.rmSync(gi(d), { force: true }); fs.mkdirSync(gi(d));
  const r = run(d, ['import', '--sys', 'generic', 'b.json']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /\.gitignore/);
  assert.equal(fs.existsSync(path.join(d, '.plangraph/cache/generic.jsonl')), false);
});

test('import: a cache path that is a file is a data error; a symlinked .gitignore is refused', () => {
  const d = repo(); put(d, 'b.json', batch('a')); put(d, '.plangraph/cache', 'not a directory');
  const r = run(d, ['import', '--sys', 'generic', 'b.json']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /cache/);
  const e = repo(); put(e, 'b.json', batch('a')); put(e, 'elsewhere', 'x\n');
  fs.rmSync(gi(e), { force: true }); fs.symlinkSync(path.join(e, 'elsewhere'), gi(e));
  assert.notEqual(run(e, ['import', '--sys', 'generic', 'b.json']).status, 0);
  assert.equal(fs.readFileSync(path.join(e, 'elsewhere'), 'utf8'), 'x\n');
  assert.equal(fs.existsSync(path.join(e, '.plangraph/cache/generic.jsonl')), false);
});

test('import sp: a plan with a ledger, a missing ledger, a missing plan, a plan outside the repo', () => {
  const d = repo(); put(d, 'docs/plan.md', '# P\n\n### Task 1: one\n- [x] a\n');
  put(d, 'ledger.md', '# ledger\n');
  const ok = run(d, ['import', '--sys', 'sp', 'docs/plan.md', '--ledger', 'ledger.md']);
  assert.equal(ok.status, 0, ok.stderr);
  const noL = run(d, ['import', '--sys', 'sp', 'docs/plan.md', '--ledger', 'missing.md']);
  assert.equal(noL.status, 2); assert.match(noL.stderr, /cannot read input file plan\.md/);
  const noP = run(d, ['import', '--sys', 'sp', 'docs/missing.md']);
  assert.equal(noP.status, 2); assert.match(noP.stderr, /cannot read input file missing\.md/);
  const out = path.join(BASE, 'outside-plan.md'); fs.writeFileSync(out, '# P\n\n### Task 1: one\n- [ ] a\n');
  const o = run(d, ['import', '--sys', 'sp', out]);
  assert.equal(o.status, 0, o.stderr);
  assert.match(fs.readFileSync(path.join(d, '.plangraph/cache/sp.jsonl'), 'utf8'), /outside-plan\.md/);
  assert.doesNotMatch(fs.readFileSync(path.join(d, '.plangraph/cache/sp.jsonl'), 'utf8'), new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('import: a plan directory that does not exist is refused', () => {
  const d = fs.mkdtempSync(path.join(BASE, 'nobrain-')); put(d, 'b.json', batch('a'));
  const r = run(d, ['import', '--sys', 'generic', 'b.json']);
  assert.notEqual(r.status, 0);
});

test('import github: no tenant gives a warning on stderr (never input text) and still imports; with a tenant the PR links the ticket', () => {
  const d = repo(); put(d, 'g.json', JSON.stringify({ repo: 'acme/app', prs: [{ number: 3, title: 'fix ABC-12', headRefName: 'abc-12-fix', state: 'open' }] }));
  const r = run(d, ['import', '--sys', 'github', 'g.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^warning: no tenant alias/m); assert.doesNotMatch(r.stderr, /ABC-12/);
  const t = run(d, ['import', '--sys', 'github', 'g.json', '--tenant', 'acme']);
  assert.equal(t.status, 0, t.stderr); assert.equal(t.stderr, '');
  assert.match(fs.readFileSync(path.join(d, '.plangraph/cache/github.jsonl'), 'utf8'), /"xid":"ABC-12"/);
});

test('import: more than 50000 observations in the input, or in the merged cache, is a data error', () => {
  const many = (from: number, count: number) => JSON.stringify({ schema: 'plangraph-ext-batch@1', sys: 'x-demo', observations: Array.from({ length: count }, (_, i) => ({ xid: `i${from + i}`, type: 'x-demo.item' })) });
  const d = repo(); put(d, 'big1.json', many(0, 30000)); put(d, 'big2.json', many(30000, 30000));
  const r = run(d, ['import', '--sys', 'generic', 'big1.json', 'big2.json']);
  assert.equal(r.status, 2); assert.match(r.stderr, /more than 50000 observations/);
  assert.equal(fs.existsSync(path.join(d, '.plangraph/cache')), false);
  put(d, 'full.json', many(0, 50000)); put(d, 'one.json', many(90000, 1));
  assert.equal(run(d, ['import', '--sys', 'generic', 'full.json']).status, 0);
  const m = run(d, ['import', '--sys', 'generic', 'one.json']);
  assert.equal(m.status, 2); assert.match(m.stderr, /the cache would hold more than 50000/); assert.match(m.stderr, /delete the cache file/);
});

test('import: an unwritable plan directory or cache directory fails with nothing half written', { skip: process.getuid?.() === 0 }, () => {
  const d = repo(); put(d, 'b.json', batch('a')); const b = path.join(d, '.plangraph');
  fs.rmSync(gi(d), { force: true }); fs.chmodSync(b, 0o500);
  try { const r = run(d, ['import', '--sys', 'generic', 'b.json']); assert.notEqual(r.status, 0); } finally { fs.chmodSync(b, 0o700); }
  assert.equal(fs.existsSync(path.join(b, 'cache/generic.jsonl')), false);
  put(d, '.plangraph/.gitignore', 'cache/\n'); fs.mkdirSync(path.join(b, 'cache')); fs.chmodSync(path.join(b, 'cache'), 0o500);
  try { const r = run(d, ['import', '--sys', 'generic', 'b.json']); assert.notEqual(r.status, 0); } finally { fs.chmodSync(path.join(b, 'cache'), 0o700); }
  assert.equal(fs.existsSync(path.join(b, 'cache/generic.jsonl')), false);
});

// ---- sync --plan

const row = (xid: string, fields: object, seen = '2026-11-22', sys = 'jira:acme') => ({ sys, xid, type: 'ticket', fields, links: [], fp: '0123456789abcdef', seen });
function syncRepo(tickets: readonly object[], sched: readonly object[], obs: readonly object[], config?: object): string {
  const d = repo(tickets); const b = path.join(d, '.plangraph');
  put(d, '.plangraph/schedule.jsonl', jl(sched));
  for (const f of ['jira', 'sp']) { const mine = obs.filter((o) => String((o as { sys: string }).sys).split(':')[0] === f); if (mine.length) put(d, `.plangraph/cache/${f}.jsonl`, jl(mine)); }
  if (config) put(d, '.plangraph/config.json', JSON.stringify(config));
  assert.equal(run(d, ['build']).status, 0); void b;
  return d;
}

test('sync --plan: without --plan, with a positional, or without an index it refuses; an empty cache and no drift say so in text and JSON', () => {
  const d = syncRepo([{ key: 'T-1', sp: 1 }], [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }], []);
  const u = run(d, ['sync']); assert.equal(u.status, 2); assert.match(u.stderr, /usage: plangraph sync --plan/);
  assert.equal(run(d, ['sync', '--plan', 'extra']).status, 2);
  const t = run(d, ['sync', '--plan']); assert.equal(t.status, 0, t.stderr); assert.equal(t.stdout, 'no drift\n');
  const j = JSON.parse(run(d, ['sync', '--plan', '--json']).stdout);
  assert.deepEqual([j.data.findings, j.data.counts, j.data.truncated, j.data.push], [[], {}, 0, []]);
  const same = syncRepo([{ key: 'T-1', sp: 1 }], [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }], [row('T-1', { assignee: 'ana', sprint: '2' })]);
  assert.equal(run(same, ['sync', '--plan']).stdout, 'no drift\n');
});

test('sync --plan: findings without a plan value or a push (DRIFT_DONE, stale) print bare lines; a non-jira system gets no push line', () => {
  const d = syncRepo([{ key: 'T-1', sp: 1 }, { key: 'T-2', sp: 1 }], [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }],
    [row('T-2', { status: 'Done' }), row('T-1', { assignee: 'Eve' }, '2026-11-22', 'sp')]);
  const r = run(d, ['sync', '--plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^DRIFT_DONE T-2 plan open$/m);
  assert.match(r.stdout, /^DRIFT_ASSIGNEE T-1 plan Ana$/m);
  assert.doesNotMatch(r.stdout, /^push /m);
  const j = JSON.parse(run(d, ['sync', '--plan', '--json']).stdout);
  assert.deepEqual(j.data.push, []);
  const done = j.data.findings.find((f: { code: string }) => f.code === 'DRIFT_DONE');
  assert.equal(done.plan, 'open');
});

test('sync --plan: config graph.stale_days is honoured, a bad value falls back to 14 days', () => {
  const mk = (cfg?: object) => syncRepo([{ key: 'T-1', sp: 1 }], [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }], [row('T-1', { assignee: 'Ana' }, '2026-11-12')], cfg);
  assert.equal(run(mk(), ['sync', '--plan']).stdout, 'no drift\n');
  assert.match(run(mk({ graph: { stale_days: 3 } }), ['sync', '--plan']).stdout, /^XREF_STALE T-1/m);
  assert.equal(run(mk({ graph: { stale_days: 'x' } }), ['sync', '--plan']).stdout, 'no drift\n');
  assert.equal(run(mk({ graph: { stale_days: -1 } }), ['sync', '--plan']).stdout, 'no drift\n');
});

test('sync --plan: long reports are capped at 40 lines and 20 push lines; -v lifts the line cap; JSON keeps every finding', () => {
  const keys = Array.from({ length: 60 }, (_, i) => `T-${i + 1}`);
  const d = syncRepo(keys.map((key) => ({ key, sp: 1 })), keys.map((key) => ({ version: 'current', key, owner: 'Ana', sprint: 2 })), keys.map((k) => row(k, { assignee: 'Ben' })));
  const r = run(d, ['sync', '--plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('DRIFT_ASSIGNEE')).length, 40, 'the report stops at 40 finding lines');
  assert.match(r.stdout, /^\.\.\. \d+ more$/m, 'the output cap marks the cut');
  const v = run(d, ['sync', '--plan', '-v']);
  assert.equal(v.status, 0, v.stderr);
  assert.doesNotMatch(v.stdout, /lifts the cap/);
  assert.equal(v.stdout.split('\n').filter((l) => l.startsWith('DRIFT_ASSIGNEE')).length, 60);
  assert.match(v.stdout, /^push list \(apply after approval\):$/m);
  assert.equal(v.stdout.split('\n').filter((l) => l.startsWith('push T-')).length, 20);
  assert.match(v.stdout, /^truncated 40 push line\(s\)$/m);
  const j = JSON.parse(run(d, ['sync', '--plan', '--json']).stdout);
  assert.equal(j.data.findings.length, 60); assert.equal(j.data.push.length, 60); assert.equal(j.data.truncated, 0);
});

test('sync --plan: an orphaned xref prints a bare line (no plan value, no observed text) and a null observed in JSON', () => {
  const d = syncRepo([{ key: 'T-1', sp: 1 }], [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }], [row('ABC-2', {})]);
  put(d, '.plangraph/xrefs.jsonl', jl([{ type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-9', src: 'hand', seen: '2026-11-22' }]));
  assert.equal(run(d, ['build']).status, 0);
  const r = run(d, ['sync', '--plan']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^XREF_ORPHAN T-1$/m);
  assert.doesNotMatch(r.stdout, /<untrusted/);
  const f = JSON.parse(run(d, ['sync', '--plan', '--json']).stdout).data.findings.find((x: { code: string }) => x.code === 'XREF_ORPHAN');
  assert.deepEqual([f.plan, f.observed, f.xid], [null, null, 'ABC-9']);
});

test('sync --plan: an index built by an older plangraph (no obs table) is refused with STALE and the build hint', () => {
  const d = syncRepo([{ key: 'T-1', sp: 1 }], [], []);
  const file = path.join(d, '.plangraph/plangraph.sqlite');
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE obs');
  const h = { prepare: (q: string) => db.prepare(q) } as unknown as Parameters<typeof contentDigest>[0];
  db.prepare('UPDATE index_meta SET v = ? WHERE k = ?').run(contentDigest(h, [...TABLES.values()].filter((t) => t.name !== 'obs')), 'content_digest');
  db.close();
  const r = run(d, ['sync', '--plan']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /older plangraph/); assert.match(r.stderr, /plangraph build/);
});

test('import: an unreadable .gitignore file and a cache path that is a symlink are data errors', { skip: process.getuid?.() === 0 }, () => {
  const d = repo(); put(d, 'b.json', batch('a')); put(d, '.plangraph/.gitignore', 'x\n'); fs.chmodSync(gi(d), 0);
  try {
    const r = run(d, ['import', '--sys', 'generic', 'b.json']);
    assert.equal(r.status, 2); assert.match(r.stderr, /cannot read the plan directory \.gitignore/);
  } finally { fs.chmodSync(gi(d), 0o600); }
  assert.equal(fs.existsSync(path.join(d, '.plangraph/cache')), false);
  const e = repo(); put(e, 'b.json', batch('a')); fs.mkdirSync(path.join(e, '.plangraph/real'));
  fs.symlinkSync(path.join(e, '.plangraph/real'), path.join(e, '.plangraph/cache'));
  const s = run(e, ['import', '--sys', 'generic', 'b.json']);
  assert.notEqual(s.status, 0);
  assert.deepEqual(fs.readdirSync(path.join(e, '.plangraph/real')), []);
});
