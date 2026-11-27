// `docs list|check` (read-only) and `docs-build` (writer) called through their `commands` export with a minimal fake ctx and a real temp repository.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands as readCmds } from '../src/commands/docs.ts';
import { commands as writeCmds } from '../src/commands/docs-build.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

type Rows = { tickets: object[] };
function fixture(config: Record<string, unknown> = {}, tickets: object[] = [{ key: 'A-1', impl_status: 'todo', epic: 'E-1', sp: 3 }, { key: 'A-2', impl_status: 'done', epic: 'E-1', sp: 2 }]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-docscmd-'))); tmps.push(root);
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  const rows: Rows = { tickets };
  const out: string[] = [], err: string[] = [];
  const ctx = { root, dir, flags: {}, env: {}, now: () => new Date('2026-11-26T00:00:00Z'), config: () => config,
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(s), outBlock: (l: string[]) => out.push(...l), data: (d: unknown) => out.push(JSON.stringify(d)) },
    db: () => ({ older: false, stale: false, all: (sql: string) => (/FROM ticket/.test(sql) ? rows.tickets : []) }) } as never;
  return { ctx, root, rows, out, err };
}
type Cmds = Record<string, { run: (c: never, a: never) => unknown; writes?: string; guard?: unknown }>;
const call = (cmds: unknown, name: string, ctx: never, positionals: string[] = [], values: object = {}) => (cmds as Cmds)[name]!.run(ctx, { values, positionals } as never);
const read = (root: string, p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('commands are declared: docs read-only, docs-build a strict text writer', () => {
  assert.equal((readCmds as Cmds).docs?.writes, 'none');
  assert.equal((writeCmds as Cmds)['docs-build']?.writes, 'text');
  assert.equal((writeCmds as Cmds)['docs-build']?.guard, 'strict');
});

test('docs-build then docs check exits 0 and prints one line per generator', async () => {
  const f = fixture();
  assert.equal(await call(writeCmds, 'docs-build', f.ctx), 0);
  assert.ok(fs.existsSync(path.join(f.root, 'docs/plangraph/roadmap.md')));
  f.out.length = 0;
  assert.equal(await call(readCmds, 'docs', f.ctx, ['check']), 0);
  assert.ok(f.out.includes('roadmap fresh'), f.out.join('\n'));
  assert.equal(new Set(f.out.map((l) => l.split(' ')[0])).size, f.out.length, 'one line per generator');
});

test('docs list prints each document path and generator', async () => {
  const f = fixture();
  assert.equal(await call(readCmds, 'docs', f.ctx, ['list']), 0);
  assert.ok(f.out.includes('docs/plangraph/roadmap.md roadmap'), f.out.join('\n'));
});

test('docs check before any build exits 1 with missing', async () => {
  const f = fixture();
  assert.equal(await call(readCmds, 'docs', f.ctx, ['check']), 1);
  assert.ok(f.out.includes('roadmap missing'));
});

test('a stale ticket status makes the dependent generators stale and exit 1; rtm stays fresh', async () => {
  const f = fixture();
  await call(writeCmds, 'docs-build', f.ctx);
  f.rows.tickets = [{ key: 'A-1', impl_status: 'done', epic: 'E-1', sp: 3 }, { key: 'A-2', impl_status: 'done', epic: 'E-1', sp: 2 }];
  f.out.length = 0;
  assert.equal(await call(readCmds, 'docs', f.ctx, ['check']), 1);
  assert.ok(f.out.includes('roadmap stale'), f.out.join('|'));
  assert.ok(f.out.includes('rtm fresh'));
  assert.equal(await call(writeCmds, 'docs-build', f.ctx), 0);
  f.out.length = 0;
  assert.equal(await call(readCmds, 'docs', f.ctx, ['check']), 0);
});

test('a hand edit inside a region is refused and the file unchanged; --force overwrites', async () => {
  const f = fixture();
  await call(writeCmds, 'docs-build', f.ctx);
  const p = 'docs/plangraph/roadmap.md';
  fs.writeFileSync(path.join(f.root, p), read(f.root, p).replace('Tickets: 2', 'Tickets: HAND'));
  const edited = read(f.root, p);
  f.rows.tickets = [{ key: 'A-1', impl_status: 'done', epic: 'E-1', sp: 3 }];
  const code = await call(writeCmds, 'docs-build', f.ctx);
  assert.equal(code, 1);
  assert.equal(read(f.root, p), edited);
  assert.ok(f.out.concat(f.err).some((l) => l.includes('REGION_EDITED') && l.includes(p)));
  assert.equal(await call(writeCmds, 'docs-build', f.ctx, [], { force: true }), 0);
  assert.doesNotMatch(read(f.root, p), /HAND/);
});

test('ID arguments build only those generators; an unknown id exits 2', async () => {
  const f = fixture();
  assert.equal(await call(writeCmds, 'docs-build', f.ctx, ['roadmap']), 0);
  assert.ok(fs.existsSync(path.join(f.root, 'docs/plangraph/roadmap.md')));
  assert.ok(!fs.existsSync(path.join(f.root, 'docs/plangraph/status.md')));
  const g = fixture();
  assert.throws(() => call(writeCmds, 'docs-build', g.ctx, ['nope']), (e: Error & { exitCode?: number }) => e.exitCode === 2 && /unknown generator/.test(e.message));
});

test('an out directory outside the repository root exits 2 and writes nothing', async () => {
  for (const out of ['../escape', '/tmp/escape', 'a/../../x']) {
    const f = fixture({ docs: { out } });
    assert.equal(await call(writeCmds, 'docs-build', f.ctx), 2, out);
    assert.equal(f.err.length, 1);
    assert.ok(!fs.existsSync(path.join(f.root, '..', 'escape')));
    assert.equal(await call(readCmds, 'docs', f.ctx, ['check']), 2, out);
  }
});

test('an out directory that is a symlink leaving the repository exits 2', async () => {
  const f = fixture();
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-docsaway-')); tmps.push(away);
  fs.mkdirSync(path.join(f.root, 'docs'));
  fs.symlinkSync(away, path.join(f.root, 'docs/plangraph'));
  assert.equal(await call(writeCmds, 'docs-build', f.ctx), 2);
  assert.deepEqual(fs.readdirSync(away), []);
});

test('a D24 violation exits 2 with one line and writes nothing', async () => {
  const f = fixture({}, [{ key: 'https://evil.example/x', impl_status: 'todo' }, { key: 'A-2', impl_status: 'todo' }]);
  assert.equal(await call(writeCmds, 'docs-build', f.ctx), 2);
  assert.ok(f.err.length >= 1 && f.err.every((l) => l.includes('D24_VIOLATION')), f.err.join('\n'));
  assert.ok(!f.err.join('\n').includes('evil.example'), 'the offending value is never repeated');
  assert.ok(!fs.existsSync(path.join(f.root, 'docs')));
});

test('a data class violation exits 2 and writes nothing', async () => {
  // a person name used as a ticket id is printed by the roadmap id column and is a known name
  const f = fixture({}, [{ key: 'Alice', impl_status: 'todo', v2_owner: 'Alice' }]);
  const code = await call(writeCmds, 'docs-build', f.ctx);
  assert.equal(code, 2);
  assert.ok(f.err.every((l) => l.includes('DATA_CLASS_VIOLATION')), f.err.join('\n'));
  assert.ok(!fs.existsSync(path.join(f.root, 'docs')));
});

test('--commit-ready writes to docs.commit_out (default docs/generated) and leaves docs.out alone', async () => {
  const f = fixture();
  assert.equal(await call(writeCmds, 'docs-build', f.ctx, [], { 'commit-ready': true }), 0);
  assert.ok(fs.existsSync(path.join(f.root, 'docs/generated/roadmap.md')));
  assert.ok(!fs.existsSync(path.join(f.root, 'docs/plangraph')));
  const g = fixture({ docs: { commit_out: 'out/ci' } });
  assert.equal(await call(writeCmds, 'docs-build', g.ctx, [], { 'commit-ready': true }), 0);
  assert.ok(fs.existsSync(path.join(g.root, 'out/ci/roadmap.md')));
});

test('docs export prints blocks and --json the neutral document; unknown id exits 2', async () => {
  const f = fixture();
  assert.equal(await call(readCmds, 'docs', f.ctx, ['export', 'roadmap'], { json: true }), 0);
  const d = JSON.parse(f.out[0]!);
  assert.equal(d.id, 'roadmap');
  assert.equal(d.source, 'docs/plangraph/roadmap.md');
  const g = fixture();
  assert.equal(await call(readCmds, 'docs', g.ctx, ['export', 'roadmap']), 0);
  assert.ok(g.out.length > 0);
  const h = fixture();
  assert.equal(await call(readCmds, 'docs', h.ctx, ['export', 'nope']), 2);
});

test('docs without a subcommand is a usage error', () => {
  const f = fixture();
  assert.throws(() => call(readCmds, 'docs', f.ctx, []), /subcommand/);
});
