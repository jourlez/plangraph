// Coverage margin for identity, identity-map, flow-link and report: the refusals and fallbacks no other test reaches, over synthetic plans.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands as idCmds } from '../src/commands/identity.ts';
import { commands as idMapCmds } from '../src/commands/identity-map.ts';
import { commands as linkCmds } from '../src/commands/flow-link.ts';
import { commands as fmtCmds } from '../src/commands/fmt.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';
import { flowFixture, cleanup, run } from './helpers/flow-ctx.ts';
import { fixture as cliFixture, copy, state, made, run as cli } from './helpers/cli-fixture.ts';
import { PlangraphError } from '../src/errors.ts';

const tmps: string[] = [];
before(async () => { state.FIX = await cliFixture(); });
after(() => { cleanup(); for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function idWorld(rows: object[], older = false, people = '{"id":"sam1","name":"Sam One"}\n{"id":"sam2","name":"Sam Two"}\n{"id":"kai","name":"Kai Ren"}\n') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-margin-id-'))); tmps.push(root);
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'people.jsonl'), people);
  adoptPlanDir(dir);
  const out: string[] = [];
  const ctx = { root, dir, flags: {}, env: {}, io: { out: (s: string) => out.push(s), err: () => undefined, raw: (s: string) => out.push(s), outBlock: (l: string[]) => out.push(...l) },
    db: () => ({ older, all: () => rows }) } as never;
  return { ctx, out, dir };
}
const call = (cmds: Record<string, unknown>, name: string, ctx: never, positionals: string[], values: object = {}) => (cmds[name] as { run: (c: never, a: never) => unknown }).run(ctx, { values, positionals } as never);
const usage = (e: unknown) => e instanceof PlangraphError && e.exitCode === 2;

test('identity refuses an index built by an older plangraph', async () => {
  const w = idWorld([], true);
  await assert.rejects(async () => call(idCmds, 'identity', w.ctx, ['propose']), (e: unknown) => e instanceof PlangraphError && /older plangraph/.test(e.message));
});

test('identity propose skips rows it cannot read, names ambiguous assignees, ignores unmatched ones and caps the list at 200 lines', async () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ sys: 'jira:acme', fields: { assignee: `Sam ${i}` } }));
  const rows = [
    { sys: 'jira:acme', fields: '{not json' }, { sys: 'jira:acme', fields: '"text"' }, { sys: 'jira:acme', fields: JSON.stringify({ assignee: '  ' }) },
    { sys: 'jira:acme', fields: JSON.stringify({ assignee: 7 }) }, { sys: 'jira:acme', fields: JSON.stringify({ assignee: 'Zed Nobody' }) }, { sys: 'jira:acme', fields: JSON.stringify({ assignee: 'kai' }) },
    { sys: 'jira', fields: { assignee: 'Kai Ren' } }, { sys: 'gh', fields: { assignee: 'Kai Ren' } }, ...many,
  ];
  const w = idWorld(rows);
  assert.equal(await call(idCmds, 'identity', w.ctx, ['propose']), 0);
  assert.match(w.out[0] as string, /^3 proposed, 201 ambiguous$/);
  assert.ok(w.out.some((l) => /^jira:acme:Sam 0 ambiguous$/.test(l)));
  assert.ok(w.out.includes('truncated 4'), w.out.slice(-3).join('|'));
  assert.ok(!w.out.some((l) => l.includes('Zed Nobody')));
  const only = idWorld(rows);
  assert.equal(await call(idCmds, 'identity', only.ctx, ['propose'], { sys: 'jira' }), 0);
  assert.ok(!only.out.some((l) => /^gh:/.test(l)));
  const small = idWorld([{ sys: 'jira', fields: { assignee: 'Zed Nobody' } }]);
  await call(idCmds, 'identity', small.ctx, ['propose']);
  assert.deepEqual(small.out, ['0 proposed, 0 ambiguous']);
});

test('identity list says 0 mapped for an empty map and lists several entries in order', async () => {
  const w = idWorld([]);
  assert.equal(await call(idCmds, 'identity', w.ctx, ['list']), 0);
  assert.deepEqual(w.out, ['0 mapped']);
  assert.equal(await call(idMapCmds, 'identity-map', w.ctx, ['jira:b', 'kai']), 0);
  assert.equal(await call(idMapCmds, 'identity-map', w.ctx, ['jira:a', 'sam1']), 0);
  assert.equal(await call(idMapCmds, 'identity-map', w.ctx, ['jira:c', 'sam2']), 0);
  w.out.length = 0;
  await call(idCmds, 'identity', w.ctx, ['list']);
  const text = w.out.join('\n');
  assert.ok(text.startsWith('3 mapped'));
  assert.ok(text.indexOf('jira:a sam1') < text.indexOf('jira:b kai') && text.indexOf('jira:b kai') < text.indexOf('jira:c sam2'));
});

test('identity-map without a ref or a person is a usage error', async () => {
  const w = idWorld([]);
  for (const pos of [[], ['jira:a'], ['', 'sam1'], ['jira:a', '']]) await assert.rejects(async () => call(idMapCmds, 'identity-map', w.ctx, pos), usage);
  await assert.rejects(async () => call(idMapCmds, 'identity-map', w.ctx, ['jira:a', 'nobody']), (e: unknown) => usage(e) && /unknown person nobody/.test((e as Error).message));
  for (const pos of [[], ['other']]) await assert.rejects(async () => call(idCmds, 'identity', w.ctx, pos), (e: unknown) => usage(e) && /needs a subcommand/.test((e as Error).message));
  assert.equal(fs.existsSync(path.join(w.dir, 'cache/identities.json')), false);
});

test('flow-link refuses a bad SYS, a bad XID and an XID with two dots, and writes nothing', async () => {
  const f = flowFixture({ n: 3 });
  const before = fs.readdirSync(f.dir).sort();
  assert.equal(await run(f, linkCmds, 'flow-link', ['T-1', 'Jira', 'ABC-1']), 2);
  assert.match(f.err.at(-1) as string, /SYS must be/);
  assert.equal(await run(f, linkCmds, 'flow-link', ['T-1', 'jira', 'a b\u0001c']), 2);
  assert.match(f.err.at(-1) as string, /XID must be 1 to 200/);
  assert.equal(await run(f, linkCmds, 'flow-link', ['T-1', 'jira', '']), 2);
  assert.equal(await run(f, linkCmds, 'flow-link', ['T-1', 'jira', 'a..b']), 2);
  assert.match(f.err.at(-1) as string, /XID must be 1 to 200/);
  assert.equal(await run(f, linkCmds, 'flow-link', ['T-1', 'jira', 'x'.repeat(201)]), 2);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), before);
  const seen: unknown[] = [], g = { ...f, ctx: { ...(f.ctx as object), io: { ...(f.ctx as { io: object }).io, data: (d: unknown) => seen.push(d) } } as never };
  assert.equal(await run(g, linkCmds, 'flow-link', ['T-1', 'jira:acme/proj', 'ABC-1']), 0);
  assert.equal(await run(g, linkCmds, 'flow-link', ['T-1', 'jira:acme/proj', 'ABC-1']), 0);
  assert.deepEqual(seen.map((d) => (d as { written: boolean }).written), [true, false]);
  assert.deepEqual(f.out.slice(-2).map((l) => l.split(' ')[0]), ['linked', 'unchanged']);
});

test('report writes the files and says nothing about a forecast when the history cannot be read', async () => {
  const d = copy();
  fs.mkdirSync(path.join(d, '.plangraph', 'history.jsonl')); // not a regular file: reading it throws, the forecast tag falls back to "not computed"
  const r = await cli(d, ['report']);
  assert.equal(r.code, 0, r.err.join('|'));
  assert.match(r.out.join('\n'), /^wrote \.plangraph\/report\.md and \.plangraph\/report\.html /);
  assert.ok(fs.existsSync(path.join(d, '.plangraph', 'report.md')));
});

// ---- fmt
function nodeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.pg')) out.push(p); } };
  walk(path.join(dir, 'nodes'));
  return out.sort();
}
const crlf = (f: string): void => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n'));

test('fmt rewrites non-canonical files and says how many (one, several, over twenty), and says nothing to rewrite for a canonical store', async () => {
  const f = flowFixture({ n: 30 });
  const files = nodeFiles(f.dir);
  assert.ok(files.length > 25, `${files.length} node files`);
  assert.equal(await run(f, fmtCmds, 'fmt'), 0);
  assert.deepEqual(f.out, ['fmt: nothing to rewrite']);
  f.out.length = 0;
  crlf(files[0] as string);
  const seen: unknown[] = [];
  const g = { ...f, ctx: { ...(f.ctx as object), io: { ...(f.ctx as { io: object }).io, data: (d: unknown, o: unknown) => seen.push([d, o]) } } as never };
  assert.equal(await run(g, fmtCmds, 'fmt'), 0);
  assert.equal(f.out.length, 2);
  assert.match(f.out[0] as string, /^rewrote /);
  assert.equal(f.out[1], 'fmt: 1 file rewritten');
  assert.equal((seen[0] as [{ rewritten: number }, { next: string[] }])[0].rewritten, 1);
  assert.deepEqual((seen[0] as [unknown, { next: string[] }])[1].next, ['plangraph check']);
  f.out.length = 0;
  for (const file of files.slice(0, 3)) crlf(file);
  assert.equal(await run(f, fmtCmds, 'fmt'), 0);
  assert.equal(f.out.at(-1), 'fmt: 3 files rewritten');
  assert.ok(!f.out.some((l) => /more$/.test(l)));
  f.out.length = 0;
  for (const file of files.slice(0, 23)) crlf(file);
  assert.equal(await run(f, fmtCmds, 'fmt'), 0);
  assert.equal(f.out.filter((l) => l.startsWith('rewrote ')).length, 20);
  assert.ok(f.out.includes('... and 3 more'));
  assert.equal(f.out.at(-1), 'fmt: 23 files rewritten');
});

test('fmt without a plan directory is the usual no-plan error', async () => {
  const f = flowFixture({ n: 2 });
  fs.rmSync(f.dir, { recursive: true, force: true });
  assert.notEqual(await run(f, fmtCmds, 'fmt'), 0);
});
