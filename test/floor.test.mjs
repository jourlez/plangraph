// The Node floor is one value (src/floor.mjs NODE_FLOOR) and every place that states it agrees: package.json engines, README,
// CONTRIBUTING, docs/CONTRACT.md, CHANGELOG, the `brain doctor` line, the src/db.mjs ENV error and the bin/brain guard. The guard is run for
// real under a pretended old Node (process.versions overridden by an --import preload, since no old Node binary is assumed on the host).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NODE_FLOOR, nodeSupported, floorMessage, floorTry } from '../src/floor.mjs';
import { loadSqlite } from '../src/db.mjs';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
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

test('doctor, the index loader and the entry point take the floor from src/floor.mjs (no second copy of the number)', () => {
  const doctor = read('src/commands/plan.mjs');
  assert.match(doctor, /too old \(needs >= \$\{NODE_FLOOR\}\)/);
  assert.match(doctor, /nodeSupported\(process\.versions\.node\)/);
  assert.match(read('bin/brain'), /import \{ nodeSupported, floorMessage, floorTry \} from '\.\.\/src\/floor\.mjs';/);
  assert.match(read('src/db.mjs'), /nodeSupported\(version\)/);
  assert.throws(() => loadSqlite({ version: '24.1.0' }), (/** @type {any} */ e) => e.code === 'ENV' && e.exitCode === 3 && e.message === floorMessage('24.1.0'));
  assert.equal(floorMessage('22.12.0'), `brain needs Node >= ${NODE_FLOOR} (found 22.12.0); it uses node:sqlite and current ES features`);
  for (const f of ['src/cli.mjs', 'src/db.mjs', 'src/commands/plan.mjs', 'bin/brain']) assert.ok(!/>=\s*24(?!\.2)\b|Node 24(?!\.2)\b/.test(read(f)), `${f} states another floor`);
});

test('floorTry is a plain-text try line naming the floor', () => {
  assert.equal(floorTry, `try: install Node ${NODE_FLOOR} or newer`);
});

test('bin/brain on a pretended old Node: exit 3 with one line; silent exit 0 with --if-present (the session hook)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-floor-'));
  try {
    const old = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"24.1.0"});Object.defineProperty(process,"version",{value:"v24.1.0"})';
    const run = (...a) => spawnSync(process.execPath, ['--import', old, path.join(root, 'bin/brain'), ...a], { cwd, encoding: 'utf8', env: { ...process.env, BRAIN_DIR: '' } });
    let r = run('ticket', 'T-1');
    assert.equal(r.status, 3); assert.equal(r.stdout, ''); assert.equal(r.stderr, `${floorMessage('v24.1.0')}\n${floorTry}\n`);
    assert.equal(r.stderr.split('\n').length, 3, 'message and try line only');
    assert.ok(read('bin/brain').split('\n').length <= 20, 'bin/brain stays a thin entry');
    r = run('card', '--if-present', '--heal');
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
