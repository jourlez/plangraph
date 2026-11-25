// Golden characterization tests: freeze the CURRENT stdout, stderr and exit code of every `brain` command (default and --json)
// before bin/brain is restructured. Compare against test/golden/<name>.txt; UPDATE_GOLDEN=1 rewrites the files (review them by eye).
// Everything runs in throwaway temp dirs with a private HOME, CLAUDE_PLUGIN_DATA and GIT_CONFIG_GLOBAL=/dev/null; nothing touches the real
// home or data dir, the network, or the clock (temp paths, shas and timestamps are normalized in the captured text).
// Not covered: jira-pull (needs live Jira credentials and network; only its refusal without credentials is frozen), the
// merge-driver install of `init`/`doctor --fix` (git config is private, its path is normalized), and `-v` of every command.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';

const HERE = import.meta.dirname, BRAIN = path.join(HERE, '../bin/brain'), GOLD = path.join(HERE, 'golden'), FX = path.join(HERE, 'fixtures');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const put = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const fx = (rel: string) => fs.readFileSync(path.join(FX, rel), 'utf8');

let PATHDIR: string, BASE: string, TEMPLATE: string, HOME: string, DATA: string, SPREPO: string, EMPTY: string;
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.invalid', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const env = () => ({ PATH: PATHDIR, HOME, CLAUDE_PLUGIN_DATA: DATA, LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', PLANGRAPH_STRICT_OUT: '1', ...GIT_ENV }); // strict: a multi-line ctx.io.out fails here
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
const run = (cwd: string, args: string[], input?: string) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, env: env(), encoding: 'utf8', input, timeout: 60000 });

function makeFixture(root: string): void {
  const p = genPlan({ n: 40, people: 3, seed: 7 });
  git(root, 'init', '-q'); git(root, 'checkout', '-q', '-b', 'main');
  put(root, 'docs/plan.md', '# Plan\n\n### Task 1: first\nbuild a\n\n### Task 2: second\nbuild b using a\n');
  put(root, '.plangraphrc', '{"dir":".plangraph"}\n');
  const ini = run(root, ['init']); assert.equal(ini.status, 0, ini.stderr);
  const B = '.plangraph/';
  put(root, B + 'tickets.jsonl', jl(p.tickets.map((t, i) => (i === 2 ? { ...t, verdict: 'BLOCKED', verdict_source: 'refute' } : t))));
  put(root, B + 'edges.jsonl', jl(p.edges)); put(root, B + 'schedule.jsonl', jl(p.schedule));
  put(root, B + 'config.json', JSON.stringify({ ...p.config, caps: { default: 1000 }, first_sprint: 1, closed_statuses: ['Done'], owner_of_decisions: 'Ana', default_ref: 'HEAD' }, null, 2) + '\n');
  put(root, B + 'findings.jsonl', jl([
    { key: 'T-3', kind: 'plan_text', text: 'step needs a missing thing' }, { key: 'T-5', kind: 'external', text: 'needs an outside login' },
    { key: 'T-5', kind: 'plan_text', text: 'second issue' }, { key: 'T-9', kind: 'export_clash', text: 'two exports share a name' }, { key: 'T-12', kind: 'note', text: 'keep an eye' }]));
  put(root, B + 'evidence.jsonl', jl([
    { key: 'T-3', source: 'audit', verdict: 'BLOCKED', resolution: 'wait for T-1', needs: 'T-1' }, { key: 'T-5', source: 'audit', verdict: 'READY', resolution: '', needs: '' }]));
  put(root, B + 'refs.jsonl', jl([{ key: 'T-1', plans: [{ plan: 'docs/plan.md', task: '1', fp: '' }], files: {}, fp_files: '', jira_updated: '', audited_at: 'base' }]));
  put(root, B + 'history.jsonl', jl([30, 34, 28, 36].map((d, i) => ({ sprint: i + 1, planned: 40, done: d, added: 2, carried: 40 + 2 - d > 0 ? 42 - d : 0 }))));
  put(root, B + 'learnings.jsonl', fs.readFileSync(path.join(HERE, '../seed/learnings.seed.jsonl'), 'utf8'));
  put(root, '.wolf/cerebrum.md', fx('openwolf/cerebrum.template.md').replace('## Key Learnings\n', '## Key Learnings\n\n- Prices are computed on the server in minor units.\n').replace('## Do-Not-Repeat\n', '## Do-Not-Repeat\n\n[2026-01-02] Never confirm a checkout from the redirect; wait for the webhook.\n[2026-01-03] Do not hardcode a client brand in public copy.\n'));
  put(root, '.wolf/STATUS.md', '---\ndescription: handoff\n---\n# STATUS\n\n## Done\n\n- T-1 shipped.\n\n## Next quest\n\n### Open decisions\n- Should T-12 move to sprint 4? (T-12)\n\n### Blockers\n- T-3 waits on T-1 (T-3 and ZZ-9)\n\n## Context\n\n- Branch main.\n<!-- brain:card:begin -->\nold line\n<!-- brain:card:end -->\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  const b = run(root, ['build']); assert.equal(b.status, 0, b.stderr);
  // one registered open item so open-items has a table and a closed list
  let r = run(root, ['open-items', '--register', 'T-12', 'followup', '--owner', 'Ana', '--due', '3', '--text', 'confirm scope', '--write']); assert.equal(r.status, 0, r.stderr);
  r = run(root, ['open-items', '--register', 'T-20', 'decision', '--owner', 'Ben', '--due', '5', '--text', 'pick a vendor', '--write']); assert.equal(r.status, 0, r.stderr);
  r = run(root, ['open-items', '--close', 'T-20', 'decision', '--note', 'done', '--write']); assert.equal(r.status, 0, r.stderr);
}

before(() => {
  BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-golden-')));
  HOME = path.join(BASE, 'home'); DATA = path.join(BASE, 'data'); fs.mkdirSync(HOME); fs.mkdirSync(DATA);
  // a private PATH holding only node and git, so doctor's probes (uv, python, ...) do not depend on the host
  PATHDIR = path.join(BASE, 'bin'); fs.mkdirSync(PATHDIR);
  fs.symlinkSync(process.execPath, path.join(PATHDIR, 'node'));
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(PATHDIR, 'git'));
  TEMPLATE = path.join(BASE, 'template'); fs.mkdirSync(TEMPLATE); makeFixture(TEMPLATE);
  SPREPO = path.join(BASE, 'sp'); fs.mkdirSync(SPREPO); git(SPREPO, 'init', '-q'); assert.equal(run(SPREPO, ['init']).status, 0);
  put(SPREPO, 'docs/superpowers/plans/2026-11-20-widget-export.md', fx('superpowers/plans/2026-11-20-widget-export.md'));
  EMPTY = path.join(BASE, 'empty'); fs.mkdirSync(EMPTY); git(EMPTY, 'init', '-q');
});
after(() => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ } });

// Normalize everything host- or run-specific so the goldens are byte-stable.
// A host path is replaced only as a whole path (not inside a longer name): a checkout at a short path such as /w (a container) must not turn
// src/store/widgets.mjs into src/store<PLUGIN>idgets.mjs.
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function normalize(text: string, root: string): string {
  let t = text;
  for (const [from, to] of [[root, '<REPO>'], [DATA, '<DATA>'], [HOME, '<HOME>'], [BASE, '<BASE>'], [path.join(HERE, '..'), '<PLUGIN>']]) t = t.replace(new RegExp(`(?<![\\w.-])${escRe(from)}(?![\\w.-])`, 'g'), () => to);
  // an uncaught error prints a source excerpt and a stack with line numbers: keep only the error line and its code
  t = t.split('\n').filter((l) => !/^\s+at /.test(l) && !/^Node\.js v/.test(l)).join('\n');
  t = t.replace(/--- stderr\nfile:\/\/[^\n]*\n[^\n]*\n[^\n]*\n\n/, '--- stderr\n');
  return t.replace(/\b[0-9a-f]{40}\b/g, '<SHA40>').replace(/"imported_at":"[^"]*"/g, '"imported_at":"<TS>"').replace(/built (<?\d+\w*|just now|moments?) ?\w* ago/g, 'built <AGE> ago').replace(/node v\d+\.\d+\.\d+/g, 'node v<NODE>').replace(/brain-golden-\w+/g, '<TMP>');
}

// Ana's capacity lowered in config.json (read at run time, not part of the source fingerprint): her sprint loads go over cap for relieve.
const capAna = (root: string, cap: number) => { const f = path.join(root, '.plangraph/config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...c, caps: { ...c.caps, Ana: cap } }, null, 2) + '\n'); };
// A case: { name, args, repo: 'fixture' (default, fresh copy of the built fixture) | 'sp' | 'empty', stdin, setup(root), files: [rel paths printed after the run] }
const J = (...a: string[]) => [...a, '--json'];
interface Case { name: string; args: string[]; repo?: 'sp' | 'empty'; stdin?: string; setup?: (root: string) => void; files?: string[] }
const CASES: Case[] = [
  // read commands, default and --json
  { name: 'ticket', args: ['ticket', 'T-5'] }, { name: 'ticket-json', args: J('ticket', 'T-5') },
  { name: 'ticket-verbose', args: ['ticket', 'T-5', '-v'] }, { name: 'ready-json-blocked', args: J('ready', 'T-3') },
  { name: 'explain', args: ['explain'] }, { name: 'explain-whatif', args: ['explain', 'whatif'] }, { name: 'explain-json', args: J('explain', 'ticket') },
  { name: 'err-typo', args: ['tikcet', 'T-5'] }, { name: 'explain-unknown', args: ['explain', 'nope'] },
  { name: 'ticket-missing', args: ['ticket', 'T-999'] }, { name: 'ticket-noarg', args: ['ticket'] },
  { name: 'neighbors', args: ['neighbors', 'T-12', '2'] }, { name: 'neighbors-json', args: J('neighbors', 'T-12', '2') },
  { name: 'chain', args: ['chain', 'T-30'] }, { name: 'chain-json', args: J('chain', 'T-30') },
  { name: 'sprint', args: ['sprint', '3'] }, { name: 'sprint-json', args: ['sprint', '3', '--json'] }, { name: 'sprint-verbose', args: ['sprint', '3', '-v'] },
  { name: 'person', args: ['person', 'Ana'] }, { name: 'person-json', args: J('person', 'Ana') },
  { name: 'blockers', args: ['blockers'] }, { name: 'blockers-json', args: J('blockers') },
  { name: 'findings', args: ['findings'] }, { name: 'findings-kind', args: ['findings', 'external'] }, { name: 'findings-json', args: J('findings') },
  { name: 'rules', args: ['rules'] }, { name: 'rules-topic', args: ['rules', 'loops'] }, { name: 'rules-json', args: J('rules') },
  { name: 'rules-repo', args: ['rules', '--repo'] }, { name: 'rules-repo-json', args: J('rules', '--repo') }, { name: 'rules-repo-max', args: ['rules', '--repo', '--max', '1'] },
  { name: 'rules-repo-nowolf', args: ['rules', '--repo'], setup: (r) => fs.rmSync(path.join(r, '.wolf'), { recursive: true }) },
  { name: 'check', args: ['check'] }, { name: 'check-json', args: J('check') },
  { name: 'ready', args: ['ready', 'T-8'] }, { name: 'ready-ok', args: ['ready', 'T-1'] }, { name: 'whatif-ok', args: ['whatif', 'T-40', '--sprint', '6'] }, { name: 'ready-json', args: J('ready', 'T-8') }, { name: 'ready-blocked', args: ['ready', 'T-3'] }, { name: 'ready-noarg', args: ['ready'] },
  { name: 'ready-bulk', args: ['ready', '--person', 'Ana', '--sprint', '1'] }, { name: 'ready-bulk-json', args: J('ready', '--sprint', '3') }, { name: 'ready-bulk-both', args: ['ready', 'T-8', '--sprint', '3'] },
  { name: 'verify', args: ['verify'] }, { name: 'verify-json', args: J('verify') },
  { name: 'whatif', args: ['whatif', 'T-9', '--sprint', '4'] }, { name: 'whatif-json', args: J('whatif', 'T-9', '--sprint', '4') },
  { name: 'whatif-to', args: ['whatif', 'T-9', '--to', 'Ben'] }, { name: 'whatif-noarg', args: ['whatif'] },
  { name: 'whatif-relieve', args: ['whatif', '--relieve', 'Ana', '--sprint', '3'], setup: (r) => capAna(r, 12) }, { name: 'whatif-relieve-json', args: J('whatif', '--relieve', 'Ana', '--sprint', '3'), setup: (r) => capAna(r, 12) },
  { name: 'whatif-relieve-none', args: ['whatif', '--relieve', 'Ana', '--sprint', '1'], setup: (r) => capAna(r, 4) }, { name: 'whatif-relieve-write', args: ['whatif', '--relieve', 'Ana', '--sprint', '3', '--write'] },
  { name: 'forecast', args: ['forecast'] }, { name: 'forecast-json', args: J('forecast') },
  { name: 'forecast-nohistory', args: ['forecast'], setup: (r) => fs.rmSync(path.join(r, '.plangraph/history.jsonl')) },
  { name: 'simulate', args: ['simulate', '--runs', '50', '--seed', '3'] }, { name: 'simulate-json', args: J('simulate', '--runs', '50', '--seed', '3') },
  { name: 'open-items', args: ['open-items'] }, { name: 'open-items-json', args: J('open-items') },
  { name: 'open-items-mine', args: ['open-items', '--mine', '--me', 'Ana'] },
  { name: 'open-items-suggest', args: ['open-items', '--suggest-from-status'] }, { name: 'open-items-suggest-json', args: J('open-items', '--suggest-from-status') },
  { name: 'open-items-suggest-write', args: ['open-items', '--suggest-from-status', '--write'] },
  { name: 'open-items-findings', args: ['open-items', '--findings', '-', '--write'], stdin: jl([{ key: 'T-30', kind: 'plan_text', text: 'late finding' }]), files: ['.plangraph/open-items.jsonl'] },
  { name: 'open-items-reopen', args: ['open-items', '--reopen', 'T-20', 'decision', '--write'], files: ['.plangraph/open-items.jsonl'] },
  { name: 'card', args: ['card'] }, { name: 'card-json', args: J('card') }, { name: 'card-line', args: ['card', '--line'] }, { name: 'card-line-json', args: J('card', '--line') },
  { name: 'card-write', args: ['card', '--write'], files: ['.wolf/STATUS.md'] }, { name: 'card-if-present', args: ['card', '--if-present'] },
  { name: 'card-if-present-noindex', args: ['card', '--if-present'], repo: 'empty' },
  { name: 'stale', args: ['stale', '--ref', 'HEAD'] }, { name: 'stale-list', args: ['stale', '--ref', 'HEAD', '--list'] },
  { name: 'refs-update', args: ['refs-update', '--ref', 'HEAD'], files: ['.plangraph/refs.jsonl'] },
  { name: 'bundle', args: ['bundle', 'T-3', 'T-5'] }, { name: 'bundle-missing', args: ['bundle', 'T-999'] },
  { name: 'units', args: ['units', '--keys', 'T-3,T-5,T-9', '--size', '2', '--out', 'units-out'], files: ['units-out/u001.md', 'units-out/u001.in.json', 'units-out/units.json'] },
  { name: 'schedule-load', args: ['schedule-load', 'new-schedule.json', 'archive-a'], setup: (r) => put(r, 'new-schedule.json', JSON.stringify(genPlan({ n: 40, people: 3, seed: 7 }).schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.key === 'T-9' ? s.sprint + 1 : s.sprint })))), files: ['.plangraph/schedule.jsonl'] },
  { name: 'report', args: ['report'], files: ['.plangraph/report.md', '.plangraph/report.html'] }, { name: 'report-badflag', args: ['report', '--jira', 'x.json'] },
  { name: 'build', args: ['build'] }, { name: 'build-json', args: J('build') },
  { name: 'export', args: ['export'] },
  { name: 'migrate', args: ['migrate'] }, { name: 'migrate-write', args: ['migrate', '--write'] }, { name: 'migrate-json', args: J('migrate') },
  { name: 'doctor', args: ['doctor'] }, { name: 'doctor-json', args: J('doctor') },
  { name: 'doctor-fix', args: ['doctor', '--fix'] },
  { name: 'doctor-conflict', args: ['doctor'], setup: (r) => fs.appendFileSync(path.join(r, '.plangraph/findings.jsonl'), '<<<<<<< ours\n') },
  { name: 'integrations', args: ['integrations'] }, { name: 'integrations-verbose', args: ['integrations', '-v'] }, { name: 'integrations-json', args: J('integrations') },
  { name: 'init', args: ['init'], repo: 'empty', files: ['.plangraph/config.json', '.plangraph/.gitignore', '.plangraph/format.json'] }, { name: 'init-json', args: J('init'), repo: 'empty' },
  { name: 'learn-from-wolf-text', args: ['learn', '--from-wolf', 'Never confirm a checkout from the redirect; wait for the webhook.'], files: ['.plangraph/learnings.jsonl'] },
  { name: 'learn-from-wolf-nomatch', args: ['learn', '--from-wolf', 'no such rule'] }, { name: 'learn-noarg', args: ['learn'] }, { name: 'learn-number', args: ['learn', '--from-wolf', '3'] },
  { name: 'learn-bad-handle', args: ['learn', '--from-wolf', 'w000000'] },
  { name: 'sp-ingest', args: ['sp-ingest', 'docs/superpowers/plans/2026-11-20-widget-export.md', '--ledger', 'none'], repo: 'sp', setup: (r) => put(r, '.plangraph/tickets.jsonl', ''), files: ['.plangraph/tickets.jsonl', '.plangraph/edges.jsonl', '.plangraph/refs.jsonl'] },
  { name: 'sp-ingest-json', args: J('sp-ingest', 'docs/superpowers/plans/2026-11-20-widget-export.md', '--ledger', 'none', '--owner', 'Ana', '--sprint', '2'), repo: 'sp' },
  { name: 'sp-ingest-missing', args: ['sp-ingest', 'docs/nope.md'], repo: 'sp' }, { name: 'sp-ingest-noarg', args: ['sp-ingest'], repo: 'sp' },
  { name: 'sp-link', args: ['sp-link', 'T-3', 'docs/plan.md', '--tasks', '1,2'], files: ['.plangraph/refs.jsonl'] },
  { name: 'sp-link-missing', args: ['sp-link', 'T-3', 'docs/none.md'] }, { name: 'sp-link-noarg', args: ['sp-link'] },
  { name: 'jira-import', args: ['jira-import', 'issue.json', '--out', 'snap.jsonl'], setup: (r) => put(r, 'issue.json', fx('jira-connector-issue.json')), files: ['snap.jsonl'] },
  { name: 'jira-import-noarg', args: ['jira-import'] }, { name: 'jira-import-badfile', args: ['jira-import', 'nope.json', '--out', 'snap.jsonl'] },
  { name: 'jira-text', args: ['jira-text', 'DEMO-1', '--out', 'jt', '--from-json', 'issue.json'], setup: (r) => put(r, 'issue.json', fx('jira-connector-issue.json')), files: ['jt/DEMO-1.txt'] },
  { name: 'jira-text-noarg', args: ['jira-text'] },
  { name: 'jira-pull-nocreds', args: ['jira-pull', '--out', 'snap.jsonl'] },
  // error paths: bad arguments, unknown command, missing data
  { name: 'err-nocommand', args: [] }, { name: 'err-unknown', args: ['frobnicate'] }, { name: 'err-badflag', args: ['ticket', 'T-5', '--bogus'] },
  { name: 'err-badflag-sprint', args: ['sprint', '--bogus'] }, { name: 'err-sprint-nan', args: ['sprint', 'abc'] }, { name: 'err-person-noarg', args: ['person'] },
  { name: 'err-nobrain-ticket', args: ['ticket', 'T-1'], repo: 'empty' }, { name: 'err-nobrain-build', args: ['build'], repo: 'empty' },
  { name: 'err-nobrain-check', args: ['check'], repo: 'empty' }, { name: 'err-nobrain-doctor', args: ['doctor'], repo: 'empty' },
  { name: 'err-nobrain-learn', args: ['learn', '--from-wolf', 'x'], repo: 'empty' },
  { name: 'err-newer-format', args: ['ticket', 'T-5'], setup: (r) => put(r, '.plangraph/format.json', '{"format_version":99,"min_reader":99}\n') },
];

for (const c of CASES) {
  test(`golden: ${c.name}`, () => {
    const root = path.join(BASE, 'run-' + c.name); const src = { sp: SPREPO, empty: EMPTY }[c.repo as 'sp' | 'empty'] || TEMPLATE; // no repo reads undefined: the fixture
    fs.cpSync(src, root, { recursive: true });
    if (c.setup) c.setup(root);
    const r = run(root, c.args, c.stdin);
    assert.equal(r.error, undefined, String(r.error));
    let body = `$ brain ${c.args.join(' ')}\nexit: ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;
    for (const f of c.files || []) { const fp = path.join(root, f); body += `--- file ${f}\n${fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '(missing)\n'}`; }
    const got = normalize(body, root);
    const file = path.join(GOLD, c.name + '.txt');
    if (UPDATE) { fs.mkdirSync(GOLD, { recursive: true }); fs.writeFileSync(file, got); return; }
    assert.ok(fs.existsSync(file), `missing golden ${c.name}.txt (run with UPDATE_GOLDEN=1 and review it)`);
    assert.equal(got, fs.readFileSync(file, 'utf8'));
  });
}

test('golden: every registered command is exercised', async () => {
  const { registry } = await import('../src/registry.ts');
  const used = new Set(CASES.map((c) => c.args[0]).filter(Boolean));
  const missing = [...registry.keys()].filter((h) => !used.has(h));
  assert.deepEqual(missing, []);
  assert.ok(registry.size >= 33);
});
