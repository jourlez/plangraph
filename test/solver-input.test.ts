// The derived solver input: `plangraph build` and `export` write <plan dir>/cache/solver-input/ (v1-shaped canonical JSONL of tickets, edges, the
// current schedule, open items and sprints, plus a config.json copy; mode 0600, git-ignored), the bytes depend only on the plan's rows, and
// bin/plangraph-solve --jsonl-dir reads it (on the plan directory itself or on the solver-input directory). Real runs of bin/plangraph in
// mkdtemp repos; the Python part is skipped without python3 (stdlib only, as test/plangraph-solve-input.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { canonFile, SCHEMAS } from '../lib/store.ts';
import type { Schema } from '../lib/store.ts';
import { readStoreAt, kindFile } from '../lib/planstore.ts';
import { writePlanDir } from './helpers/plan-dir.ts';

const ROOT = path.join(import.meta.dirname, '..'), BRAIN = path.join(ROOT, 'bin/plangraph'), SOLVE = path.join(ROOT, 'bin/plangraph-solve');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const SKIP = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'skipped: no python3';
const FILES = { tickets: 'ticket', edges: 'edge', schedule: 'schedule', 'open-items': 'openitem', sprints: 'sprint' } as const;

function repo(seed = 3) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-sin-'))); tmps.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  const env = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', CLAUDE_PLUGIN_DATA: path.join(d, '.data') };
  const run = (...a: string[]) => spawnSync(process.execPath, [BRAIN, ...a], { cwd: d, encoding: 'utf8', env });
  assert.equal(run('init').status, 0);
  const b = path.join(d, '.plangraph');
  const p = genPlan({ n: 12, people: 2, seed });
  writePlanDir(b, p, { openitem: [{ key: 'T-1', kind: 'gap', status: 'open' }], sprint: [{ n: 1, state: 'closed' }, { n: 2 }] });
  const r = run('build'); assert.equal(r.status, 0, r.stderr);
  return { d, b, run, si: path.join(b, 'cache/solver-input'), plan: p };
}
const read = (dir: string, n: string) => fs.readFileSync(path.join(dir, `${n}.jsonl`), 'utf8');

test('build writes the v1-shaped canonical files of the plan, a config copy, mode 0600, and the cache is git-ignored', () => {
  const { d, b, si, plan } = repo();
  const store = readStoreAt(b);
  for (const [n, kind] of Object.entries(FILES)) assert.equal(read(si, n), canonFile(store.readKind(kind, { defaults: false }), SCHEMAS[kindFile(kind)] as Schema), n);
  assert.equal(read(si, 'tickets').split('\n').filter(Boolean).length, 12);
  assert.match(read(si, 'open-items'), /^\{"key":"T-1","kind":"gap","status":"open"\}\n$/);
  assert.match(read(si, 'sprints'), /"n":1,"state":"closed"/);
  assert.equal(fs.readFileSync(path.join(si, 'config.json'), 'utf8'), fs.readFileSync(path.join(b, 'config.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(si, 'config.json'), 'utf8')).end_sprint, plan.config.end_sprint);
  for (const f of [...Object.keys(FILES).map((n) => `${n}.jsonl`), 'config.json']) assert.equal(fs.statSync(path.join(si, f)).mode & 0o777, 0o600, f);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.plangraph/cache'], { cwd: d, encoding: 'utf8' }), '', 'cache/ is ignored by the plan directory .gitignore');
});

test('the same logical plan gives the same bytes, a changed plan rewrites only what changed, and export refreshes the input', () => {
  const a = repo(5), b = repo(5);
  for (const n of [...Object.keys(FILES), 'config']) assert.equal(fs.readFileSync(path.join(a.si, n === 'config' ? 'config.json' : `${n}.jsonl`), 'utf8'), fs.readFileSync(path.join(b.si, n === 'config' ? 'config.json' : `${n}.jsonl`), 'utf8'), n);
  const before = Object.fromEntries(fs.readdirSync(a.si).map((f) => [f, fs.statSync(path.join(a.si, f)).mtimeMs]));
  assert.equal(a.run('build').status, 0);
  for (const f of fs.readdirSync(a.si)) assert.equal(fs.statSync(path.join(a.si, f)).mtimeMs, before[f], `${f} is left alone when its bytes are unchanged`);
  fs.writeFileSync(path.join(a.d, 's.json'), JSON.stringify(a.plan.schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint + 1 }))));
  assert.equal(a.run('schedule-load', 's.json', 'old').status, 0);
  assert.equal(read(a.si, 'schedule').includes('"sprint":1,'), read(b.si, 'schedule').includes('"sprint":1,'), 'schedule-load changes the index only');
  assert.equal(a.run('export').status, 0);
  assert.notEqual(read(a.si, 'schedule'), read(b.si, 'schedule'), 'export wrote the loaded schedule: the solver input follows');
  assert.equal(a.run('build').status, 0);
  assert.match(read(a.si, 'schedule'), /"version":"old"/);
});

test('a config.json change reaches the solver input at the next build even when no data changed', () => {
  const { b, si, run } = repo();
  const cfg = JSON.parse(fs.readFileSync(path.join(b, 'config.json'), 'utf8')); cfg.end_sprint = 9;
  fs.writeFileSync(path.join(b, 'config.json'), `${JSON.stringify(cfg)}\n`);
  assert.equal(run('build').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(si, 'config.json'), 'utf8')).end_sprint, 9);
});

test('bin/plangraph-solve --jsonl-dir reads the solver input: on the plan directory and on the solver-input directory itself', { skip: SKIP }, () => {
  const { d, b, si } = repo();
  const HEAD = `import importlib.machinery, importlib.util, json, sys, types
loader = importlib.machinery.SourceFileLoader('s', sys.argv[1]); spec = importlib.util.spec_from_loader('s', loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
a = types.SimpleNamespace(jsonl_dir=sys.argv[2], config=None, db=None)
t, e, s, c = m.load_raw(a)
print(json.dumps({'tickets': [x['key'] for x in t], 'edges': len(e), 'versions': sorted(s), 'closed': c.get('_closed_sprints'), 'end': c.get('end_sprint')}))`;
  const load = (dir: string) => { const r = spawnSync('python3', ['-I', '-c', HEAD, SOLVE, dir], { cwd: d, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout) as { tickets: string[]; edges: number; versions: string[]; closed: number[]; end: number }; };
  const viaPlan = load(b), viaInput = load(si);
  assert.deepEqual(viaPlan, viaInput);
  assert.equal(viaPlan.tickets.length, 12); assert.deepEqual(viaPlan.closed, [1]); assert.deepEqual(viaPlan.versions, ['current']);
});
