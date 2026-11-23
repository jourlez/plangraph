// Runs the real Claude Code plugin validator on this repo when its binary is present. Fails on any ERROR and on any warning
// that is not in the documented list below. Skips cleanly when the binary is absent (CI without Claude Code, other machines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sealedTmp } from './helpers/sealed-tmp.ts';

const root = path.resolve(import.meta.dirname, '..');
// Warnings we accept, each with the reason. Anything else fails this test.
const ALLOWED_WARNINGS: Array<{ id: string }> = [];

function findBinary(): string | null {
  const env = process.env.BRAIN_CLAUDE_BIN;
  if (env) return fs.existsSync(env) ? env : null;
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(ext).filter((d) => /^anthropic\.claude-code-[\d.]+-/.test(d)); } catch { return null; }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const d of dirs.reverse()) { const c = path.join(ext, d, 'resources', 'native-binary', 'claude'); if (fs.existsSync(c)) return c; }
  return null;
}

const bin = findBinary();
test('claude plugin validate reports no error and only documented warnings', { skip: bin ? false : 'no Claude Code binary (set BRAIN_CLAUDE_BIN to enable)' }, () => {
  // the binary's temp dir (TMPDIR) is inside our own temp dir, so whatever it leaves there (mode-000 dirs included) is removed with it
  const t = sealedTmp('brain-validate-'), home = path.join(t.dir, 'home');
  fs.mkdirSync(home);
  try {
    const r = spawnSync(bin as string, ['plugin', 'validate', root], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: home, TMPDIR: t.tmpdir, CLAUDE_CODE_TMPDIR: t.tmpdir }, timeout: 60000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0, `validator exited ${r.status}:\n${out}`);
    assert.ok(/Validation passed/.test(out), out);
    assert.ok(!/✘|\bERROR\b|Validation failed/.test(out), `validator reported an error:\n${out}`);
    // marketplace/manifest warnings are never allowed; directory-check warnings only from the list
    assert.ok(!/No marketplace description|Hosts not declared/.test(out), `manifest warning came back:\n${out}`);
    const warned = [...out.matchAll(/\(([A-Z][A-Z0-9_]+)\)/g)].map((m) => m[1]);
    for (const id of warned) assert.ok(ALLOWED_WARNINGS.some((a) => a.id === id), `undocumented validator warning ${id}:\n${out}`);
    const header = /Found (\d+) (?:plugin directory )?warning/g; let total = 0, m: RegExpExecArray | null;
    while ((m = header.exec(out))) total += Number(m[1]);
    assert.ok(total <= ALLOWED_WARNINGS.length, `${total} warnings but only ${ALLOWED_WARNINGS.length} are documented:\n${out}`);
  } finally { t.remove(); }
  assert.equal(fs.existsSync(t.dir), false, 'nothing left behind');
});

test('the declared network hosts match what lib/jira.ts can reach', () => {
  const man = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  // jira: lib/jira.ts. solver first run: pypi.org (index) and files.pythonhosted.org (files) for uv and the pip fallback (bin/brain-solve.lock,
  // solver/solver-requirements.txt); github.com and release-assets.githubusercontent.com only when uv must download a Python (python-build-standalone,
  // docs/SOLVER.md "What the first run downloads").
  const hosts = ['api.atlassian.com', '*.atlassian.net', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'release-assets.githubusercontent.com'];
  assert.deepEqual(man.network?.hosts, hosts);
  const solver = fs.readFileSync(path.join(root, 'docs/SOLVER.md'), 'utf8');
  for (const h of hosts.slice(2)) assert.ok(solver.includes(h), `docs/SOLVER.md does not explain ${h}`);
  assert.ok(fs.readFileSync(path.join(root, 'bin/brain-solve.lock'), 'utf8').includes('registry = "https://pypi.org/simple"'), 'the lock no longer points at pypi.org: update network.hosts');
  assert.ok(!/--index-url|--extra-index-url|-i https?:/.test(fs.readFileSync(path.join(root, 'bin/brain-solve-run'), 'utf8')), 'the launcher names another package index: update network.hosts');
  const jira = fs.readFileSync(path.join(root, 'lib/jira.ts'), 'utf8');
  assert.ok(jira.includes("host === 'api.atlassian.com'") && /atlassian\\\.net\$\//.test(jira), 'jira.ts host rules changed: update network.hosts');
  const mk = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.ok(typeof mk.description === 'string' && mk.description.length > 20, 'marketplace needs a description');
});

test('the hash-pinned requirements file lives outside bin/ and is the one the launcher reads', () => {
  assert.ok(fs.existsSync(path.join(root, 'solver/solver-requirements.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'bin/solver-requirements.txt')));
  assert.ok(fs.readFileSync(path.join(root, 'bin/brain-solve-run'), 'utf8').includes('../solver/solver-requirements.txt'));
});
