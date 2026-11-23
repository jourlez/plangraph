// Native `claude plugin eval` case directories, generated from brain-eval-case/2 objects (one source of truth).
// Layout written under an eval dir (never the repository: callers pass a temp directory):
//   <evalDir>/<case id>/{prompt.md, case.yaml, scaffold.sh, overlay.json?, graders/<id>.md}
//   <evalDir>/fixtures/<size>/...          base fixtures, copied by the caller
// The format follows what Claude Code 2.1.329 accepts (verified by loading the cases in the real binary, test/evals-native.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomicSafe } from '../lib/fsafe.mjs';

// Bash is granted by the operator (--allow-tools) for both arms; the case lists the same patterns so the CLI's "cannot pass with the
// granted tools" check sees them. Edit and Write are never granted: a refused attempt still appears in the trace and fails the grader.
export const BASH_TOOLS = ['Bash(brain *)', 'Bash(jq *)', 'Bash(grep *)', 'Bash(rg *)', 'Bash(node *)', 'Bash(cat *)', 'Bash(ls *)', 'Bash(wc *)', 'Bash(head *)', 'Bash(git *)'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Skill'];
const yq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** @param {any} c @param {{ runs: number, brainDir?: string, rcDir?: string|null, nodeBin?: string }} o */
export function nativeFiles(c, { runs, brainDir = '.brain', rcDir = null, nodeBin = 'node' }) {
  const node = nodeBin === 'node' ? 'node' : shq(nodeBin);
  const f = new Map();
  const tools = [...READ_TOOLS, ...BASH_TOOLS];
  f.set(`${c.id}/prompt.md`, `---\nname: ${c.id}\ntags: [${c.tags.join(', ')}]\nruns: ${runs}\nmax_turns: ${c.limits.max_turns}\ntimeout_seconds: ${c.limits.timeout_s}\nallowed_tools: [${tools.map((t) => (/[ ()*]/.test(t) ? yq(t) : t)).join(', ')}]\n---\n\n${c.prompt}\n`);
  f.set(`${c.id}/case.yaml`, `schema_version: "1.1"\nname: ${c.id}\ncontext:\n  scaffold_script: scaffold.sh\n`);
  const ov = c.fixture.overlay.length > 0;
  if (ov) f.set(`${c.id}/overlay.json`, JSON.stringify(c.fixture.overlay) + '\n');
  const dir = rcDir || brainDir;
  const sh = ['#!/usr/bin/env bash', '# generated from a brain-eval-case/2 object; do not edit', 'set -euo pipefail',
    'case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'plugin_root="$(cd "$case_dir/../.." && pwd)"', `fx="$case_dir/../fixtures/${c.fixture.size}"`,
    'cp "$fx/plan.md" plan.md'];
  if (c.fixture.brain) {
    sh.push(`mkdir -p ${shq(dir)}`, `for f in "$fx"/*.jsonl "$fx"/config.json "$fx"/format.json; do cp "$f" ${shq(dir)}/; done`);
    if (rcDir) sh.push(`printf '%s\\n' ${shq(JSON.stringify({ dir: rcDir }))} > .brainrc`);
    if (ov) sh.push(`${node} "$plugin_root/evals/overlay.mjs" "$case_dir/overlay.json" ${shq(dir)} .`);
  }
  sh.push('git init -q', 'git -c user.name=eval -c user.email=eval@example.invalid add -A', 'git -c user.name=eval -c user.email=eval@example.invalid commit -qm fixture');
  if (c.fixture.brain) sh.push(`${node} "$plugin_root/bin/brain" build >/dev/null`);
  f.set(`${c.id}/scaffold.sh`, sh.join('\n') + '\n');
  for (const g of c.graders) {
    const y = ['type: ' + g.type];
    let body = '';
    if (g.type === 'regex') {
      if (typeof g.target === 'string') y.push('target: ' + g.target); else y.push('target:', '  source: file', '  path: ' + yq(g.target.file));
      y.push('pattern: ' + yq(g.pattern));
      if (g.flags) y.push('flags: ' + g.flags);
      if (g.match) y.push('match: ' + yq(g.match));
    } else if (g.type === 'tool_used') {
      y.push('tool: ' + g.tool);
      if (g.input_match !== undefined) y.push('input_match: ' + yq(g.input_match));
      if (g.min !== undefined) y.push('min: ' + g.min);
      if (g.max !== undefined) y.push('max: ' + g.max);
    } else if (g.type === 'file_exists') y.push('path: ' + yq(g.path), 'exists: ' + g.exists);
    else { if (g.focus) y.push('focus: ' + g.focus); body = g.criteria + '\n'; }
    y.push('weight: ' + g.weight, 'arm: ' + g.arm);
    f.set(`${c.id}/graders/${g.id}.md`, `---\n${y.join('\n')}\n---\n${body}`);
  }
  return f;
}

// Write every case directory under evalDir (confined to `root`). Returns the number of files written.
export function emitCases(cases, evalDir, { runs, root, brainDir, rcDir, nodeBin }) {
  let n = 0;
  for (const c of cases) for (const [p, text] of nativeFiles(c, { runs, brainDir, rcDir, nodeBin })) {
    const full = path.join(evalDir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    writeAtomicSafe(full, text, { root });
    if (p.endsWith('.sh')) fs.chmodSync(full, 0o755);
    n++;
  }
  return n;
}

// A private copy of the plugin (code, skills, hooks, manifest; no tests, docs, evals or git), so a run never writes into the repository.
// variant: 'full' | 'no-card' (SessionStart hook removed) | 'no-skills' (skills directory removed): the ablation conditions.
export const PLUGIN_PARTS = ['.claude-plugin', 'bin', 'lib', 'src', 'skills', 'hooks', 'mcp', 'workflows', 'solver', 'seed', 'package.json', 'README.md', 'LICENSE'];
export function copyPlugin(srcRoot, dest, { variant = 'full' } = {}) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const p of PLUGIN_PARTS) {
    const s = path.join(srcRoot, p);
    if (!fs.existsSync(s)) continue;
    if (variant === 'no-skills' && p === 'skills') continue;
    fs.cpSync(s, path.join(dest, p), { recursive: true, dereference: false, verbatimSymlinks: true, filter: (x) => !/(?:^|[/\\])(?:__pycache__|node_modules|\.venv)(?:[/\\]|$)|\.sqlite$/.test(x) });
  }
  if (variant === 'no-card' && fs.existsSync(path.join(dest, 'hooks', 'hooks.json'))) writeAtomicSafe(path.join(dest, 'hooks', 'hooks.json'), '{"hooks":{}}\n', { root: dest });
  fs.mkdirSync(path.join(dest, 'evals'), { recursive: true });
  for (const f of ['overlay.mjs']) fs.copyFileSync(path.join(srcRoot, 'evals', f), path.join(dest, 'evals', f));
  return dest;
}

// One runnable suite in `dest`: a plugin copy (or ablation variant) whose evals/ holds the fixtures and the case directories.
// fixtures: { [size]: { [file name]: text } } or { [size]: <directory to copy> }. Returns the plugin directory.
export function writeSuite(dest, { srcRoot, cases, fixtures, runs, brainDir = '.brain', rcDir = null, variant = 'full', root = dest }) {
  const plugin = copyPlugin(srcRoot, dest, { variant });
  for (const size of new Set(cases.map((c) => c.fixture.size))) {
    const to = path.join(plugin, 'evals', 'fixtures', size), src = fixtures[size];
    if (typeof src === 'string') fs.cpSync(src, to, { recursive: true });
    else { fs.mkdirSync(to, { recursive: true }); for (const [n, t] of Object.entries(src)) writeAtomicSafe(path.join(to, n), t, { root }); }
  }
  // the scaffold runs with the operator's minimal environment: pin the node that built the suite (same machine) instead of trusting PATH
  emitCases(cases, path.join(plugin, 'evals'), { runs, root, brainDir, rcDir, nodeBin: process.execPath });
  return plugin;
}
