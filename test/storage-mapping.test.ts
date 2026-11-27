// The existing kinds on the entity backend, through the commands: `check` merges the store and batch validators (one line per violation with file
// and line, exit 1 on an error), a damaged node file never takes a reader down and the card says so, schedule-load and export move
// schedules/CURRENT, an unchanged re-run of an ingest writes nothing, and two branches that close different open items merge clean with stock git.
// Real runs of bin/plangraph in mkdtemp git repos. NOT covered: the kind-by-kind mapping (test/entitystore.test.ts), command outputs (the goldens).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { writePlanDir, readTree } from './helpers/plan-dir.ts';
import { nodePath } from '../lib/store2/layout.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
function repo() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-map-'))); tmps.push(d);
  git(d, 'init', '-q', '-b', 'main');
  const env = { ...process.env, ...GIT_ENV, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: path.join(d, '.data') };
  const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: d, encoding: 'utf8', env });
  assert.equal(run('init').status, 0);
  const b = path.join(d, '.plangraph');
  writePlanDir(b, genPlan({ n: 12, people: 2, seed: 4 }));
  assert.equal(run('build').status, 0);
  for (const [k, o] of [['T-1', 'Ana'], ['T-2', 'Ben']]) assert.equal(run('open-items', '--register', k as string, 'gap', '--owner', o as string, '--due', '3', '--text', 'x', '--write').status, 0);
  return { d, b, run };
}
const damage = (b: string, id = 'x') => { const f = nodePath(b, 'ticket', id); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `id ${JSON.stringify(id)}\n<<<<<<< HEAD\nowner "a"\n=======\nowner "b"\n>>>>>>> topic\n`); return f; };

test('check: a clean store prints no store line and exits 0 (an unplaced-free plan)', () => {
  const { run } = repo();
  const r = run('check'); assert.doesNotMatch(r.stdout, /^(error|warning): [A-Z_]+ (nodes|events|runs|schedules)\//m);
});

test('check lists each store violation on one line with file and line, exits 1 on an error, and the json data carries them', () => {
  const { b, run } = repo();
  const f = damage(b);
  const r = run('check');
  assert.equal(r.status, 1, r.stdout);
  const rel = path.relative(b, f);
  assert.ok(r.stdout.split('\n').includes(`error: CONFLICT_MARKERS ${rel}:2: run plangraph resolve, then settle any scalar conflict by hand and run plangraph check`), r.stdout);
  const j = JSON.parse(run('check', '--json').stdout);
  assert.deepEqual(j.data.store, [`error: CONFLICT_MARKERS ${rel}:2: run plangraph resolve, then settle any scalar conflict by hand and run plangraph check`]);
  // a batch-file violation is merged into the same list; a warning (a non-canonical file) does not fail check
  fs.rmSync(f);
  const ev = path.join(b, 'events/2026-11'); fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'ana.aaaaaaaa.01.jsonl'), '{"at":"2026-11-01T00:00:00Z","seq":0,"task":"T-1","to":"doing","by":"ana"}\nnot json\n');
  const e = run('check'); assert.equal(e.status, 1); assert.match(e.stdout, /^error: BAD_LINE events\/2026-11\/ana\.aaaaaaaa\.01\.jsonl:2: /m);
  fs.rmSync(path.join(ev, 'ana.aaaaaaaa.01.jsonl'));
  const node = nodePath(b, 'ticket', 'T-1'), lines = fs.readFileSync(node, 'utf8').trim().split('\n');
  fs.writeFileSync(node, [lines[0], ...lines.slice(1).reverse()].join('\n') + '\n');
  const w = run('check'); assert.match(w.stdout, /^warning: NOT_CANONICAL /m); assert.equal(w.status, 0, w.stdout);
  assert.equal(run('fmt').status, 0); assert.doesNotMatch(run('check').stdout, /NOT_CANONICAL/);
});

test('a damaged node file never takes a reader down: the other nodes load, build exits 0, and the card says store: N problem files', () => {
  const { b, run } = repo();
  const clean = run('card').stdout;
  assert.doesNotMatch(clean, /^store: /m);
  damage(b, 'x'); damage(b, 'y');
  assert.equal(run('build').status, 0);
  for (const args of [['ticket', 'T-1'], ['blockers'], ['sprint', '1'], ['verify'], ['open-items'], ['whatif', 'T-2', '--sprint', '3']]) assert.ok([0, 1].includes(run(...args).status as number), args.join(' '));
  const card = run('card').stdout.trimEnd().split('\n');
  assert.ok(card.includes('store: 2 problem files (run plangraph check)'), card.join('\n'));
  assert.equal(run('card', '--line').status, 0);
  assert.match(run('doctor').stdout, /^warning: store: 2 problem files \(run plangraph check\)$/m);
  const json = JSON.parse(run('card', '--json').stdout);
  assert.ok(JSON.stringify(json).includes('store: 2 problem files'));
});

test('schedule-load then export writes a new schedule version file and moves CURRENT; the old version stays', () => {
  const { d, b, run } = repo();
  const cur = () => fs.readFileSync(path.join(b, 'schedules/CURRENT'), 'utf8').trim();
  const v0 = cur();
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify(genPlan({ n: 12, people: 2, seed: 4 }).schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint + 1 }))));
  assert.equal(run('schedule-load', 's.json', 'old').status, 0);
  assert.equal(cur(), v0, 'schedule-load changes the index only');
  assert.equal(run('export').status, 0);
  const v1 = cur();
  assert.notEqual(v1, v0);
  assert.deepEqual(fs.readdirSync(path.join(b, 'schedules')).filter((f) => f.endsWith('.jsonl')).sort(), [`${v0}.jsonl`, `${v1}.jsonl`].sort());
  assert.match(fs.readFileSync(path.join(b, 'schedules', `${v1}.jsonl`), 'utf8'), /"version":"old"/);
});

test('an unchanged re-run of an ingest writes nothing (the tree is byte and mtime identical)', () => {
  const { d, b, run } = repo();
  fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/p.md'), '# Plan\n\n### Task 1: first\nbuild a\n\n### Task 2: second\nbuild b using a\n');
  assert.equal(run('sp-ingest', 'docs/p.md', '--ledger', 'none').status, 0);
  const stamp = () => { const out: Record<string, string> = {}; for (const f of Object.keys(readTree(b))) out[f] = `${fs.statSync(path.join(b, f)).mtimeMs}`; return { text: readTree(b), mtimes: out }; };
  const a = stamp();
  assert.equal(run('sp-ingest', 'docs/p.md', '--ledger', 'none').status, 0);
  const c = stamp();
  assert.deepEqual(c.text, a.text);
  for (const [f, m] of Object.entries(a.mtimes)) if (f.startsWith('nodes/') || f.startsWith('schedules/')) assert.equal(c.mtimes[f], m, `${f} was rewritten`);
});

test('two branches that close different open items merge clean with stock git, and check passes', () => {
  const { d, b, run } = repo();
  git(d, 'add', '.plangraph/nodes', '.plangraph/schedules', '.plangraph/runs', '.plangraph/config.json', '.plangraph/format.json', '.plangraph/meta.jsonl', '.plangraph/.gitignore'); git(d, 'commit', '-qm', 'base'); // the plan files; OPEN-ITEMS.md is a rendered document, not merged by line
  git(d, 'checkout', '-q', '-b', 'one'); const c1 = run('open-items', '--close', 'T-1', 'gap', '--write'); assert.equal(c1.status, 0, c1.stderr); git(d, 'add', '.plangraph/nodes'); git(d, 'commit', '-qm', 'close one');
  git(d, 'checkout', '-q', 'main'); git(d, 'checkout', '-q', '-b', 'two'); const bd = run('build'); assert.equal(bd.status, 0, bd.stderr); const c2 = run('open-items', '--close', 'T-2', 'gap', '--write'); assert.equal(c2.status, 0, c2.stderr); git(d, 'add', '.plangraph/nodes'); git(d, 'commit', '-qm', 'close two');
  git(d, 'merge', '--no-edit', 'one');
  const items = run('open-items', '--json'); assert.equal(items.status, 0, `${items.stdout}|${items.stderr}`);
  assert.equal(run('build').status, 0);
  const status = fs.readFileSync(nodePath(b, 'openitem', 'T-1|gap'), 'utf8') + fs.readFileSync(nodePath(b, 'openitem', 'T-2|gap'), 'utf8');
  assert.equal((status.match(/status "done"/g) ?? []).length, 2);
  assert.doesNotMatch(run('check').stdout, /CONFLICT_MARKERS/);
  assert.equal(fs.existsSync(path.join(d, '.gitattributes')), false, 'no merge attribute anywhere');
});
