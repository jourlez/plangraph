// The generated native `claude plugin eval` case directories must load in the real CLI. The offline part checks the constraints we
// verified from the CLI (grader weight > 0, the {source: file, path} target shape, the scaffold pins node). The online part runs the
// real binary in an isolated HOME with no credential and --scaffold: every case is parsed up front (load errors and "cannot pass with
// the granted tools" warnings are printed before any run), the first case's scaffold runs, and the run stops at "Not logged in", so no
// paid call can happen. Skips when the binary is absent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeFiles, writeSuite, BASH_TOOLS } from '../evals/native.ts';
import { loadCases } from '../evals/run.ts';
import { validateCase } from '../evals/schema.ts';
import { sealedTmp } from './helpers/sealed-tmp.ts';

const root = path.resolve(import.meta.dirname, '..');
const cases = loadCases();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-native-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function findBinary() {
  const env = process.env.BRAIN_CLAUDE_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  let dirs = [];
  try { dirs = fs.readdirSync(ext).filter((d) => /^anthropic\.claude-code-[\d.]+-/.test(d)); } catch { return null; }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const d of dirs.reverse()) { const c = path.join(ext, d, 'resources', 'native-binary', 'claude'); if (fs.existsSync(c)) return c; }
  return null;
}

test('every emitted grader file has a plain integer weight >= 1, a known type and an arm; file targets use {source: file, path}', () => {
  let graders = 0, fileTargets = 0, judges = 0;
  for (const c of cases) for (const [p, text] of nativeFiles(c, { runs: 1 })) {
    if (!p.includes('/graders/')) continue;
    graders++;
    const w = /^weight: (.*)$/m.exec(text);
    assert.ok(w && /^[1-9]\d*$/.test(w[1]), `${p}: weight ${w?.[1]}`);
    assert.match(text, /^type: (?:regex|tool_used|file_exists|llm)$/m);
    assert.match(text, /^arm: (?:both|with-only)$/m);
    if (/^target:\n {2}source: file\n {2}path: '[^']+'$/m.test(text)) fileTargets++;
    if (/^type: llm$/m.test(text)) { judges++; assert.ok(text.split('---\n')[2].trim().length >= 20, 'an llm grader carries its rubric in the body'); }
  }
  assert.ok(graders >= cases.length * 3);
  assert.ok(fileTargets >= 3, 'file-content sentinels are emitted');
  assert.ok(judges >= 1 && judges <= 3, 'the llm judge is used sparingly');
});

test('validateCase rejects a grader weight below 1', () => {
  const c = structuredClone(cases[0]);
  assert.deepEqual(validateCase(c), []);
  c.graders[0].weight = 0;
  assert.ok(validateCase(c).some((m) => /weight/.test(m)));
});

test('sealedTmp removes a mode-000 work dir it created and never follows a symlink out of it', () => {
  const t = sealedTmp('brain-sealtest-'), outside = sealedTmp('brain-sealout-');
  try {
    const keep = path.join(outside.dir, 'keep.txt'); fs.writeFileSync(keep, 'x');
    const work = path.join(t.tmpdir, 'e-abc123'), sealed = path.join(work, 'sealed');
    fs.mkdirSync(path.join(sealed, 'deep'), { recursive: true }); fs.writeFileSync(path.join(sealed, 'deep', 'f'), 'y');
    fs.symlinkSync(outside.dir, path.join(work, 'link'));
    fs.chmodSync(path.join(sealed, 'deep'), 0o000); fs.chmodSync(sealed, 0o000); fs.chmodSync(work, 0o500);
    t.remove();
    assert.equal(fs.existsSync(t.dir), false);
    assert.equal(fs.readFileSync(keep, 'utf8'), 'x', 'the symlink target outside is untouched');
  } finally { outside.remove(); }
});

test('writeSuite pins the node that built the suite in every scaffold, and copies no tests, docs or git metadata into the plugin copy', () => {
  const fx = Object.fromEntries(['S', 'M', 'L'].map((z) => [z, path.join(root, 'evals', 'fixtures', z)]));
  const plugin = writeSuite(path.join(tmp, 'pin'), { srcRoot: root, cases: cases.slice(0, 3), fixtures: fx, runs: 1 });
  const sh = fs.readFileSync(path.join(plugin, 'evals', cases[0].id, 'scaffold.sh'), 'utf8');
  assert.ok(sh.includes(`'${process.execPath}' "$plugin_root/bin/brain" build`));
  for (const d of ['test', 'docs', '.git', '.superpowers', 'evals/cases']) assert.ok(!fs.existsSync(path.join(plugin, d)), d);
  for (const d of ['bin/brain', 'lib', 'skills', 'hooks', '.claude-plugin/plugin.json', 'evals/overlay.ts']) assert.ok(fs.existsSync(path.join(plugin, d)), d);
  const v = writeSuite(path.join(tmp, 'nocard'), { srcRoot: root, cases: cases.slice(0, 1), fixtures: fx, runs: 1, variant: 'no-card' });
  assert.equal(fs.readFileSync(path.join(v, 'hooks', 'hooks.json'), 'utf8'), '{"hooks":{}}\n');
  const s = writeSuite(path.join(tmp, 'noskills'), { srcRoot: root, cases: cases.slice(0, 1), fixtures: fx, runs: 1, variant: 'no-skills' });
  assert.ok(!fs.existsSync(path.join(s, 'skills')));
});

const bin = findBinary();
test('the real claude plugin eval loads every case, warns about none, runs the first scaffold and stops at the login check', { skip: bin ? false : 'no Claude Code binary (set BRAIN_CLAUDE_BIN to enable)' }, () => {
  const fx = Object.fromEntries(['S', 'M', 'L'].map((z) => [z, path.join(root, 'evals', 'fixtures', z)]));
  const plugin = writeSuite(path.join(tmp, 'suite'), { srcRoot: root, cases, fixtures: fx, runs: 1 });
  const home = path.join(tmp, 'home'); fs.mkdirSync(home);
  // env -i style: no API key, no token, isolated HOME and config dir => the first run stops at "Not logged in"
  // bin is null only when the test is skipped (see the skip option)
  const r = spawnSync(bin as string, ['plugin', 'eval', plugin, '--trust-plugin', '--no-publish', '--scaffold', '--runs', '1', '--allow-tools', ...BASH_TOOLS, '--output-dir', path.join(tmp, 'out')], { encoding: 'utf8', env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: '/usr/bin:/bin' }, timeout: 180000, cwd: tmp }); // bin is null only when the test is skipped
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // the CLI keeps (and seals) the sandbox of a failed run; remove the ones this test caused
  for (const m of out.matchAll(/kept temp \(run failed\): (\/\S+)/g)) { spawnSync('chmod', ['-R', 'u+rwx', m[1]]); fs.rmSync(m[1], { recursive: true, force: true }); }
  assert.ok(/Plugin under test: "plangraph"/.test(out), out.slice(0, 2000));
  assert.ok(!/invalid case|case\.yaml:|Couldn't load|unknown frontmatter/.test(out), `the CLI rejected a generated case:\n${out.slice(0, 3000)}`);
  assert.ok(!/cannot pass with the granted tools/.test(out), `a grader cannot pass with the granted tools:\n${out.slice(0, 3000)}`);
  assert.ok(!/scaffold failed/.test(out), `the generated scaffold failed inside the CLI:\n${out.slice(0, 3000)}`);
  assert.ok(/Ablation: 2 arms × \d+ cases/.test(out) && new RegExp(`× ${cases.length} cases`).test(out), 'every case was loaded');
  assert.ok(/Not logged in/.test(out), `expected the run to stop at the login check:\n${out.slice(0, 2000)}`);
  assert.ok(!/\$[1-9]\d*\.\d\d/.test(out.replace(/\$0\.00/g, '')), 'a cost was incurred');
});
