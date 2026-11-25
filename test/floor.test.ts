// The Node floor is one value (src/floor.js NODE_FLOOR) and every place that states it agrees: package.json engines, README,
// CONTRIBUTING, docs/CONTRACT.md, CHANGELOG, the `brain doctor` line, the src/db.ts ENV error and the bin/brain guard. The guard is run for
// real under a pretended old Node (process.versions overridden by an --import preload, since no old Node binary is assumed on the host).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NODE_FLOOR, nodeSupported, floorMessage, floorTry } from '../src/floor.js';
import { loadSqlite } from '../src/db.ts';
import type { BrainError } from '../src/errors.ts';

const root = path.join(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const esc = NODE_FLOOR.replace('.', '\\.');

test('the floor is 24.2 (node:sqlite and import.meta.main) and nodeSupported compares major.minor numerically', () => {
  assert.equal(NODE_FLOOR, '24.2');
  for (const v of ['24.2.0', 'v24.2.0', '24.18.0', '25.0.0', '100.1.1']) assert.equal(nodeSupported(v), true, v);
  for (const v of ['24.1.9', '24.0.0', '22.13.0', 'v18.0.0', '', 'garbage', '24', '2.40.0']) assert.equal(nodeSupported(v), false, v);
  assert.equal(nodeSupported(process.versions.node), true, 'the test host itself must meet the floor');
});

test('package.json, README, CONTRIBUTING, CONTRACT and CHANGELOG state the same floor', () => {
  assert.equal(JSON.parse(read('package.json')).engines.node, `>=${NODE_FLOOR}`);
  assert.match(read('README.md'), new RegExp(`Node ${esc} or newer`));
  assert.match(read('CONTRIBUTING.md'), new RegExp(`Node ${esc} or newer`));
  assert.match(read('docs/CONTRACT.md'), new RegExp(`Node >= ${esc}\\.`));
  assert.match(read('docs/CONTRACT.md'), new RegExp(`Node older than ${esc}`));
  assert.match(read('CHANGELOG.md'), new RegExp(`Node ${esc} is the floor`));
});

test('doctor, the index loader and the entry point take the floor from src/floor.js (no second copy of the number)', () => {
  const doctor = read('src/commands/plan.ts');
  assert.match(doctor, /too old \(needs >= \$\{NODE_FLOOR\}\)/);
  assert.match(doctor, /nodeSupported\(process\.versions\.node\)/);
  assert.match(read('bin/brain'), /import \{ nodeSupported, floorMessage, floorTry \} from '\.\.\/src\/floor\.js';/);
  assert.match(read('src/db.ts'), /nodeSupported\(version\)/);
  assert.throws(() => loadSqlite({ version: '24.1.0' }), (e: BrainError) => e.code === 'ENV' && e.exitCode === 3 && e.message === floorMessage('24.1.0'));
  assert.equal(floorMessage('22.12.0'), `brain needs Node >= ${NODE_FLOOR} (found 22.12.0); it uses node:sqlite and current ES features`);
  for (const f of ['src/cli.ts', 'src/db.ts', 'src/commands/plan.ts', 'bin/brain']) assert.ok(!/>=\s*24(?!\.2)\b|Node 24(?!\.2)\b/.test(read(f)), `${f} states another floor`);
});

test('floorTry is a plain-text try line naming the floor', () => {
  assert.equal(floorTry, `try: install Node ${NODE_FLOOR} or newer`);
});

test('bin/brain on a pretended old Node: exit 3 with one line; silent exit 0 with --if-present (the session hook)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-floor-'));
  try {
    const old = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"24.1.0"});Object.defineProperty(process,"version",{value:"v24.1.0"})';
    const run = (...a: string[]) => spawnSync(process.execPath, ['--import', old, path.join(root, 'bin/brain'), ...a], { cwd, encoding: 'utf8', env: { ...process.env, PLANGRAPH_DIR: '' } });
    let r = run('ticket', 'T-1');
    assert.equal(r.status, 3); assert.equal(r.stdout, ''); assert.equal(r.stderr, `${floorMessage('v24.1.0')}\n${floorTry}\n`);
    assert.equal(r.stderr.split('\n').length, 3, 'message and try line only');
    // 40: the floor guard plus the private compile-cache setup, which must stay inline (plain JavaScript) so no .ts file loads before the cache
    assert.ok(read('bin/brain').split('\n').length <= 40, 'bin/brain stays a thin entry');
    r = run('card', '--if-present', '--heal');
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('src/floor.js is plain JavaScript: stripping types leaves it byte for byte unchanged (no annotation, no TypeScript-only syntax)', () => {
  // stripTypeScriptTypes prints an ExperimentalWarning, so it runs in a child with --no-warnings
  const code = "const { stripTypeScriptTypes } = await import('node:module'); const fs = await import('node:fs'); const src = fs.readFileSync(process.argv[1], 'utf8'); process.exit(stripTypeScriptTypes(src) === src ? 0 : 1);";
  const run = (file: string) => spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code, file], { encoding: 'utf8' });
  let r = run(path.join(root, 'src/floor.js'));
  assert.equal(r.status, 0, `src/floor.js changes when types are stripped: it contains TypeScript syntax\n${r.stderr}`);
  assert.equal(r.stderr, '');
  // the check itself bites: a file with an annotation differs after stripping
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-floor-ts-'));
  try {
    const typed = path.join(dir, 'typed.js');
    fs.writeFileSync(typed, 'export const f = (v: unknown): string => String(v);\n');
    r = run(typed);
    assert.equal(r.status, 1, 'an annotated file must fail the check');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
