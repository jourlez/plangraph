// The extensionless entry points are launchers: bin/plangraph and bin/plangraph-merge hold one import() each, and the logic lives in checked
// files (src/entry.js, src/merge-entry.js, src/merge-main.ts). The SessionStart hook runs src/entry.js, an extensioned file that loads as an
// ES module on every Node with ES modules. Also: the start-up cost stays proportional (a size ratio of the modules each path loads, never
// a clock), and workflows/audit.workflow.js parses as the body of an async function.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMerge } from '../src/merge-main.ts';
import { canonFile, schemaFor } from '../lib/store.ts';
import type { Rec } from '../lib/store.ts';
import { floorMessage, floorTry } from '../src/floor.js';

const root = path.join(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const readJsonc = (f: string) => JSON.parse(read(f).replace(/^\s*\/\/.*$/gm, '')) as { files: { includes: string[] }; entry: string[] }; // biome.json and knip.json: line comments only
const tmpDirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const pretend = (v: string) => `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${v}"});Object.defineProperty(process,"version",{value:"v${v}"})`;

test('bin/plangraph is the launcher: one import of src/entry.js whose catch sets exit code 5', () => {
  const lines = read('bin/plangraph').split('\n');
  assert.equal(lines.length, 4, 'three lines and a final newline');
  assert.equal(lines[0], '#!/usr/bin/env node');
  assert.equal(lines[1], '// plangraph: launcher only; the logic is in src/entry.js (linted and type-checked).');
  assert.match(lines[2] ?? '', /^import\('\.\.\/src\/entry\.js'\)\.catch\(.*process\.exitCode = 5;/);
  assert.equal(lines[3], '');
});

test('bin/plangraph-merge is the launcher: one import of src/merge-entry.js', () => {
  const lines = read('bin/plangraph-merge').split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '#!/usr/bin/env node');
  assert.equal(lines[1], '// plangraph-merge: launcher only; the logic is in src/merge-main.ts.');
  assert.match(lines[2] ?? '', /^import\('\.\.\/src\/merge-entry\.js'\)/);
});

test('the launcher turns a failed load into exit code 5 with one stderr line', () => {
  const dir = tmp('plangraph-launch-');
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  fs.copyFileSync(path.join(root, 'bin/plangraph'), path.join(dir, 'bin/plangraph'));
  fs.writeFileSync(path.join(dir, 'src/entry.js'), "throw new Error('boom');\n");
  const r = spawnSync(process.execPath, [path.join(dir, 'bin/plangraph')], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [5, '', 'plangraph: boom\n']);
});

test('the SessionStart hook runs src/entry.js, not bin/plangraph', () => {
  const hook = JSON.parse(read('hooks/hooks.json')).hooks.SessionStart[0].hooks[0];
  assert.equal(hook.command, 'node');
  assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/src/entry.js', 'card', '--if-present', '--heal']);
});

test('workflows/audit.workflow.js parses as the body of an async function', () => {
  const src = read('workflows/audit.workflow.js');
  const body = src.replace(/^export const meta/m, 'const meta');
  assert.notEqual(body, src, 'exactly one leading `export const meta` is replaced');
  assert.equal((src.match(/^export const meta/gm) ?? []).length, 1);
  const dir = tmp('plangraph-wf-'), file = path.join(dir, 'workflow.mjs');
  fs.writeFileSync(file, `async function workflow(phase, pipeline, agent) {\n${body}\n}\nexport { workflow };\n`);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('biome and tsc cover src/entry.js and src/merge-entry.js, and keep the workflow out', () => {
  const biome = readJsonc('biome.json').files.includes;
  const tsc = JSON.parse(read('tsconfig.json')).include as string[];
  assert.ok(biome.includes('src/**/*.js'), 'biome.json files.includes covers src/**/*.js (floor.js, entry.js, merge-entry.js)');
  for (const f of ['src/entry.js', 'src/merge-entry.js', 'src/floor.js']) assert.ok(tsc.includes(f), `tsconfig.json include lists ${f}`);
  for (const list of [biome, tsc]) assert.ok(!list.some((g) => g.startsWith('workflows') || g === '**/*.js'), 'the workflow stays out (top-level return, runtime globals)');
  const knip = readJsonc('knip.json').entry;
  for (const f of ['src/entry.js', 'src/merge-entry.js']) assert.ok(knip.includes(f), `knip entry ${f}`);
});

test('plangraph-merge on a pretended Node 20 exits 2 with the floor message', () => {
  const r = spawnSync(process.execPath, ['--import', pretend('20.11.0'), path.join(root, 'bin/plangraph-merge'), 'a', 'b', 'c'], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `${floorMessage('v20.11.0')}\n${floorTry}\n`]);
});

test('src/entry.js card --if-present --heal on a pretended Node 20 exits 0, prints the one floor line and writes nothing', () => {
  const cwd = tmp('plangraph-hook20-');
  const r = spawnSync(process.execPath, ['--import', pretend('20.11.0'), path.join(root, 'src/entry.js'), 'card', '--if-present', '--heal'], { cwd, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '' } });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'plangraph: needs Node >= 24.15, found v20.11.0; install Node 24\n', '']);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('runMerge returns 0, 1 and 2 for a clean merge, a conflict and an unreadable input', () => {
  const dir = tmp('plangraph-runmerge-');
  const w = (n: string, rows: Rec[]) => { const f = path.join(dir, n); fs.writeFileSync(f, canonFile(rows, schemaFor('tickets.jsonl'))); return f; };
  const row = (key: string, sp: number): Rec => ({ key, summary: `s-${key}`, epic: 'E', sp, v2_owner: 'Ana', v2_sprint: 1 });
  const err: string[] = [], io = { err: (l: string) => { err.push(l); } };
  const base = w('base.jsonl', [row('A', 1)]);
  const same = w('ours.jsonl', [row('A', 1), row('B', 1)]);
  assert.equal(runMerge([base, same, base, 'tickets.jsonl'], io), 0, err.join('\n'));
  assert.deepEqual(err, []);
  const ours = w('o2.jsonl', [row('A', 4)]), theirs = w('t2.jsonl', [row('A', 3)]);
  assert.equal(runMerge([base, ours, theirs, 'tickets.jsonl'], io), 1);
  assert.match(err.join('\n'), /plangraph-merge: 1 conflict\(s\) in tickets\.jsonl/);
  err.length = 0;
  assert.equal(runMerge([base, path.join(dir, 'missing.jsonl'), base], io), 2);
  assert.match(err.join('\n'), /^plangraph-merge: /);
  err.length = 0;
  assert.equal(runMerge([base], io), 2);
  assert.deepEqual(err, ['usage: plangraph-merge BASE OURS THEIRS [PATH]']);
});

test('start-up loads a small fraction of the code a command loads: size ratio of the modules each path loads, no clock', () => {
  // module.registerHooks in a preload records every file the loader reads; the ratio compares bytes, which do not vary with load or machine
  const dir = tmp('plangraph-ratio-'), log = path.join(dir, 'loaded.txt'), pre = path.join(dir, 'pre.mjs');
  fs.writeFileSync(pre, `import { registerHooks } from 'node:module'; import fs from 'node:fs'; import { fileURLToPath } from 'node:url';\nregisterHooks({ load(url, ctx, next) { const r = next(url, ctx); if (url.startsWith('file:')) fs.appendFileSync(${JSON.stringify(log)}, fileURLToPath(url) + '\\n'); return r; } });\n`);
  const loadedBytes = (preloadNode: string | null, args: string[]) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync(process.execPath, ['--import', pre, ...(preloadNode ? ['--import', pretend(preloadNode)] : []), path.join(root, 'src/entry.js'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '', CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), NODE_COMPILE_CACHE: dir } });
    assert.notEqual(r.status, null, r.stderr);
    const files = new Set(fs.readFileSync(log, 'utf8').split('\n').filter((f) => f.startsWith(root)));
    return { files, bytes: [...files].reduce((n, f) => n + fs.statSync(f).size, 0) };
  };
  const floorOnly = loadedBytes('20.11.0', ['card', '--if-present']);
  assert.deepEqual([...floorOnly.files].map((f) => path.relative(root, f)).sort(), ['src/entry.js', 'src/floor.js'], 'below the floor only the two plain files load');
  const full = loadedBytes(null, ['explain']);
  assert.ok(full.files.size > 20, `the full path loads the command tree (${full.files.size} files)`);
  assert.ok(floorOnly.bytes * 20 < full.bytes, `floor path ${floorOnly.bytes} bytes vs full ${full.bytes}: must be under 5%`);
});

test('src/entry.js statically imports only src/floor.js (everything heavy loads after the floor check and the compile cache)', () => {
  const statics = [...read('src/entry.js').matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(statics, ['./floor.js']);
  assert.ok(read('src/entry.js').indexOf("await import('./cli.ts')") > read('src/entry.js').indexOf('enableCompileCache(dir)'), 'the compile cache is on before the first .ts import');
});
