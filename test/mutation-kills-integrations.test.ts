// Characterization goldens for lib/integrations/superpowers.ts and lib/integrations/openwolf.ts (test/golden/mutation-kills/
// integrations.json, UPDATE_GOLDEN=1 rewrites), written to kill mutants that survived scripts/mutate-all.ts. Inputs are the synthetic
// fixtures in test/fixtures/{superpowers,openwolf} plus deterministic perturbations of them: every line removed in turn, CRLF line ends,
// a doubled section, cut-off text, and small hand-made documents for each parser branch. Full outputs are pinned for the fixtures; for the
// perturbation sweeps each case stores the first 16 hex of the sha256 of its full JSON output (a changed fingerprint names the case).
// NOT covered: the CLI ingest and read-through commands (test/superpowers-ingest.test.ts, test/openwolf-readthrough.test.ts).
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as SP from '../lib/integrations/superpowers.ts';
import * as OW from '../lib/integrations/openwolf.ts';
import { golden, outcome, normalise } from './helpers/golden-json.ts';

const G = (name: string, fn: () => unknown) => golden('integrations', name, outcome(fn));
const fp = (fn: () => unknown) => crypto.createHash('sha256').update(JSON.stringify(normalise(outcome(fn)))).digest('hex').slice(0, 16);
const FX = path.join(import.meta.dirname, 'fixtures');
const fx = (p: string) => fs.readFileSync(path.join(FX, p), 'utf8');
const PLAN_REL = 'docs/superpowers/plans/2026-11-20-widget-export.md';
const PLAN = fx('superpowers/plans/2026-11-20-widget-export.md'), LEDGER = fx('superpowers/ledger-7x/progress.md');
const NEG = fs.readdirSync(path.join(FX, 'superpowers/negative')).sort();
/** every line removed in turn (stepping to keep the sweep bounded), CRLF, doubled, truncated */
const perturb = (text: string, step = 1) => {
  const ls = text.split('\n'), out = ([] as Array<[string, string]>); // the sweep list, typed
  for (let i = 0; i < ls.length; i += step) out.push([`drop${i}`, [...ls.slice(0, i), ...ls.slice(i + 1)].join('\n')]);
  out.push(['crlf', text.replace(/\n/g, '\r\n')], ['double', text + '\n' + text], ['half', text.slice(0, Math.floor(text.length / 2))], ['empty', '']);
  return out;
};
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('superpowers: plan and ledger fixtures, negatives, ingest', () => {
  const plan = SP.parsePlan(PLAN, PLAN_REL), ledger = SP.parseLedger(LEDGER, 'progress.md');
  G('sp-plan', () => plan);
  G('sp-ledger', () => ledger);
  G('sp-ingest', () => SP.ingestPlan({ plan, ledger, owner: 'Ana', sprint: 2 }));
  const first = SP.ingestPlan({ plan, ledger });
  G('sp-reingest', () => SP.ingestPlan({ plan, ledger: null, existing: { tickets: first.tickets, edges: first.edges, findings: first.findings, refs: first.refs, schedule: [{ key: `sp:${plan.slug}/1`, owner: 'Ben', sprint: 3 }, { key: 'OTHER-1', owner: 'x', sprint: 1 }] } }));
  for (const n of NEG) G(`sp-neg-${n}`, () => { const t = fx(`superpowers/negative/${n}`); return { plan: outcome(() => SP.parsePlan(t, `docs/superpowers/plans/${n}`)), ledger: outcome(() => SP.parseLedger(t, n)), ingest: outcome(() => SP.ingestPlan({ plan, ledger: SP.parseLedger(t, n) })) }; });
  G('sp-identity', () => [SP.ledgerIdentity(LEDGER), SP.ledgerIdentity('\n\n# Plan: docs/x.md\n'), SP.ledgerIdentity('text\n# Plan: y'), SP.ledgerIdentity(''), SP.ledgerNamesPlan('docs/superpowers/plans/2026-11-20-widget-export.md', PLAN_REL), SP.ledgerNamesPlan('./2026-11-20-widget-export.md', PLAN_REL), SP.ledgerNamesPlan('other.md', PLAN_REL)]);
  G('sp-first-line', () => [SP.firstLineNamesPlan('Progress for 2026-11-20-widget-export.md', PLAN_REL, '2026-11-20-widget-export'), SP.firstLineNamesPlan(`see ${PLAN_REL} now`, PLAN_REL, 'x'), SP.firstLineNamesPlan('a-2026-11-20-widget-export.md', PLAN_REL, '2026-11-20-widget-export'), SP.firstLineNamesPlan('', PLAN_REL, 's'), SP.firstLineNamesPlan('docs/OTHER.md and plan.md', 'docs/plan.md', 'plan')]);
  G('sp-merge-ledgers', () => [SP.mergeLedgers([]), SP.mergeLedgers([ledger]), SP.mergeLedgers([ledger, SP.parseLedger(LEDGER.replace(/done/g, 'in progress'), 'b.md')])]);
});

test('superpowers: perturbation sweeps of the plan and the ledger', () => {
  G('sp-plan-sweep', () => perturb(PLAN, 1).map(([n, t]) => `${n} ${fp(() => SP.parsePlan(t, PLAN_REL))}`));
  G('sp-ledger-sweep', () => perturb(LEDGER, 1).map(([n, t]) => `${n} ${fp(() => SP.parseLedger(t, 'progress.md'))}`));
  const plan = SP.parsePlan(PLAN, PLAN_REL);
  G('sp-ingest-sweep', () => perturb(LEDGER, 2).map(([n, t]) => `${n} ${fp(() => SP.ingestPlan({ plan, ledger: SP.parseLedger(t, 'progress.md') }))}`));
  G('sp-limits', () => [
    fp(() => SP.parsePlan(Array.from({ length: 520 }, (_, i) => `### Task ${i + 1}: t${i}\nbody\n`).join('\n'), 'docs/superpowers/plans/big.md')),
    fp(() => SP.parsePlan(`### Task 1: ${'x'.repeat(300)}\n\`\`\`\ncode\n\`\`\`\n**Files:**\n- Create: \`a/b.js\`\n- Modify: \`../up.js\`\n`, 'docs/superpowers/plans/p.md')),
    fp(() => SP.parseLedger(Array.from({ length: 2100 }, (_, i) => `- Task ${i}: done`).join('\n'), 'big.md')),
  ]);
});

test('superpowers: files and ledger discovery', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spk-'))); made.push(root);
  const put = (rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const slug = '2026-11-20-widget-export';
  put(`.superpowers/sdd/${slug}-7x/plan-path`, `${PLAN_REL}\n`); put(`.superpowers/sdd/${slug}-7x/progress.md`, LEDGER);
  put(`.superpowers/sdd/${slug}-other/plan-path`, 'docs/superpowers/plans/other.md\n'); put(`.superpowers/sdd/${slug}-other/progress.md`, LEDGER);
  put(`.superpowers/sdd/${slug}-nomark/progress.md`, LEDGER);
  put('.superpowers/sdd/unrelated/plan-path', PLAN_REL);
  put('.superpowers/sdd/progress.md', 'no identity here\n- Task 1: done\n');
  const wt = path.join(root, 'wt'); fs.mkdirSync(path.join(wt, '.superpowers/sdd'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.superpowers/sdd/progress.md'), `# Plan: ${PLAN_REL}\n- Task 1: done\n`);
  const rel = (xs: SP.FoundLedger[]) => xs.map((x) => ({ ...x, path: path.relative(root, x.path), root: path.relative(root, x.root) || '.' }));
  const warnings: string[] = [];
  G('sp-find', () => ({ found: rel(SP.findLedgers(root, { planSlug: slug, planPath: PLAN_REL, worktrees: [wt, root], warnings })), warnings }));
  G('sp-find-no-path', () => rel(SP.findLedgers(root, { planSlug: slug, worktrees: [wt] })));
  G('sp-find-none', () => rel(SP.findLedgers(path.join(root, 'nowhere'), { planSlug: slug })));
  G('sp-read', () => [outcome(() => SP.readSpFile(path.join(root, '.superpowers/sdd/progress.md'), { max: 1000 }).length), outcome(() => SP.readSpFile(path.join(root, '.superpowers/sdd/progress.md'), { max: 5 })), outcome(() => SP.readSpFile(path.join(root, 'nope.md'), { max: 5 })), outcome(() => SP.readSpFile(path.join(root, '.superpowers'), { max: 5 }))]);
});

test('openwolf: parsers on fixtures, sweeps and hand-made documents', () => {
  for (const f of ['cerebrum.template.md', 'cerebrum.drifted.md']) G(`ow-${f}`, () => OW.parseCerebrum(fx(`openwolf/${f}`)));
  for (const f of ['status.template.md', 'status.drifted.md', 'status.handoff.md']) G(`ow-${f}`, () => OW.parseStatus(fx(`openwolf/${f}`)));
  G('ow-cerebrum-sweep', () => perturb(fx('openwolf/cerebrum.drifted.md'), 1).map(([n, t]) => `${n} ${fp(() => OW.parseCerebrum(t))}`));
  G('ow-status-sweep', () => perturb(fx('openwolf/status.handoff.md'), 1).map(([n, t]) => `${n} ${fp(() => OW.parseStatus(t))}`));
  G('ow-scan', () => [OW.scanKeys('see ABC-12, sp:plan/3 and `x/y.js`; T-1 T-1'), OW.scanKeys(''), OW.scanKeys(`${Array.from({ length: 30 }, (_, i) => `K-${i}`).join(' ')} ${'Z'.repeat(130)}-1`), OW.scanKeys(fx('openwolf/status.handoff.md'))]);
  const idx = fx('openwolf/anatomy-index.v1.json');
  G('ow-anatomy', () => [OW.readAnatomyIndex(idx) !== null, OW.readAnatomyIndex('{bad'), OW.readAnatomyIndex({ version: 2, files: {} }), OW.readAnatomyIndex({ version: 1, files: [] }), OW.readAnatomyIndex({ version: 1, files: null }), OW.readAnatomyIndex([1]), OW.readAnatomyIndex(null)]);
  const files = Object.keys(JSON.parse(idx).files).slice(0, 3);
  G('ow-lookup', () => [
    OW.anatomyLookup([...files, `./${files[0]}`, '../etc/passwd', 'lib/pay', 'lib/pay/', 'missing.js'], idx, { listFiles: (/** @type {string[]} */ ps) => ps.filter((p) => p !== 'missing.js').map((p) => (p.startsWith('lib/pay') ? 'lib/pay/x.js' : p)) }),
    OW.anatomyLookup(['a.js'], null, { listFiles: () => { throw new Error('git failed'); } }),
    OW.anatomyLookup('not an array', idx),
    OW.anatomyLookup(['a.js'], { version: 1, files: { 'a.js': { description: '   ' }, 'b.js': 'str' } }),
  ]);
  const parsed = OW.parseCerebrum(fx('openwolf/cerebrum.drifted.md'));
  G('ow-rules', () => [OW.repoRuleList(parsed), OW.renderRepoRules(parsed), OW.renderRepoRules(parsed, { max: 2, entryMax: 20 }), OW.renderRepoRules({ doNotRepeat: [], keyLearnings: [] }), OW.renderRepoRules(null), OW.handleOf('  a  rule '), OW.fenceWolf('lbl', 'body\nline')]);
  G('ow-rules-order', () => OW.repoRuleList({ doNotRepeat: [{ text: 'a', date: '2026-01-02' }, { text: 'b' }, { text: 'c', date: '2026-03-01' }, { text: 'd', date: '2026-01-02' }, { text: 'e' }], keyLearnings: [{ text: 'k1' }, { text: 'k2', date: '2025-12-31' }] }));
});

test('openwolf: reading files with every refusal', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owk-'))); made.push(root);
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owk-out-'))); made.push(out);
  const r = (rt: string, n: string) => OW.readWolfFile(rt, n);
  const res: unknown[] = [r(root, 'STATUS.md')];
  fs.mkdirSync(path.join(root, '.wolf'));
  fs.writeFileSync(path.join(root, '.wolf', 'STATUS.md'), 'ok');
  fs.mkdirSync(path.join(root, '.wolf', 'cerebrum.md'));
  fs.symlinkSync(path.join(root, '.wolf', 'STATUS.md'), path.join(root, '.wolf', 'anatomy-index.json'));
  res.push(r(root, 'STATUS.md'), r(root, 'cerebrum.md'), r(root, 'anatomy-index.json'), outcome(() => r(root, 'other.md')));
  const big = path.join(out, 'big'); fs.mkdirSync(path.join(big, '.wolf'), { recursive: true });
  const fd = fs.openSync(path.join(big, '.wolf', 'STATUS.md'), 'w'); fs.ftruncateSync(fd, 1024 * 1024 + 1); fs.closeSync(fd);
  res.push(r(big, 'STATUS.md'));
  const asFile = path.join(out, 'asfile'); fs.mkdirSync(asFile); fs.writeFileSync(path.join(asFile, '.wolf'), 'x');
  res.push(r(asFile, 'STATUS.md'));
  const linked = path.join(out, 'linked'); fs.mkdirSync(linked); fs.symlinkSync(path.join(root, '.wolf'), path.join(linked, '.wolf'));
  res.push(r(linked, 'STATUS.md'));
  G('ow-read', () => res);
});

test('superpowers: parked-line shapes, identity tokens, a symbol produced by two earlier tasks', () => {
  const parked = ['parked — a thing — Ruling: do x', 'parked—x — Ruling: y', 'parked —x — Ruling: y', 'parked — x Ruling: y', 'parked — x - Ruling: y', 'parked — x — Ruling:', 'parked — x —  Ruling: z — Ruling: w',
    'PARKED -- text -- ruling: lower', 'parked — — Ruling: empty text', 'parkedx — a — Ruling: b', 'parked — a —Ruling: b', 'parked — a — Ruling: ', 'parked — a\t—\tRuling:\tt'];
  G('sp-parked', () => SP.parseLedger(parked.map((b, i) => `Task ${i + 1}: ${b}`).join('\n'), 'p.md'));
  G('sp-tokens', () => [['plan.md and more', 'docs/plan.md', 'plan'], ['(plan.md)', 'docs/plan.md', 'plan'], ['x/plan.md', 'docs/plan.md', 'plan'], ['plan.md.bak', 'docs/plan.md', 'plan'], ['`docs/plan.md`', 'docs/plan.md', 'x'], ['"docs/plan.md"', 'docs/plan.md', 'x'], ['see a/docs/plan.md', 'docs/plan.md', 'x'], ['plan.md plan.md-old', 'docs/plan.md', 'plan']].map(([t, p, s]) => SP.firstLineNamesPlan(t, p, s)));
  G('sp-identity-lines', () => ['# Plan: docs/a.md', '# Progress for `docs/superpowers/plans/x.md` (7.x)', '# Ledger — see docs/a.md, docs/b.md and docs/c.md', '#  plan .md', '# notes about notes.md and plans', '# x.md y.md'].map((l) => SP.ledgerIdentity(`${l}\n- Task 1: done`)));
  const twice = '# P\n\n### Task 1: A\n\nProduces `Widget`.\n\n### Task 2: B\n\nAlso produces `Widget`.\n\n### Task 3: C\n\nUses `Widget` from earlier tasks.\n';
  G('sp-two-producers', () => SP.parsePlan(twice, 'docs/superpowers/plans/twice.md'));
});

test('openwolf: size caps are exact (1 MiB for the markdown files, 20 MiB for the anatomy index), long entries and keys are cut', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owcap-'))); made.push(root);
  fs.mkdirSync(path.join(root, '.wolf'));
  const size = (name: string, n: number) => { const fd = fs.openSync(path.join(root, '.wolf', name), 'w'); fs.ftruncateSync(fd, n); fs.closeSync(fd); return OW.readWolfFile(root, name); };
  G('ow-caps', () => [size('STATUS.md', 1024 * 1024).ok, size('STATUS.md', 1024 * 1024 + 1), size('cerebrum.md', 1024 * 1024).ok, size('anatomy-index.json', 20 * 1024 * 1024).ok, size('anatomy-index.json', 20 * 1024 * 1024 + 1)]);
  G('ow-long-entry', () => OW.parseCerebrum(`## Key Learnings\n\n- ${'w '.repeat(1500)}end\n`).keyLearnings.map((e) => e.text.length));
  G('ow-long-keys', () => OW.scanKeys(`${'A'.repeat(118)}-1 ${'B'.repeat(119)}-12 ${'C'.repeat(130)}-3 sp:${'s'.repeat(120)}/1`));
});
