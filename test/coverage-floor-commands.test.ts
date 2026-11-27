// Per-file coverage floor: the singular and plural messages, the option and environment switches and the refusals of the compact, map, trust and
// uninstall commands, driven through the `commands` exports with a fake context over a temporary plan directory. Synthetic data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands as compactCmds } from '../src/commands/compact.ts';
import { commands as mapCmds } from '../src/commands/map.ts';
import { commands as trustCmds } from '../src/commands/trust.ts';
import { commands as uninstallCmds } from '../src/commands/uninstall.ts';
import { flowFixture, cleanup, run } from './helpers/flow-ctx.ts';

const bases: string[] = [];
after(() => { cleanup(); for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
const tmp = (p: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); bases.push(d); return d; };
type Cmd = { run: (c: never, a: never) => unknown };
const call = async (cmds: unknown, name: string, ctx: unknown, values: object = {}, positionals: string[] = []): Promise<number> => ((await (cmds as Record<string, Cmd>)[name]?.run(ctx as never, { values, positionals } as never)) as number | undefined) ?? 0;

// ---- compact
const evRow = (task: string, by: string, seq: number, at: string) => JSON.stringify({ at, seq, task, to: 'in_progress', by, evidence: [] });
function planWithEvents(months: Record<string, string[]>): { ctx: never; out: string[]; dir: string } {
  const root = tmp('plangraph-floor-compact-'), dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  for (const [m, files] of Object.entries(months)) {
    fs.mkdirSync(path.join(dir, 'events', m), { recursive: true });
    for (const [i, content] of files.entries()) fs.writeFileSync(path.join(dir, 'events', m, `ana.${String(i).repeat(8)}.01.jsonl`), content);
  }
  const out: string[] = [];
  const ctx = { root, dir, flags: {}, env: { CI: 'true' }, io: { out: (s: string) => out.push(s), err: () => undefined } } as never;
  return { ctx, out, dir };
}
const good = (n: number, month: string) => evRow(`sp:t${n}`, 'ana', n, `${month}-05T10:00:00Z`) + '\n';

test('compact with nothing sealed says so and returns 0', async () => {
  const w = planWithEvents({});
  assert.equal(await call(compactCmds, 'compact', w.ctx), 0);
  assert.deepEqual(w.out, ['nothing to compact']);
});

test('compact merges one sealed month: singular message and one compact file left', async () => {
  const w = planWithEvents({ '2020-01': [good(1, '2020-01'), good(2, '2020-01')] });
  assert.equal(await call(compactCmds, 'compact', w.ctx), 0);
  assert.deepEqual(w.out, ['compacted 1 file']);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, 'events', '2020-01')).map((n) => /^_compact\.[0-9a-f]{8}\.jsonl$/.test(n)), [true]);
});

test('compact merges two sealed months: plural message', async () => {
  const w = planWithEvents({ '2020-01': [good(1, '2020-01'), good(2, '2020-01')], '2020-02': [good(3, '2020-02'), good(4, '2020-02')] });
  assert.equal(await call(compactCmds, 'compact', w.ctx), 0);
  assert.deepEqual(w.out, ['compacted 2 files']);
});

test('compact skips a month with a bad line and names it, singular then plural', async () => {
  const one = planWithEvents({ '2020-01': [good(1, '2020-01'), 'not json\n'] });
  assert.equal(await call(compactCmds, 'compact', one.ctx), 0);
  assert.deepEqual(one.out, ['nothing to compact', 'skipped 1 month with a bad line (run plangraph check): events/2020-01']);
  const two = planWithEvents({ '2020-01': ['nope\n'], '2020-02': ['nope\n'] });
  await call(compactCmds, 'compact', two.ctx);
  assert.deepEqual(two.out, ['nothing to compact', 'skipped 2 months with a bad line (run plangraph check): events/2020-01, events/2020-02']);
});

test('compact refuses outside CI as a REFUSED error with a hint; --ci lifts the refusal', async () => {
  const saved = process.env.CI;
  delete process.env.CI;
  try {
    const w = planWithEvents({});
    (w.ctx as { env: Record<string, string> }).env = {};
    await assert.rejects(() => call(compactCmds, 'compact', w.ctx), (e: Error & { code?: string; hint?: string }) => e.code === 'REFUSED' && /only in CI/.test(e.message) && /--ci/.test(String(e.hint ?? '')));
    assert.equal(await call(compactCmds, 'compact', w.ctx, { ci: true }), 0);
    assert.deepEqual(w.out, ['nothing to compact']);
  } finally { if (saved === undefined) delete process.env.CI; else process.env.CI = saved; }
});

test('compact rethrows an error that is not a refusal', async () => {
  const w = planWithEvents({});
  fs.rmSync(w.dir, { recursive: true, force: true });
  await assert.rejects(() => call(compactCmds, 'compact', w.ctx), (e: Error & { code?: string }) => e.code !== 'REFUSED');
});

// ---- map
test('map prints a bounded digest, hands the data to the JSON sink and passes --repo and a missing fingerprint through', async () => {
  const f = flowFixture();
  const sink: unknown[] = [];
  (f.ctx as { io: { data?: (d: unknown) => void } }).io.data = (d: unknown) => { sink.push(d); };
  assert.equal(await run(f, mapCmds, 'map'), 0);
  assert.ok(f.out.length > 0);
  assert.equal(sink.length, 1);
  const g = flowFixture();
  (g.ctx as { db: () => unknown }).db = () => ({ older: false, stale: false, all: () => [] });
  assert.equal(await run(g, mapCmds, 'map', [], { repo: 'web', verbose: true }), 0);
  assert.ok(g.out.length > 0);
});

test('map without a plan directory is a NO_PLANGRAPH error', async () => {
  const f = flowFixture();
  fs.rmSync((f.ctx as { dir: string }).dir, { recursive: true, force: true });
  assert.notEqual(await run(f, mapCmds, 'map'), 0);
});

// ---- trust
test('trust prints no target when the display pattern refuses what the trust list accepted (the two patterns are the same text, so the second test is forced to fail)', async () => {
  const root = tmp('plangraph-floor-trust-'), dir = path.join(root, '.plangraph'), cfg = tmp('plangraph-floor-trust-cfg-');
  fs.mkdirSync(dir);
  const out: string[] = [];
  const ctx = { root, dir, flags: {}, env: { XDG_CONFIG_HOME: cfg }, config: () => ({}), io: { out: (s: string) => out.push(s), err: () => undefined, raw: () => undefined, outBlock: () => undefined } };
  const realTest = RegExp.prototype.test;
  let seen = 0;
  RegExp.prototype.test = function (this: RegExp, s: string): boolean {
    if (this.source.startsWith('^[a-z][a-z0-9-]{0,23}:') && s === 'github:acme/web') { seen++; return seen === 1 ? realTest.call(this, s) : false; }
    return realTest.call(this, s);
  };
  try { assert.equal(await call(trustCmds, 'trust', ctx, {}, ['github:acme/web']), 0); } finally { RegExp.prototype.test = realTest; }
  assert.equal(seen, 2);
  assert.match(out[0] ?? '', /^trusted \(recorded in .+, outside the work tree\)$/);
  assert.doesNotMatch(out[0] ?? '', /github:acme\/web \(/);
});

// ---- uninstall
const TEMPLATES = path.resolve(import.meta.dirname, '../templates/githooks');
interface World { ctx: Record<string, unknown>; root: string; dir: string; out: string[] }
function uWorld(config: unknown = {}, stdin: object = { isTTY: false }): World {
  const root = tmp('plangraph-floor-uninstall-'), dir = path.join(root, '.plangraph');
  fs.mkdirSync(dir); fs.mkdirSync(path.join(root, '.git'));
  const out: string[] = [];
  return { root, dir, out, ctx: { root, dir, flags: {}, env: {}, stdin, config: () => config, io: { out: (s: string) => out.push(s), err: () => undefined } } };
}
const uninstall = (w: World, values: object = {}): Promise<number> => call(uninstallCmds, 'uninstall', w.ctx, values);
const rd = (...p: string[]): string => fs.readFileSync(path.join(...p), 'utf8');
const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

test('uninstall keeps CRLF line endings when it drops plangraph lines from a plan .gitignore, and deletes a file left with only blank lines', async () => {
  const w = uWorld();
  fs.writeFileSync(path.join(w.dir, '.gitignore'), 'cache/\r\nmine.txt\r\nplangraph.sqlite*\r\n');
  assert.equal(await uninstall(w), 0);
  assert.equal(rd(w.dir, '.gitignore'), 'mine.txt\r\n');
  assert.ok(w.out.includes('removed cache/, plangraph.sqlite* from .plangraph/.gitignore'));
  const v = uWorld();
  fs.writeFileSync(path.join(v.dir, '.gitignore'), 'cache/\n\n.txn/\n');
  await uninstall(v);
  assert.equal(fs.existsSync(path.join(v.dir, '.gitignore')), false);
});

test('uninstall without a terminal and without --yes keeps the derived files and says how to remove them', async () => {
  const w = uWorld();
  fs.mkdirSync(path.join(w.dir, 'cache')); fs.mkdirSync(path.join(w.dir, '.txn'));
  fs.writeFileSync(path.join(w.dir, 'plangraph.sqlite-wal'), 'x');
  assert.equal(await uninstall(w), 0);
  assert.ok(w.out.includes('kept cache/, plangraph.sqlite*, .txn/ in .plangraph (pass --yes to remove the local cache and the index)'));
  assert.ok(fs.existsSync(path.join(w.dir, 'cache')) && fs.existsSync(path.join(w.dir, 'plangraph.sqlite-wal')));
  assert.equal(w.out.at(-2)?.startsWith('kept nodes/ events/'), true);
  assert.equal(w.out.at(-1), 'to finish: claude plugin uninstall plangraph@plangraph-marketplace');
});

test('uninstall on a terminal asks once and removes only after a y, whichever way the answer is read', async () => {
  const cases: Array<[object, boolean]> = [
    [{ isTTY: true, readTty: () => ' Y\n' }, true],
    [{ isTTY: true, readTty: () => 'n' }, false],
    [{ isTTY: true, readLine: () => 'y' }, true],
    [{ isTTY: true, read: () => 'yes' }, false],
    [{ isTTY: true, read: () => 'y' }, true],
    [{ isTTY: true, readTty: () => { throw new Error('no terminal'); } }, false],
  ];
  for (const [stdin, removed] of cases) {
    const w = uWorld({}, stdin);
    fs.mkdirSync(path.join(w.dir, 'cache'));
    assert.equal(await uninstall(w), 0);
    assert.equal(fs.existsSync(path.join(w.dir, 'cache')), !removed, JSON.stringify(Object.keys(stdin)));
    assert.ok(w.out[0]?.startsWith('remove the local cache and the index?'));
    assert.equal(w.out.includes('removed .plangraph/cache'), removed);
  }
});

test('uninstall --yes removes the derived files without asking, including the index sidecars and the staging directory', async () => {
  const w = uWorld();
  fs.mkdirSync(path.join(w.dir, '.txn'));
  for (const n of ['plangraph.sqlite', 'plangraph.sqlite-journal', 'plangraph.sqlite-shm']) fs.writeFileSync(path.join(w.dir, n), 'x');
  assert.equal(await uninstall(w, { yes: true }), 0);
  assert.deepEqual(fs.readdirSync(w.dir), []);
  assert.ok(w.out.includes('removed .plangraph/plangraph.sqlite, .plangraph/.txn'));
});

test('uninstall removes the hooks that equal the template, keeps an edited one, removes the empty directory and notes a hooksPath that still points at it', async () => {
  const w = uWorld();
  const hooks = path.join(w.root, '.githooks'); fs.mkdirSync(hooks);
  fs.copyFileSync(path.join(TEMPLATES, 'post-commit'), path.join(hooks, 'post-commit'));
  fs.copyFileSync(path.join(TEMPLATES, 'pre-commit'), path.join(hooks, 'pre-commit'));
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho mine\n');
  fs.writeFileSync(path.join(w.root, '.git', 'config'), '[core]\n\thooksPath = .githooks\n');
  assert.equal(await uninstall(w), 0);
  assert.ok(w.out.includes('removed .githooks/post-commit'));
  assert.ok(w.out.includes('kept .githooks/pre-commit (it differs from the template: yours)'));
  assert.ok(w.out.some((l) => l.startsWith('note: git config core.hooksPath still points at .githooks')));
  assert.ok(fs.existsSync(path.join(hooks, 'pre-commit')) && !fs.existsSync(path.join(hooks, 'post-commit')));
  const v = uWorld();
  fs.mkdirSync(path.join(v.root, '.githooks'));
  fs.copyFileSync(path.join(TEMPLATES, 'post-merge'), path.join(v.root, '.githooks', 'post-merge'));
  await uninstall(v);
  assert.ok(v.out.includes('removed .githooks/ (empty)'));
  assert.equal(v.out.some((l) => l.startsWith('note:')), false);
});

test('the generated documents ignore line follows docs.out and docs.commit, and is kept while the directory is there', async () => {
  const cases: Array<[unknown, string | null]> = [
    [{}, '/docs/plangraph/'],
    [null, '/docs/plangraph/'],
    [{ docs: 'text' }, '/docs/plangraph/'],
    [{ docs: { out: 5 } }, '/docs/plangraph/'],
    [{ docs: { out: 'site/gen///' } }, '/site/gen/'],
    [{ docs: { commit: true, out: 'site/gen' } }, null],
    [{ docs: { out: '../up' } }, null],
    [{ docs: { out: '/abs' } }, null],
    [{ docs: { out: 'C:/x' } }, null],
    [{ docs: { out: '.' } }, null],
    [{ docs: { out: 'a\nb' } }, null],
  ];
  for (const [cfg, line] of cases) {
    const w = uWorld(cfg);
    fs.writeFileSync(path.join(w.root, '.gitignore'), `keep.log\n${line ?? '/docs/plangraph/'}\n`);
    assert.equal(await uninstall(w), 0, JSON.stringify(cfg));
    const left = rd(w.root, '.gitignore');
    if (line === null) { assert.match(left, /\/docs\/plangraph\/|keep\.log/); assert.equal(w.out.some((l) => l.includes('from .gitignore')), false); }
    else { assert.equal(left, 'keep.log\n'); assert.ok(w.out.includes(`removed ${line} from .gitignore`)); }
  }
  const w = uWorld({});
  fs.mkdirSync(path.join(w.root, 'docs/plangraph'), { recursive: true });
  fs.writeFileSync(path.join(w.root, '.gitignore'), '/docs/plangraph/\n');
  await uninstall(w);
  assert.equal(rd(w.root, '.gitignore'), '/docs/plangraph/\n');
  assert.ok(w.out.includes('kept /docs/plangraph/ in .gitignore (the generated documents are still there; delete docs/plangraph/ yourself)'));
});

test('uninstall: a failed removal is rethrown, not swallowed', { skip: !canChmod }, async () => {
  const w = uWorld();
  const hooks = path.join(w.root, '.githooks'); fs.mkdirSync(hooks);
  fs.copyFileSync(path.join(TEMPLATES, 'post-commit'), path.join(hooks, 'post-commit'));
  fs.chmodSync(hooks, 0o500);
  try { await assert.rejects(() => uninstall(w), (e: NodeJS.ErrnoException) => e.code === 'EACCES'); } finally { fs.chmodSync(hooks, 0o700); }
  const v = uWorld();
  fs.mkdirSync(path.join(v.dir, 'cache', 'sub'), { recursive: true }); fs.writeFileSync(path.join(v.dir, 'cache', 'sub', 'f'), 'x');
  fs.chmodSync(path.join(v.dir, 'cache', 'sub'), 0o500);
  try { await assert.rejects(() => uninstall(v, { yes: true }), (e: NodeJS.ErrnoException) => ['EACCES', 'EPERM', 'ENOTEMPTY'].includes(String(e.code))); } finally { fs.chmodSync(path.join(v.dir, 'cache', 'sub'), 0o700); }
});

test('uninstall: a plan .gitignore that cannot be rewritten in place is refused when it is a symlink', async () => {
  const w = uWorld();
  const target = path.join(w.root, 'elsewhere'); fs.writeFileSync(target, 'cache/\n');
  fs.symlinkSync(target, path.join(w.dir, '.gitignore'));
  await assert.rejects(() => uninstall(w), (e: Error) => /symlink/.test(e.message));
  assert.equal(rd(target), 'cache/\n');
});
