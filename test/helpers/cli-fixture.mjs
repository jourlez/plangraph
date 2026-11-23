// Shared fixture and in-process runner for the CLI goldens (test/mutation-kills-cli*.test.mjs): a generated repository with a built brain,
// copies of it, a runner that calls src/cli.mjs main() with the fixture as the working directory, and a snapshot of changed text files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { main } from '../../src/cli.mjs';
import { genPlan } from '../fixtures/gen.mjs';
/** @type {string[]} */ export const made = [];
export const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clik-'))); made.push(d); return d; };
export const jl = (/** @type {object[]} */ rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
export const HOME = tmp();
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const ENV = { PATH: process.env.PATH, HOME, CLAUDE_PLUGIN_DATA: path.join(HOME, 'data'), BRAIN_DIR: '', SOURCE_DATE_EPOCH: '1795305600', LC_ALL: 'C', TZ: 'UTC', BRAIN_STRICT_OUT: '1', ...GIT_ENV };
export const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => execFileSync('git', a, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });

/** run one command in-process: exit code, stdout and stderr lines */
export async function run(/** @type {string} */ cwd, /** @type {string[]} */ argv, /** @type {Record<string, string>} */ env = {}) {
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ const err = [];
  const io = { out: (/** @type {string} */ s) => out.push(s), err: (/** @type {string} */ s) => err.push(s), raw: (/** @type {string} */ s) => out.push(...String(s).split('\n')) };
  let code;
  // like the real CLI, relative file arguments resolve against the process working directory: run from the fixture, then come back
  const prev = process.cwd();
  process.chdir(cwd);
  try { code = await main(argv, { io, env: { ...ENV, ...env }, cwd }); } catch (e) { code = `threw ${/** @type {Error} */ (e).message}`; } finally { process.chdir(prev); }
  // the host's node version and solver runtime (doctor) are not part of the behavior under test
  const scrub = (/** @type {string} */ s) => s.split(cwd).join('<repo>').split(HOME).join('<home>').replace(/clik-[A-Za-z0-9]+/g, 'clik-X').replace(/node v\d+\.\d+\.\d+/g, 'node vX').replace(/solver runtime: [^\n]*/g, 'solver runtime: X');
  return { code, out: out.map(scrub), err: err.map(scrub) };
}

export const state = { FIX: '' };
/** a git repository with an initialised brain over a generated plan, findings, open items, refs, a plan file and a superpowers plan */
export async function fixture() {
  const d = tmp();
  git(d, 'init', '-q'); git(d, 'checkout', '-q', '-b', 'main');
  const p = genPlan({ n: 14, people: 3, seed: 9, cap: 8 });
  p.tickets[0].verdict = 'BLOCKED'; p.tickets[2].jira_status = 'Done';
  fs.mkdirSync(path.join(d, 'docs/superpowers/plans'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/plan.md'), '# Plan\n\n### Task 1: first\nbuild a\n\n### Task 2: second\nbuild b using a\n');
  fs.writeFileSync(path.join(d, 'docs/superpowers/plans/2026-01-01-widget.md'), '# Widget Plan\n\n**Goal:** a widget\n\n### Task 1: Base\n\n**Files:**\n- Create: `src/a.js`\n\n### Task 2: Use base\n\nUses `Base` from Task 1.\n');
  fs.writeFileSync(path.join(d, 'src.js'), 'x\n');
  fs.writeFileSync(path.join(d, 'snap.jsonl'), `${JSON.stringify({ schema: 1, meta: { jql: 'p' } })}\n${JSON.stringify({ key: 'T-1', summary: 's', status: 'Done', assignee: '', updated: '2026-01-01T00:00:00Z', resolutiondate: '', issuelinks: [] })}\n`);
  fs.writeFileSync(path.join(d, 'big.jsonl'), 'x'.repeat(8 * 1024 * 1024 + 1));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'docs');
  assert.equal((await run(d, ['init'])).code, 0);
  const b = path.join(d, '.brain');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  fs.writeFileSync(path.join(b, 'findings.jsonl'), jl([{ key: 'T-2', kind: 'risk', text: 'needs a decision' }, { key: 'T-3', kind: 'question', text: 'who owns it?' }]));
  fs.writeFileSync(path.join(b, 'refs.jsonl'), jl([{ key: 'T-1', plans: [{ plan: 'docs/plan.md', task: '1' }], files: { 'src.js': 1 }, fp_files: '', jira_updated: '', audited_at: '' }]));
  fs.writeFileSync(path.join(b, 'learnings.jsonl'), jl([{ id: 'L1', kind: 'rule', topic: 'db', text: 'use migrations', why: 'history', source: 'retro' }]));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ ...p.config, owner_of_decisions: 'Ana' }));
  assert.equal((await run(d, ['build'])).code, 0);
  return d;
}
export const copy = () => { const d = tmp(); fs.cpSync(state.FIX, d, { recursive: true }); return d; };
/** bytes of the text files under .brain and the repo top level that a writing command may change */
export const snapshot = (/** @type {string} */ d) => {
  /** @type {Record<string, string>} */ const o = {};
  for (const rel of ['.brain', '.']) for (const f of fs.readdirSync(path.join(d, rel)).sort()) {
    const p = path.join(d, rel, f);
    if (fs.statSync(p).isFile() && !/\.sqlite|\.lock$/.test(f)) o[path.posix.join(rel, f)] = fs.readFileSync(p, 'utf8').split(d).join('<repo>');
  }
  return o;
};


