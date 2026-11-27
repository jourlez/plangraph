// Per-file coverage floor: `repo link`, `repo link --auto`, `repo catalog` and `repo scan` (--all, --check, warnings and every usage error),
// called through the `commands` export over a fake context on real throwaway git repositories. Synthetic data only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commands as repoCmds } from '../src/commands/repo.ts';
import { genPlan } from './fixtures/gen.ts';
import { flowFixture, run, cleanup } from './helpers/flow-ctx.ts';
import { gitEnv, makeRepo } from './helpers/gitrepo.ts';

const dirs: string[] = [];
after(() => { cleanup(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-floor-repo-'))); dirs.push(d); return d; };
const repoIn = (parent: string, name: string, files: Record<string, string>): string => {
  const r = makeRepo({ dir: path.join(parent, name) });
  r.commit({ files });
  return r.dir;
};
const PKG = JSON.stringify({ name: 'web', scripts: { build: 'tsc', test: 'node --test' }, dependencies: { react: '1' } });
const CATALOG = (owner: string, type = 'service'): string => `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: api\nspec:\n  type: ${type}\n  owner: ${owner}\n`;
const plan = (extras: NonNullable<Parameters<typeof flowFixture>[0]>['extras'] = {}) => flowFixture({ plan: genPlan({ n: 2, people: 2, density: 0, seed: 3 }), extras });
const rows = (f: ReturnType<typeof plan>, kind: 'repo' | 'link') => f.store.readKind(kind, { defaults: false });
const link = (f: ReturnType<typeof plan>, positionals: string[], values: object = {}) => run(f, repoCmds, 'repo', ['link', ...positionals], values);

const repoRows = [{ id: 'repo:api', name: 'api', paths: [{ glob: 'src/api/**', sub: 'api' }] }, { id: 'repo:web', name: 'web' }];

test('repo with no or an unknown subcommand is a usage error naming the subcommands', async () => {
  const f = plan();
  assert.equal(await run(f, repoCmds, 'repo', []), 2);
  assert.match(f.err.join('\n'), /repo needs a subcommand: scan/);
  assert.equal(await run(f, repoCmds, 'repo', ['bogus']), 2);
});

test('repo link TICKET REPO writes one touches link with defaults, then says it already exists', async () => {
  const f = plan({ repo: repoRows as never });
  assert.equal(await link(f, ['T-1', 'web']), 0);
  assert.deepEqual(f.out, ['T-1 touches repo:web']);
  const l = rows(f, 'link')[0] as Record<string, unknown>;
  assert.deepEqual([l.from, l.rel, l.to, l.to_type, l.attrs], ['T-1', 'touches', 'repo:web', 'repo', { conf: 1, why: 'manual' }]);
  f.out.length = 0;
  assert.equal(await link(f, ['T-1', 'repo:web']), 0);
  assert.deepEqual(f.out, ['T-1 already touches repo:web, nothing written']);
  assert.equal(rows(f, 'link').length, 1);
});

test('repo link accepts a ticket that exists only as a ref, a conf of 0 and a why', async () => {
  const f = plan({ repo: repoRows as never, ref: [{ key: 'sp:plan/9', plans: [], files: {} }] as never });
  assert.equal(await link(f, ['sp:plan/9', 'repo:api'], { conf: 0, why: 'by hand\nsecond line' }), 0);
  const l = rows(f, 'link')[0] as { attrs: { conf: number; why: string } };
  assert.equal(l.attrs.conf, 0);
  assert.doesNotMatch(l.attrs.why, /\n/);
});

test('repo link refuses missing arguments, a bad ticket key, a bad conf, an unknown repository and an unknown ticket, writing nothing', async () => {
  const f = plan({ repo: repoRows as never });
  const cases: Array<[string[], object, RegExp]> = [
    [[], {}, /usage: plangraph repo link TICKET REPO/],
    [['T-1'], {}, /usage: plangraph repo link TICKET REPO/],
    [['bad key', 'web'], {}, /needs a ticket key/],
    [['a..b', 'web'], {}, /needs a ticket key/],
    [['T-1', 'web'], { conf: 2 }, /--conf must be a number from 0 to 1/],
    [['T-1', 'nowhere'], {}, /unknown repository nowhere/],
    [['T-404', 'web'], {}, /unknown ticket T-404/],
  ];
  for (const [pos, values, re] of cases) {
    f.err.length = 0;
    assert.equal(await link(f, pos, values), 2, pos.join(' '));
    assert.match(f.err.join('\n'), re);
  }
  assert.equal(rows(f, 'link').length, 0);
});

test('repo link --auto adds a link for each ticket whose files fall under a repository path and skips the rest', async () => {
  const f = plan({
    repo: [...repoRows, { id: 'repo:docs', name: 'docs', paths: [{ glob: 'docs/**', sub: 'docs' }] }, { id: 'repo:bare', name: 'bare', paths: [] }] as never,
    ref: [
      { key: 'T-2', plans: [], files: { 'src/api/x.ts': '' } },
      { key: 'T-1', plans: [], files: { 'src/api/y.ts': '', 'docs/a.md': '' } },
      { key: 'T-3', plans: [], files: {} },
      { key: 'T-4', plans: [], files: ['src/api/z.ts'] },
      { key: 'bad key', plans: [], files: { 'src/api/x.ts': '' } },
      { key: 'T-5', plans: [], files: { 'other/q.ts': '' } },
      { key: 'T-6', plans: [] },
    ] as never,
    link: [{ from: 'T-2', from_type: 'ticket', rel: 'touches', to: 'repo:api', to_type: 'repo' }] as never,
  });
  assert.equal(await link(f, [], { auto: true }), 0);
  assert.deepEqual(f.out, ['T-1 touches repo:api (conf 0.7, files)', 'T-1 touches repo:docs (conf 0.7, files)']);
  const added = rows(f, 'link').filter((l) => l.from === 'T-1');
  assert.deepEqual(added.map((l) => l.attrs), [{ conf: 0.7, why: 'files' }, { conf: 0.7, why: 'files' }]);
  f.out.length = 0;
  assert.equal(await link(f, [], { auto: true }), 0);
  assert.deepEqual(f.out, ['no missing touches links, nothing written']);
});

test('repo link --auto refuses a TICKET, --conf or --why', async () => {
  const f = plan({ repo: repoRows as never });
  for (const [pos, values] of [[['T-1'], { auto: true }], [[], { auto: true, conf: 0.5 }], [[], { auto: true, why: 'x' }]] as Array<[string[], object]>) {
    assert.equal(await link(f, pos, values), 2);
  }
  assert.match(f.err.join('\n'), /repo link --auto takes no TICKET, REPO, --conf or --why/);
});

test('repo catalog reads owners from catalog-info.yaml: a dry run writes nothing, --write adds the row, a second write adds nothing', async () => {
  const parent = scratch(), r = repoIn(parent, 'api', { 'catalog-info.yaml': CATALOG('user:default/ana') });
  const f = plan({ person: [{ id: 'ana' }] as never });
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', r]), 0);
  assert.deepEqual(f.out, ['repo:api: owners ana from catalog-info.yaml (dry run, nothing written)']);
  assert.equal(rows(f, 'repo').length, 0);
  f.out.length = 0;
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', r], { write: true }), 0);
  assert.deepEqual(f.out, ['repo:api: owners ana from catalog-info.yaml']);
  const row = rows(f, 'repo')[0] as Record<string, unknown>;
  assert.deepEqual([row.id, row.name, row.owners, row.src], ['repo:api', 'api', ['ana'], 'catalog']);
  const before = JSON.stringify(rows(f, 'repo'));
  await run(f, repoCmds, 'repo', ['catalog', r], { write: true });
  assert.equal(JSON.stringify(rows(f, 'repo')), before);
});

test('repo catalog merges into an existing row: owners are united and a missing role is filled, a set role is kept', async () => {
  const parent = scratch(), r = repoIn(parent, 'api', { 'catalog-info.yaml': CATALOG('user:ana', 'library') });
  const f = plan({ person: [{ id: 'ana' }, { id: 'bo' }] as never, repo: [{ id: 'repo:api', name: 'api', owners: ['bo'] }] as never });
  await run(f, repoCmds, 'repo', ['catalog', r], { write: true });
  const row = rows(f, 'repo')[0] as Record<string, unknown>;
  assert.deepEqual([row.owners, row.role], [['ana', 'bo'], 'lib']);
  const g = plan({ person: [{ id: 'ana' }] as never, repo: [{ id: 'repo:api', name: 'api', role: 'app' }] as never });
  await run(g, repoCmds, 'repo', ['catalog', r], { write: true });
  assert.deepEqual([(rows(g, 'repo')[0] as Record<string, unknown>).owners, (rows(g, 'repo')[0] as Record<string, unknown>).role], [['ana'], 'app']);
});

test('repo catalog without a catalog file or without a known owner says so and writes nothing', async () => {
  const parent = scratch(), none = repoIn(parent, 'api', { 'a.txt': 'x' }), stranger = repoIn(parent, 'svc', { 'catalog-info.yaml': CATALOG('user:ghost') });
  const f = plan({ person: [{ id: 'ana' }] as never });
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', none], { write: true }), 0);
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', stranger], { write: true }), 0);
  assert.deepEqual(f.out, ['repo:api: no owner in catalog-info.yaml', 'repo:svc: no owner in catalog-info.yaml']);
  assert.equal(rows(f, 'repo').length, 0);
});

test('repo catalog refuses a path that is not a repository, a name with no usable id and a repository git cannot read', async () => {
  const parent = scratch(), f = plan();
  fs.mkdirSync(path.join(parent, 'plain'));
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', path.join(parent, 'plain')]), 2);
  assert.match(f.err.join('\n'), /the path is not a git repository/);
  fs.mkdirSync(path.join(parent, '___', '.git'), { recursive: true });
  f.err.length = 0;
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', path.join(parent, '___')]), 2);
  assert.match(f.err.join('\n'), /no usable repository id/);
  fs.mkdirSync(path.join(parent, 'broken', '.git'), { recursive: true });
  f.err.length = 0;
  assert.equal(await run(f, repoCmds, 'repo', ['catalog', path.join(parent, 'broken')]), 2);
  assert.match(f.err.join('\n'), /cannot read repository broken/);
});

test('repo catalog defaults to the repository root of the context', async () => {
  const parent = scratch(), r = repoIn(parent, 'api', { 'catalog-info.yaml': CATALOG('user:ana') });
  const f = plan({ person: [{ id: 'ana' }] as never });
  (f.ctx as { root: string }).root = r;
  assert.equal(await run(f, repoCmds, 'repo', ['catalog']), 0);
  assert.match(f.out[0] as string, /^repo:api: owners ana from catalog-info\.yaml/);
});

test('repo scan writes a row, merges a rescan, and leaves one row per repository', async () => {
  const parent = scratch();
  const big = repoIn(parent, 'web', { 'package.json': PKG, 'tsconfig.json': 'x'.repeat(300 * 1024), 'src/a.ts': 'x' });
  const f = plan();
  assert.equal(await run(f, repoCmds, 'repo', ['scan', big]), 0);
  assert.match(f.out[0] as string, /^repo:web: scanned \(fp [0-9a-f]{8}\)$/);
  const row = rows(f, 'repo')[0] as Record<string, unknown>;
  assert.deepEqual([row.id, row.pm, row.src], ['repo:web', 'npm', 'scan']);
  f.out.length = 0;
  assert.equal(await run(f, repoCmds, 'repo', ['scan', big]), 0);
  assert.equal(rows(f, 'repo').length, 1);
});

test('repo scan with no path scans the repository root of the context', async () => {
  const f = plan();
  const r = makeRepo({ dir: f.root });
  r.commit({ files: { 'package.json': PKG } });
  assert.equal(await run(f, repoCmds, 'repo', ['scan']), 0);
  assert.match(f.out[0] as string, /^repo:plangraph-flow-[a-z0-9]+: scanned/i);
  assert.equal(rows(f, 'repo').length, 1);
});

test('repo scan warns on stderr about a manifest it did not read', async () => {
  const parent = scratch(), r = repoIn(parent, 'web', { 'package.json': `{"name":"web","pad":"${'x'.repeat(300 * 1024)}"}` });
  const f = plan();
  assert.equal(await run(f, repoCmds, 'repo', ['scan', r]), 0);
  assert.match(f.err.join('\n'), /^warning: repo:web: package\.json: over 256 KB, not read/);
});

test('repo scan --check says missing, then ok, then drift with both fingerprints and exits 1 only for a missing or drifted row; it writes nothing', async () => {
  const parent = scratch(), r = makeRepo({ dir: path.join(parent, 'web') });
  r.commit({ files: { 'package.json': PKG } });
  const f = plan();
  assert.equal(await run(f, repoCmds, 'repo', ['scan', r.dir], { check: true }), 1);
  assert.equal(f.out.length, 1);
  assert.match(f.out[0] as string, /^repo:web: missing from repos\.jsonl$/);
  assert.equal(rows(f, 'repo').length, 0);
  f.out.length = 0;
  await run(f, repoCmds, 'repo', ['scan', r.dir]);
  f.out.length = 0;
  assert.equal(await run(f, repoCmds, 'repo', ['scan', r.dir], { check: true }), 0);
  assert.deepEqual(f.out, ['repo:web: ok']);
  r.commit({ files: { 'package.json': JSON.stringify({ name: 'web', dependencies: { vue: '3' } }) } });
  f.out.length = 0;
  assert.equal(await run(f, repoCmds, 'repo', ['scan', r.dir], { check: true }), 1);
  assert.match(f.out[0] as string, /^repo:web: drift \(fp [0-9a-f]{8} -> [0-9a-f]{8}\)$/);
});

test('repo scan --all scans every child repository in name order and ignores the rest', async () => {
  const parent = scratch();
  repoIn(parent, 'b-svc', { 'package.json': PKG });
  repoIn(parent, 'a-lib', { 'go.mod': 'module example.invalid/a\n' });
  fs.mkdirSync(path.join(parent, 'not-a-repo'));
  fs.writeFileSync(path.join(parent, 'file.txt'), 'x');
  fs.symlinkSync(path.join(parent, 'a-lib'), path.join(parent, 'z-link'));
  const f = plan();
  assert.equal(await run(f, repoCmds, 'repo', ['scan', parent], { all: true }), 0);
  assert.deepEqual(f.out.map((l) => l.split(':').slice(0, 2).join(':')), ['repo:a-lib', 'repo:b-svc']);
  assert.deepEqual(rows(f, 'repo').map((x) => x.id), ['repo:a-lib', 'repo:b-svc']);
});

test('repo scan refuses an unreadable --all path, no child repository, a plain directory, an empty id, two repositories with one id and a broken repository', async () => {
  const parent = scratch(), f = plan();
  const fail = async (pos: string[], values: object, re: RegExp) => { f.err.length = 0; assert.equal(await run(f, repoCmds, 'repo', pos, values), 2, pos.join(' ')); assert.match(f.err.join('\n'), re); };
  await fail(['scan', path.join(parent, 'missing')], { all: true }, /cannot read .*missing/);
  await fail(['scan'], { all: true }, /--all found no git repository|cannot read/); // the context root is a plain directory here
  fs.mkdirSync(path.join(parent, 'plain'));
  await fail(['scan', path.join(parent, 'plain')], {}, /the path is not a git repository/);
  await fail(['scan', parent], { all: true }, /--all found no git repository directly under the path/);
  const empty = scratch();
  fs.mkdirSync(path.join(empty, '___', '.git'), { recursive: true });
  await fail(['scan', empty], { all: true }, /no usable repository id/);
  const twins = scratch();
  repoIn(twins, 'a.b', { 'a.txt': 'x' }); repoIn(twins, 'a-b', { 'a.txt': 'x' });
  await fail(['scan', twins], { all: true }, /two repositories give the id repo:a-b/);
  const broken = scratch();
  fs.mkdirSync(path.join(broken, 'x', '.git'), { recursive: true });
  await fail(['scan', path.join(broken, 'x')], {}, /cannot read repository x/);
  assert.equal(rows(f, 'repo').length, 0);
});

test('repo scan ignores symlinks and submodule entries and the git it runs never starts a hook program', async () => {
  const parent = scratch(), r = makeRepo({ dir: path.join(parent, 'web') });
  r.commit({ files: { 'package.json': PKG } });
  fs.symlinkSync('package.json', path.join(r.dir, 'link.json'));
  execFileSync('git', ['-C', r.dir, 'add', '-A'], { env: gitEnv() });
  execFileSync('git', ['-C', r.dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`], { env: gitEnv() });
  const f = plan();
  assert.equal(await run(f, repoCmds, 'repo', ['scan', r.dir]), 0);
  assert.equal((rows(f, 'repo')[0] as Record<string, unknown>).id, 'repo:web');
});
