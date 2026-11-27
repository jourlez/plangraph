// There is one storage backend and no merge driver: nothing under lib/, src/, bin/ or scripts/ mentions the removed machinery, init writes no
// .gitattributes and no git config, and the SessionStart command is valid and runs. Real runs of bin/plangraph and src/entry.js in mkdtemp repos.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sourceFilesIn } from './helpers/source-files.ts';

const ROOT = path.join(import.meta.dirname, '..');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const repo = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-nmd-'))); tmps.push(d); execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd: string, args: string[], entry = path.join(ROOT, 'bin/plangraph')) => spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });

test('no file under lib, src, bin or scripts mentions the merge driver or --heal, and the removed files are gone', () => {
  const REMOVED = ['merge=plangraph', 'plangraph-merge', 'installMergeDriver', '--heal', 'doctorMergeDriver', 'JsonlStore'];
  const files = [...sourceFilesIn(ROOT, ['lib', 'src', 'scripts', 'mcp']), ...fs.readdirSync(path.join(ROOT, 'bin')).map((f) => `bin/${f}`).filter((f) => fs.statSync(path.join(ROOT, f)).isFile())];
  const hits: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const w of REMOVED) if (text.includes(w)) hits.push(`${f}: ${w}`);
  }
  assert.deepEqual(hits, []);
  for (const f of ['lib/driver.ts', 'lib/merge.ts', 'src/merge-entry.js', 'src/merge-main.ts', 'bin/plangraph-merge']) assert.equal(fs.existsSync(path.join(ROOT, f)), false, f);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.bin), ['plangraph']);
});

test('init writes no .gitattributes and no git config, and stamps format 2 with the entity storage', () => {
  const d = repo(), cfg = fs.readFileSync(path.join(d, '.git/config'), 'utf8');
  const r = run(d, ['init']); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(d, '.gitattributes')), false);
  assert.equal(fs.readFileSync(path.join(d, '.git/config'), 'utf8'), cfg);
  assert.equal(fs.readFileSync(path.join(d, '.plangraph/format.json'), 'utf8'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
  assert.equal(fs.readFileSync(path.join(d, '.plangraph/.gitignore'), 'utf8'), 'cache/\nplangraph.sqlite*\n.txn/\n');
});

test('the SessionStart command in hooks/hooks.json is `card --if-present --refresh`, runs, and prints the card or nothing', () => {
  const hook = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0] as { command: string; args: string[] };
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/src/entry.js', 'card', '--if-present', '--refresh']);
  const args = hook.args.map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', ROOT));
  const d = repo();
  let r = spawnSync(hook.command, args, { cwd: d, encoding: 'utf8', env: ENV });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], 'no plangraph: silent');
  assert.equal(run(d, ['init']).status, 0);
  assert.equal(run(d, ['build']).status, 0);
  r = spawnSync(hook.command, args, { cwd: d, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(d, '.data') } });
  assert.equal(r.status, 0); assert.equal(r.stderr, ''); assert.match(r.stdout, /^plangraph [0-9a-f]{8} \| 0 tickets/);
});

test('card --refresh is accepted and changes nothing; --heal is an unknown option', () => {
  const d = repo(); assert.equal(run(d, ['init']).status, 0); assert.equal(run(d, ['build']).status, 0);
  const a = run(d, ['card']), b = run(d, ['card', '--refresh']);
  assert.deepEqual([b.status, b.stdout, b.stderr], [a.status, a.stdout, a.stderr]);
  const h = run(d, ['card', '--heal']);
  assert.equal(h.status, 2); assert.match(h.stderr, /unknown option --heal/);
});
