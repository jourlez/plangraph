// superpowers ledger layouts by release, checked against the release sources of the superpowers repository (git show <tag>:<path>, read
// only): 6.1.1 flat `.superpowers/sdd/progress.md`; 6.2.0 and 6.3.0 per-plan `.superpowers/sdd/<plan-basename>/progress.md` with no
// marker; 6.4.1 to 7.0.2 per-plan with a `plan-path` marker (repo-relative, or absolute outside the repo) and `<slug>-<parent>[-N]` on a
// slug collision. In every per-plan release the ledger's first line is `# SDD ledger — plan: <plan file path as typed>`, `task-done`
// appends `Task N: complete (commits <base>..<head>, tests: <cmd> → <last line>)`, the final review records `Final: Ruling: ...` and
// `Final review: ...`, and the workspace is deleted once the final review is clean. Fixtures below are synthetic, built from those
// format lines only (invented plan names and commands).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { findLedgers, parseLedger, ledgerLayoutOf, SP_LAYOUTS } from '../lib/integrations/superpowers.ts';

const HERE = import.meta.dirname, BRAIN = path.join(HERE, '../bin/brain'), FIX = path.join(HERE, 'fixtures/superpowers');
const fx = (p: string) => fs.readFileSync(path.join(FIX, p), 'utf8');
const tmps: string[] = []; after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-spl-'))); tmps.push(d); return d; };
const put = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const PLAN_REL = 'docs/superpowers/plans/2026-11-20-widget-export.md', SLUG = '2026-11-20-widget-export';
const ID = (p: string) => `# SDD ledger — plan: ${p}\n`;
const DONE1 = 'Task 1: complete (commits 1a2b3c4..5d6e7f8, tests: npm test → 12 passed)\n';

test('findLedgers: a marker-less per-plan workspace (6.2.0/6.3.0) is used only when its identity line names this plan', () => {
  const root = tmp(), warnings: string[] = [];
  put(root, `.superpowers/sdd/${SLUG}/progress.md`, ID(PLAN_REL) + DONE1);
  assert.deepEqual(findLedgers(root, { planSlug: SLUG, planPath: PLAN_REL, warnings }).map((x) => [path.relative(root, x.path), x.layout]), [[`.superpowers/sdd/${SLUG}/progress.md`, 'per-plan']]);
  assert.deepEqual(warnings, []);
  put(root, `.superpowers/sdd/${SLUG}/progress.md`, ID('docs/plans/other/2026-11-20-widget-export.md') + DONE1);
  assert.deepEqual(findLedgers(root, { planSlug: SLUG, planPath: PLAN_REL, warnings }), [], 'another plan with the same basename: skipped');
  put(root, `.superpowers/sdd/${SLUG}/progress.md`, DONE1);
  assert.deepEqual(findLedgers(root, { planSlug: SLUG, planPath: PLAN_REL, warnings }), []);
  assert.deepEqual(warnings, [`found .superpowers/sdd/${SLUG}/progress.md without a plan identity: pass --ledger FILE to use it`]);
  // only the exact basename directory can be marker-less: 7.x always writes a marker into a disambiguated `<slug>-<parent>` directory
  const r2 = tmp(); put(r2, `.superpowers/sdd/${SLUG}-plans/progress.md`, ID(PLAN_REL) + DONE1);
  assert.deepEqual(findLedgers(r2, { planSlug: SLUG, planPath: PLAN_REL }), []);
  // a symlinked progress.md or a directory in its place is never followed
  const r3 = tmp(); put(r3, 'elsewhere.md', ID(PLAN_REL) + DONE1); fs.mkdirSync(path.join(r3, `.superpowers/sdd/${SLUG}`), { recursive: true });
  fs.symlinkSync(path.join(r3, 'elsewhere.md'), path.join(r3, `.superpowers/sdd/${SLUG}/progress.md`));
  assert.deepEqual(findLedgers(r3, { planSlug: SLUG, planPath: PLAN_REL }), []);
});

test('findLedgers: 7.0.2 markers: absolute marker for a plan outside the repo, `<slug>-<parent>-N` directories, identity typed as an absolute path', () => {
  const root = tmp();
  put(root, `.superpowers/sdd/${SLUG}-plans-2/progress.md`, ID(path.join(root, PLAN_REL)) + DONE1); put(root, `.superpowers/sdd/${SLUG}-plans-2/plan-path`, PLAN_REL + '\n');
  put(root, `.superpowers/sdd/${SLUG}/progress.md`, ID('/abs/other/2026-11-20-widget-export.md') + DONE1); put(root, `.superpowers/sdd/${SLUG}/plan-path`, '/abs/other/2026-11-20-widget-export.md\n');
  const got = findLedgers(root, { planSlug: SLUG, planPath: PLAN_REL });
  assert.deepEqual(got.map((x) => path.relative(root, x.path)), [`.superpowers/sdd/${SLUG}-plans-2/progress.md`]);
  const l = parseLedger(fs.readFileSync(got[0].path, 'utf8'), got[0].path);
  assert.equal(l.plan, path.join(root, PLAN_REL));
  assert.deepEqual(l.entries, [{ task: '1', status: 'done', commits: '1a2b3c4..5d6e7f8', notes: [] }]);
  assert.equal(l.unclassified, 0);
});

test('parseLedger: `Final: Ruling:` is a ruling, `Final review:` and `Final: minor (deferred):` are known lines', () => {
  const l = parseLedger(ID(PLAN_REL) + DONE1 + 'Final review: self-review (no subagent tool)\nFinal: Ruling: keep the plain-text 413 body — the spec names only the code — a JSON client would break\nFinal: minor (deferred): rename a helper\n', 'progress.md');
  assert.deepEqual(l.rulings, [{ task: null, text: 'keep the plain-text 413 body — the spec names only the code — a JSON client would break', line: 4 }]);
  assert.deepEqual(l.deferred, [{ task: null, text: 'rename a helper', line: 5 }]);
  assert.equal(l.unclassified, 0);
  const t0 = performance.now(), big = parseLedger(ID(PLAN_REL) + 'Final: Ruling:' + ' \t'.repeat(1 << 20) + '\r' + 'Final: Ruling: ' + '\t'.repeat(1 << 20) + 'x\n', 'progress.md');
  assert.ok(performance.now() - t0 < 3000, 'a 2 MiB hostile ruling line parses in linear time'); assert.equal(big.rulings.length, 1);
  const hostile = parseLedger(ID(PLAN_REL) + 'Final: Ruling: x\u001b[31m <b>y</b>‮\n', 'progress.md');
  assert.equal(hostile.rulings.length, 1); assert.doesNotMatch(hostile.rulings[0].text, /[<>\u001b‮]/);
});

test('ledgerLayoutOf: the verified releases, everything else not verified', () => {
  assert.deepEqual(SP_LAYOUTS.flatMap((x) => x.versions), ['6.1.1', '6.2.0', '6.3.0', '6.4.1', '6.4.2', '7.0.0', '7.0.1', '7.0.2']);
  assert.deepEqual(ledgerLayoutOf('6.1.1'), { verified: true, layout: 'flat', line: 'superpowers 6.1.1 keeps it at .superpowers/sdd/progress.md (verified; brain reads the 6.1.1 to 7.0.2 layouts)' });
  assert.equal(ledgerLayoutOf('6.3.0').line, 'superpowers 6.3.0 keeps it at .superpowers/sdd/PLAN/progress.md, deleted after the final review (verified; brain reads the 6.1.1 to 7.0.2 layouts)');
  assert.equal(ledgerLayoutOf('7.0.2').line, 'superpowers 7.0.2 keeps it at .superpowers/sdd/PLAN*/progress.md beside a plan-path marker, deleted after the final review (verified; brain reads the 6.1.1 to 7.0.2 layouts)');
  for (const v of ['7.0.3', '7.1.0', '8.0.0', '6.0.3', '6.4.0', '7.0.2-beta', 'abc123']) assert.deepEqual(ledgerLayoutOf(v), { verified: false, layout: null, line: `superpowers ${v} layout not verified (brain reads the 6.1.1 to 7.0.2 layouts; sp-ingest looks for each of them)` }, v);
  for (const v of [undefined, '', null]) assert.equal(ledgerLayoutOf(v).line, 'superpowers version unknown, layout not verified (brain reads the 6.1.1 to 7.0.2 layouts; sp-ingest looks for each of them)');
  assert.equal(ledgerLayoutOf('1\n</untrusted>' + 'x'.repeat(300)).line.split('\n').length, 1);
  assert.doesNotMatch(ledgerLayoutOf('1<x>').line, /[<>]/);
});

// ---- CLI ----
const run = (cwd: string, env: Record<string, string | undefined>, ...args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, BRAIN_DIR: '', ...env } });
function spRepo() {
  const root = tmp(); execFileSync('git', ['init', '-q'], { cwd: root });
  put(root, PLAN_REL, fx('plans/2026-11-20-widget-export.md'));
  assert.equal(run(root, { HOME: root }, 'init').status, 0);
  return root;
}

test('sp-ingest without a ledger says so plainly: no impl_status set, or how many previous ones were kept; checkboxes are never progress', () => {
  const root = spRepo();
  let r = run(root, { HOME: root }, 'sp-ingest', PLAN_REL); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ingested sp:2026-11-20-widget-export: 3 tasks, 2 edges, 4 findings, 0 statuses from ledger (no ledger found: no impl_status set; plan checkboxes are never read as progress)\n');
  put(root, `.superpowers/sdd/${SLUG}/progress.md`, ID(PLAN_REL) + DONE1); put(root, `.superpowers/sdd/${SLUG}/plan-path`, PLAN_REL + '\n');
  r = run(root, { HOME: root }, 'sp-ingest', PLAN_REL); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ingested [^\n]*, 1 statuses from ledger\n$/);
  fs.rmSync(path.join(root, '.superpowers'), { recursive: true }); // 7.x deletes the workspace after a clean final review
  r = run(root, { HOME: root }, 'sp-ingest', PLAN_REL); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 statuses from ledger \(no ledger found: kept the previous impl_status of 3 tasks; plan checkboxes are never read as progress\)\n$/);
  r = run(root, { HOME: root }, 'sp-ingest', PLAN_REL, '--ledger', 'none'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(--ledger none: kept the previous impl_status of 3 tasks; plan checkboxes are never read as progress\)\n$/);
});

const registry = (home: string, plugins: unknown) => put(home, '.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins }));
test('integrations: the ledger layout line for the installed version, and an enabled key that is not installed', () => {
  const root = tmp(), home = tmp();
  for (const [v, want] of [['7.0.2', ledgerLayoutOf('7.0.2').line], ['7.1.0', ledgerLayoutOf('7.1.0').line], ['6.2.0', ledgerLayoutOf('6.2.0').line]]) {
    registry(home, { 'superpowers@dev': [{ scope: 'user', version: v }] });
    const r = run(root, { HOME: home }, 'integrations'); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n').slice(0, 2), [`superpowers: installed ${v}`, `  ledger: ${want}`], v);
  }
  registry(home, {}); put(root, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'superpowers@market': true } }));
  const r = run(root, { HOME: home }, 'integrations');
  assert.equal(r.stdout.split('\n')[0], 'superpowers: absent (enabled but not installed: superpowers@market (project))');
  assert.doesNotMatch(r.stdout, /ledger:/, 'no layout line when superpowers is not installed');
});
