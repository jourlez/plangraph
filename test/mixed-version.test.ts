// A team where one person runs 0.3.0 and another this version. The frozen 0.3.0 runtime (test/fixtures/release-0.3.0, written by
// scripts/freeze-release.ts from the release commit) is run as a process: its merge driver, build, card and answers, against a plan directory
// that holds graph files. Pins what 0.3.0 does with node files it does not know (recorded limits, asserted) and what this version does about it.
// NOT covered: the index of graph data and the integrity checks that refuse a duplicate in `plangraph build` (later tasks), a format-2 directory.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as S from '../lib/store.ts';
import { readGraphFiles, parseGraphFile } from '../lib/graph/files.ts';
import { genPlan } from './fixtures/gen.ts';

const ROOT = path.join(import.meta.dirname, '..');
const FROZEN = path.join(import.meta.dirname, 'fixtures/release-0.3.0');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmps.push(d); return d; };
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const rowsOf = (text: string): object[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const set = (text: string): string[] => rowsOf(text).map((r) => S.canonLine(r as S.Rec)).sort();
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', PLANGRAPH_DIR: '' };
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8', env: GIT_ENV });
const must = (r: ReturnType<typeof git>, what: string) => { assert.equal(r.status, 0, `${what}: ${r.stderr}${r.stdout}`); return r.stdout; };

/** One file kind: the keyed rows of a base and what each side edits (different fields of one row). */
const KINDS: Record<string, { base: object; ours: object; theirs: object; merged: object }> = {
  'people.jsonl': { base: { id: 'Ana', name: 'Ana', active: true }, ours: { id: 'Ana', name: 'Ana Silva', active: true }, theirs: { id: 'Ana', name: 'Ana', active: false }, merged: { id: 'Ana', name: 'Ana Silva', active: false } },
  'sprints.jsonl': { base: { n: 3, name: 'S3' }, ours: { n: 3, name: 'Sprint 3' }, theirs: { n: 3, name: 'S3', state: 'closed' }, merged: { n: 3, name: 'Sprint 3', state: 'closed' } },
  'epics.jsonl': { base: { id: 'E-1', name: 'Export' }, ours: { id: 'E-1', name: 'Exports' }, theirs: { id: 'E-1', name: 'Export', zz: 1 }, merged: { id: 'E-1', name: 'Exports', zz: 1 } },
  'repos.jsonl': { base: { id: 'repo:web', role: 'app' }, ours: { id: 'repo:web', role: 'app', pm: 'npm' }, theirs: { id: 'repo:web', role: 'app', runtime: 'node' }, merged: { id: 'repo:web', role: 'app', pm: 'npm', runtime: 'node' } },
  'capacity.jsonl': { base: { person: 'Ana', sprint: 3, sp: 8 }, ours: { person: 'Ana', sprint: 3, sp: 6 }, theirs: { person: 'Ana', sprint: 3, sp: 8, review_h: 4 }, merged: { person: 'Ana', sprint: 3, sp: 6, review_h: 4 } },
  'xrefs.jsonl': { base: { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1' }, ours: { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1', seen: '2026-02-02' }, theirs: { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1', note: 'checked' }, merged: { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1', seen: '2026-02-02', note: 'checked' } },
};
const OTHER = (f: string): object => ({ 'people.jsonl': { id: 'Zed' }, 'sprints.jsonl': { n: 9 }, 'epics.jsonl': { id: 'E-9' }, 'repos.jsonl': { id: 'repo:z' }, 'capacity.jsonl': { person: 'Zed', sprint: 1, sp: 1 }, 'xrefs.jsonl': { type: 'ticket', id: 'T-9', sys: 'sp', xid: 'x' } } as Record<string, object>)[f] as object;

/** Runs a merge driver (a `plangraph-merge` script) the way git does, on three texts; returns exit status and the result text. */
function driver(bin: string, file: string, base: string, ours: string, theirs: string): { status: number | null; text: string; stderr: string } {
  const d = tmp('mv-drv-'); fs.writeFileSync(path.join(d, 'b'), base); fs.writeFileSync(path.join(d, 'o'), ours); fs.writeFileSync(path.join(d, 't'), theirs);
  const r = spawnSync(process.execPath, [bin, path.join(d, 'b'), path.join(d, 'o'), path.join(d, 't'), `.plangraph/${file}`], { encoding: 'utf8' });
  return { status: r.status, text: fs.readFileSync(path.join(d, 'o'), 'utf8'), stderr: r.stderr };
}
const OLD = path.join(FROZEN, 'bin/plangraph-merge'), NEW = path.join(ROOT, 'bin/plangraph-merge');

test('the frozen tree is the 0.3.0 runtime and says which tree it was cut from', () => {
  assert.match(fs.readFileSync(path.join(FROZEN, 'TREE'), 'utf8'), /^[0-9a-f]{40}\n$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(FROZEN, 'package.json'), 'utf8')).version, '0.3.0');
  for (const f of ['bin/plangraph', 'bin/plangraph-merge', 'src/entry.js', 'src/merge-main.ts', 'lib/store.ts', 'seed/learnings.seed.jsonl']) assert.ok(fs.existsSync(path.join(FROZEN, f)), f);
  assert.ok(!fs.existsSync(path.join(FROZEN, 'lib/graph')), 'it has no graph code');
});

test('0.3.0 keeps the same set of records of a node file when only one side edits it (record set, not bytes: it rewrites in its own order)', () => {
  for (const [f, k] of Object.entries(KINDS)) {
    const base = jl([k.base, OTHER(f)]), edited = jl([k.ours, OTHER(f)]);
    for (const [ours, theirs] of [[base, edited], [edited, base]] as const) {
      const r = driver(OLD, f, base, ours, theirs);
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
      assert.deepEqual(set(r.text), set(edited), `${f}: record set`);
    }
  }
});

test('parseGraphFile accepts a node file whose key and line order the 0.3.0 driver rewrote', () => {
  for (const [f, k] of Object.entries(KINDS)) {
    const r = driver(OLD, f, jl([k.base]), jl([k.ours, OTHER(f)]), jl([k.base]));
    assert.equal(r.status, 0);
    if (f === 'people.jsonl') assert.notEqual(r.text, S.canonText(r.text, S.SCHEMAS[f], f), 'the old driver writes sorted keys, which is not the canonical order of this file');
    assert.equal(parseGraphFile(f, r.text).length, rowsOf(r.text).length, f);
    assert.equal(readGraphFilesFrom(f, r.text).length, rowsOf(r.text).length);
  }
});
function readGraphFilesFrom(f: string, text: string): readonly unknown[] {
  const d = tmp('mv-rd-'); fs.writeFileSync(path.join(d, f), text);
  const g = readGraphFiles(d) as unknown as Record<string, readonly unknown[]>;
  return g[f.replace('.jsonl', '')] as readonly unknown[];
}

test('a two-sided edit of one row: 0.3.0 keeps two rows with that key (recorded limit), this version merges them into one, and its reader refuses the 0.3.0 result with DUPLICATE_NODE', () => {
  for (const [f, k] of Object.entries(KINDS)) {
    const [base, ours, theirs] = [jl([k.base]), jl([k.ours]), jl([k.theirs])];
    const old = driver(OLD, f, base, ours, theirs);
    assert.equal(old.status, 0, f);
    assert.equal(rowsOf(old.text).length, 2, `${f}: 0.3.0 merges an unknown file as a set of whole records: the base row goes, both edited rows stay`);
    assert.deepEqual(set(old.text), set(jl([k.ours, k.theirs])), f);
    const now = driver(NEW, f, base, ours, theirs);
    assert.deepEqual([now.status, now.text], [0, S.canonFile([k.merged as S.Rec], S.SCHEMAS[f])], `${f}: one row with both changes`);
    assert.deepEqual(parseGraphFile(f, now.text).length, 1);
    const e = (() => { try { parseGraphFile(f, old.text); return ''; } catch (x) { return (x as Error).message; } })();
    assert.match(e, new RegExp(`^DUPLICATE_NODE ${f.replace('.', '\\.')}:2: duplicate `), `${f}: the 0.3.0 result is refused, naming the file`);
    assert.match(e, /keep one row, then run plangraph build\)$/);
  }
});

test('a name on one side and active on the other, through git itself: 0.3.0 leaves two people rows, this version one', () => {
  for (const [bin, rows] of [[OLD, 2], [NEW, 1]] as const) {
    const d = tmp('mv-git-'), k = KINDS['people.jsonl'] as (typeof KINDS)[string];
    must(git(d, 'init', '-q', '-b', 'main'), 'init');
    fs.mkdirSync(path.join(d, '.plangraph'));
    fs.writeFileSync(path.join(d, '.gitattributes'), '.plangraph/*.jsonl merge=plangraph-jsonl\n');
    must(git(d, 'config', 'merge.plangraph-jsonl.driver', `${process.execPath} ${bin} %O %A %B %P`), 'driver');
    const file = path.join(d, '.plangraph/people.jsonl');
    fs.writeFileSync(file, jl([k.base])); must(git(d, 'add', '-A'), 'add'); must(git(d, 'commit', '-qm', 'base'), 'commit');
    must(git(d, 'checkout', '-qb', 'b'), 'branch'); fs.writeFileSync(file, jl([k.theirs])); must(git(d, 'commit', '-qam', 'theirs'), 'commit b');
    must(git(d, 'checkout', '-q', 'main'), 'back'); fs.writeFileSync(file, jl([k.ours])); must(git(d, 'commit', '-qam', 'ours'), 'commit a');
    const m = git(d, 'merge', '-q', 'b');
    assert.equal(m.status, 0, m.stderr + m.stdout);
    assert.equal(rowsOf(fs.readFileSync(file, 'utf8')).length, rows, bin === OLD ? 'frozen 0.3.0' : 'this version');
  }
});

test('a graph-file merge by this version is stable when run again on its own result (no churn between teammates)', () => {
  for (const [f, k] of Object.entries(KINDS)) {
    const once = driver(NEW, f, jl([k.base]), jl([k.ours]), jl([k.theirs])).text;
    assert.equal(driver(NEW, f, once, once, once).text, once, f);
    assert.equal(driver(NEW, f, once, jl([k.merged, OTHER(f)]), once).text, S.canonFile([k.merged as S.Rec, OTHER(f) as S.Rec], S.SCHEMAS[f]), f);
  }
});

// ---------- the frozen CLI and this version on one directory that holds graph files ----------
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const cli = (tree: string, cwd: string, args: string[]) => spawnSync(process.execPath, [path.join(tree, 'bin/plangraph'), ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });
const GRAPH_ROWS: Record<string, object[]> = {
  'people.jsonl': [{ id: 'Ana', name: 'Ana Silva', active: true }], 'sprints.jsonl': [{ n: 1, name: 'S1', start: '2026-01-05', end: '2026-01-16', state: 'open' }], 'epics.jsonl': [{ id: 'E0', name: 'Zero' }],
  'repos.jsonl': [{ id: 'repo:web', role: 'app', owners: ['ana'], paths: [{ glob: 'web/**', sub: 'web' }], src: 'manual' }], 'capacity.jsonl': [{ person: 'Ana', sprint: 1, sp: 5, review_h: 2 }],
  'links.jsonl': [{ from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'repo:web', to_type: 'repo', attrs: { conf: 'high', why: 'w' } }, { from: 'pr-1', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'T-1', to_type: 'ticket' }],
  'xrefs.jsonl': [{ type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1', seen: '2026-01-05' }, { type: 'ticket', id: 'T-2', sys: 'newtracker:eng', xid: 'ENG-2' }],
};

test('0.3.0 and this version give the same v1 answers on a directory that holds every graph file (and 0.3.0 builds it, exit 0)', () => {
  const d = tmp('mv-cli-'); execFileSync('git', ['init', '-q'], { cwd: d, env: GIT_ENV });
  assert.equal(cli(FROZEN, d, ['init']).status, 0);
  const p = genPlan({ n: 10, people: 2, seed: 8, cap: 20 }), b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule)); fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify(p.config));
  const probes = [['ticket', 'T-3'], ['ready', '--person', 'Ana'], ['check'], ['person', 'Ana'], ['sprint', '1']];
  const answers = (tree: string) => probes.map((a) => { const r = cli(tree, d, a); return [r.status, r.stdout, r.stderr]; });
  assert.equal(cli(FROZEN, d, ['build']).status, 0);
  const before = answers(FROZEN);
  assert.ok(before.every((x) => x[0] === 0 || x[0] === 1), JSON.stringify(before));
  for (const [f, rows] of Object.entries(GRAPH_ROWS)) fs.writeFileSync(path.join(b, f), jl(rows));
  const rebuilt = cli(FROZEN, d, ['build']);
  assert.equal(rebuilt.status, 0, `0.3.0 builds a directory with graph files: ${rebuilt.stderr}`);
  assert.deepEqual(answers(FROZEN), before, '0.3.0 ignores the graph files');
  assert.equal(cli(ROOT, d, ['build']).status, 0);
  assert.deepEqual(answers(ROOT), before, 'this version answers the same');
  assert.equal(cli(FROZEN, d, ['card', '--line']).stdout, cli(FROZEN, d, ['card', '--line']).stdout);
  // the reader of this version reads the same files without a complaint and counts the extensions
  const g = readGraphFiles(b);
  assert.deepEqual([g.people.length, g.sprints.length, g.epics.length, g.repos.length, g.capacity.length, g.links.length, g.xrefs.length], [1, 1, 1, 1, 1, 2, 2]);
  assert.equal(g.ext, 2, 'the x-github.pr link and the unknown sys');
  assert.deepEqual(g.warnings, []);
});
