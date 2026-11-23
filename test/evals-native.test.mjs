// The generated native `claude plugin eval` case directories must load in the real CLI. The offline part checks the constraints we
// verified from the CLI (grader weight is a number > 0). The online part runs the real binary in an isolated HOME with no credential,
// so it stops at "Not logged in" AFTER loading the cases and can never make a paid call. Skips when the binary is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeFiles, loadCases } from '../evals/run.mjs';
import { validateCase } from '../evals/schema.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cases = loadCases();

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

test('every emitted grader file has a plain integer weight of at least 1 (the native schema rejects weight 0)', () => {
  let graders = 0;
  for (const c of cases) {
    for (const [p, text] of nativeFiles(c, 1)) {
      if (!p.includes('/graders/')) continue;
      graders++;
      const w = /^weight: (.*)$/m.exec(text);
      assert.ok(w && /^[1-9]\d*$/.test(w[1]), `${p}: weight ${w?.[1]}`);
    }
  }
  assert.ok(graders >= cases.length, 'no graders emitted');
});

test('validateCase rejects a grader weight below 1', () => {
  const c = structuredClone(cases[0]);
  assert.deepEqual(validateCase(c), []);
  c.graders[0].weight = 0;
  assert.ok(validateCase(c).some((m) => /weight/.test(m)));
});

const bin = findBinary();
test('the real claude plugin eval loads every emitted case and rejects none', { skip: bin ? false : 'no Claude Code binary (set BRAIN_CLAUDE_BIN to enable)' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-native-'));
  try {
    const plug = path.join(tmp, 'plugin'), home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(plug, '.claude-plugin'), { recursive: true }); fs.mkdirSync(home);
    fs.copyFileSync(path.join(root, '.claude-plugin/plugin.json'), path.join(plug, '.claude-plugin/plugin.json'));
    for (const c of cases) for (const [p, text] of nativeFiles(c, 1)) {
      const full = path.join(plug, 'evals', p);
      fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
    }
    // env -i style: no API key, no token, isolated HOME and config dir => the first run stops at "Not logged in"
    const r = spawnSync(bin, ['plugin', 'eval', plug, '--trust-plugin', '--no-publish', '--runs', '1', '--ablation', 'none', '--case', '*'], { encoding: 'utf8', env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: '/usr/bin:/bin' }, timeout: 120000, cwd: tmp });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.ok(/Plugin under test: "project-brain"/.test(out), out);
    assert.ok(!/invalid case|case\.yaml|prompt\.md|Couldn't load/.test(out), `the CLI rejected a generated case:\n${out}`);
    assert.ok(/Not logged in/.test(out), `expected the run to stop at the login check (no credential in the isolated HOME):\n${out}`);
    assert.ok(!/\$[1-9]\d*\.\d\d/.test(out.replace(/\$0\.00/g, '')), 'a cost was incurred');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
