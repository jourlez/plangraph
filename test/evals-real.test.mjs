// The real-project generator: real data stays in a temp directory. A stand-in "real project" is built at test time with a canary list
// (invented full names, a ticket-key prefix and summary markers that occur nowhere else); the generator must carry them into its temp
// suite (proving the check is sensitive) and NO file tracked under evals/ may contain any of them. The generator must refuse to write into
// this repository or the source project, must leave the source byte-identical, and its truth must agree with the brain CLI.
// Optional: BRAIN_REAL_PROJECT=<root> also checks that no tracked evals/ file contains a person name or ticket key of that project
// (read-only; only counts are printed). No network, no model calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { genPlan, rng } from './fixtures/gen.mjs';
import { generateReal, checkOut, Refused } from '../evals/gen-real.mjs';

const root = path.resolve(import.meta.dirname, '..');
let tmp, project, canary;

// A canary list generated for this test: syllable names (seeded), a key prefix and summary markers.
function makeCanary(seed) {
  const r = rng(seed), syl = ['zor', 'vath', 'quil', 'lane', 'bris', 'ond', 'ecker', 'mar', 'low', 'ten', 'shi', 'ilse', 'varg', 'pru', 'itt', 'oxa', 'nder', 'ulm'];
  const word = () => { let w = ''; for (let i = 0; i < 3; i++) w += syl[Math.floor(r() * syl.length)]; return w[0].toUpperCase() + w.slice(1); };
  const people = []; while (people.length < 4) { const n = `${word()} ${word()}`; if (!people.includes(n)) people.push(n); }
  return { people, prefix: 'QZXV', marker: `qzxmark${Math.floor(r() * 1e6)}` };
}

function makeProject(dir, cv) {
  const plan = genPlan({ n: 400, people: 4, density: 0.02, seed: 11, cap: 1000, maxSp: 5, prefix: cv.prefix });
  const map = new Map(['Ana', 'Ben', 'Cleo', 'Dan'].map((n, i) => [n, cv.people[i]]));
  for (const t of plan.tickets) { t.summary = `${cv.marker} deliver part ${t.key.split('-')[1]}`; t.v2_owner = map.get(t.v2_owner); }
  for (const s of plan.schedule) s.owner = map.get(s.owner);
  plan.tickets.forEach((t, i) => { if (i % 13 === 4) t.verdict = 'EXTERNAL'; if (i % 50 === 1 && i < 100) t.jira_status = 'Done'; });
  const findings = plan.tickets.filter((_, i) => i % 29 === 6).map((t) => ({ key: t.key, kind: 'export_clash', text: `${cv.marker} clash on ${t.key}` }));
  plan.config.caps = { default: 60, [cv.people[0]]: 90 };
  plan.config.first_sprint = 1;
  const bd = path.join(dir, 'docs', 'plan-graph');
  fs.mkdirSync(bd, { recursive: true });
  const jl = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(path.join(bd, 'tickets.jsonl'), jl(plan.tickets));
  fs.writeFileSync(path.join(bd, 'edges.jsonl'), jl(plan.edges));
  fs.writeFileSync(path.join(bd, 'schedule.jsonl'), jl(plan.schedule));
  fs.writeFileSync(path.join(bd, 'findings.jsonl'), jl(findings));
  fs.writeFileSync(path.join(bd, 'open-items.jsonl'), '');
  fs.writeFileSync(path.join(bd, 'evidence.jsonl'), jl([{ key: plan.tickets[0].key, text: `${cv.marker} evidence` }]));
  fs.writeFileSync(path.join(bd, 'config.json'), JSON.stringify(plan.config, null, 1) + '\n');
  fs.writeFileSync(path.join(dir, '.brainrc'), '{"dir": "docs/plan-graph"}\n');
}
const hashTree = (d) => { const h = crypto.createHash('sha256'); const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(x, e.name); h.update(p.slice(d.length)); if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p)); } }; walk(d); return h.digest('hex'); };
// tracked files plus untracked ones that are not ignored: everything that would be committed from evals/
const tracked = () => spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'evals'], { encoding: 'utf8' }).stdout.split('\0').filter((f) => f && fs.existsSync(path.join(root, f)));
const needles = (cv, keys) => [...cv.people, ...cv.people.map((p) => p.split(' ')[1]), cv.marker, ...keys];

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-real-')));
  project = path.join(tmp, 'project'); fs.mkdirSync(project);
  canary = makeCanary(20261122);
  makeProject(project, canary);
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('generateReal writes a self-contained suite into a temp directory, with truth that agrees with the brain CLI, leaving the source untouched', () => {
  const h0 = hashTree(project);
  const out = path.join(tmp, 'out1');
  const r = generateReal({ from: project, out, runs: 1, verify: true });
  assert.equal(hashTree(project), h0, 'the source project changed');
  assert.ok(r.cases.length >= 25, `only ${r.cases.length} cases`);
  assert.deepEqual(r.truth.mismatches, []);
  assert.ok(r.truth.checked.length >= 20, `only ${r.truth.checked.length} cross-checked`);
  for (const f of ['cases.json', 'manifest.json', 'plugin/evals/fixtures/R/tickets.jsonl', 'plugin/evals/r-lookup/scaffold.sh', 'plugin/bin/brain']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, 'plugin', 'evals', 'fixtures', 'R', 'evidence.jsonl')), 'evidence is not copied');
  const all = fs.readFileSync(path.join(out, 'cases.json'), 'utf8') + fs.readFileSync(path.join(out, 'plugin/evals/fixtures/R/tickets.jsonl'), 'utf8');
  assert.ok(canary.people.every((p) => all.includes(p)) && all.includes(canary.marker) && all.includes(`${canary.prefix}-`), 'the canaries reach the temp suite: the leak check below is sensitive');
  const man = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8');
  for (const n of needles(canary, [])) assert.ok(!man.includes(n), 'the manifest carries counts only');
  assert.match(fs.readFileSync(path.join(out, 'plugin/evals/r-lookup/scaffold.sh'), 'utf8'), /\.brainrc/, 'the workspace keeps the project layout (.brainrc)');
});

test('the gen-real CLI prints counts only, never names, keys or summaries', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'evals', 'gen-real.mjs'), '--from', project, '--out', path.join(tmp, 'out-cli')], { encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stderr);
  for (const n of needles(canary, [`${canary.prefix}-1`])) assert.ok(!r.stdout.includes(n) && !r.stderr.includes(n), 'the CLI output leaked a canary');
  assert.match(r.stdout, /^out: /m);
});

test('no committable file under evals/ contains a canary name, key or summary marker (and none from BRAIN_REAL_PROJECT when set)', () => {
  const files = tracked();
  assert.ok(files.length >= 20, 'git ls-files found the tracked eval files');
  const texts = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  const hit = (ns) => ns.filter((n) => texts.some((t) => t.includes(n))).length;
  assert.equal(hit(needles(canary, [`${canary.prefix}-`])), 0);
  const real = process.env.BRAIN_REAL_PROJECT;
  if (real && fs.existsSync(path.join(real, '.brainrc'))) {
    const dir = JSON.parse(fs.readFileSync(path.join(real, '.brainrc'), 'utf8')).dir;
    const rows = (n) => fs.readFileSync(path.join(real, dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const people = [...new Set(rows('schedule.jsonl').map((x) => x.owner).filter((x) => typeof x === 'string' && x.length > 3))];
    const keys = rows('tickets.jsonl').map((t) => t.key);
    const hits = hit([...people, ...keys.map((k) => `${k}"`), ...keys.map((k) => `${k} `)]);
    assert.equal(hits, 0, `${hits} real names or keys found in tracked eval files`);
  }
});

test('the generator refuses to write into this repository, into the source project, or into a non-empty directory (nothing is created)', () => {
  const gen = (out) => spawnSync(process.execPath, [path.join(root, 'evals', 'gen-real.mjs'), '--from', project, '--out', out], { encoding: 'utf8', timeout: 120000 });
  const inRepo = path.join(root, 'evals', 'real-out-should-not-exist');
  for (const [out, why] of /** @type {Array<[string, RegExp]>} */ ([[inRepo, /open-brain repository/], [path.join(root, 'tmp-real'), /open-brain repository/], [path.join(project, 'eval-out'), /source project/]])) {
    const r = gen(out);
    assert.equal(r.status, 2, out);
    assert.match(r.stderr, why);
    assert.ok(!fs.existsSync(out), `${out} was created`);
  }
  const full = path.join(tmp, 'full'); fs.mkdirSync(full); fs.writeFileSync(path.join(full, 'x'), '');
  assert.match(gen(full).stderr, /must be empty/);
  // a symlink that points into the repository is resolved before the check
  const link = path.join(tmp, 'link-to-repo'); fs.symlinkSync(path.join(root, 'evals'), link);
  assert.throws(() => checkOut(path.join(link, 'x'), { from: project }), Refused);
  assert.throws(() => checkOut(project, { from: project }), Refused);
  const r = spawnSync(process.execPath, [path.join(root, 'evals', 'run.mjs'), '--dry-run', '--real', project, '--out', path.join(root, 'evals', 'real-run-out')], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 2);
  assert.ok(!fs.existsSync(path.join(root, 'evals', 'real-run-out')));
  assert.equal(gen(path.join(tmp, 'ok-out')).status, 0, 'a temp directory is accepted');
});

test('the runner --real --dry-run builds the real suite in a temp dir and prints commands and a cost range without calling claude', () => {
  const fake = path.join(tmp, 'fakebin'); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'claude'), `#!/bin/sh\ntouch ${JSON.stringify(path.join(tmp, 'called'))}\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(root, 'evals', 'run.mjs'), '--dry-run', '--real', project], { encoding: 'utf8', timeout: 240000, env: { ...process.env, TMPDIR: tmp, PATH: `${fake}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(tmp, 'called')));
  assert.match(r.stdout, /cases \(\d+ families/);
  assert.match(r.stdout, /cost estimate .*USD/);
  for (const n of needles(canary, [`${canary.prefix}-1 `])) assert.ok(!r.stdout.includes(n), 'dry-run output leaked a canary');
  const suite = /SUITE='([^']+)'/.exec(r.stdout)[1];
  assert.ok(suite.startsWith(tmp), 'suite in the temp dir');
  assert.ok(fs.existsSync(path.join(suite, 'pass-headline', 'evals', 'fixtures', 'R', 'plan.md')));
});
