// Characterization goldens for lib/stale.ts (test/golden/mutation-kills/stale.json, UPDATE_GOLDEN=1 rewrites), written to kill mutants
// that survived scripts/mutate-all.ts: canonical JSON, plan normalization and sections, fingerprints with every input available or
// not, computeStale over chains, a cycle, legacy rows, recorded producer digests, refsUpdate (fresh rows, kept fields, skipped keys),
// formatStale in every mode, and the git adapter (caching, absent-path classification, errors that must propagate) through an
// injected git function. All keys, paths and texts are invented.
// NOT covered: real git (test/stale.test.ts runs it); the from-scratch equivalence proof (test/stale.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canon, normalizePlanText, planSection, resolveRef, fingerprintTicket, computeStale, refsUpdate, staleKeys, formatStale, gitDeps } from '../lib/stale.ts';
import { buildModel } from '../lib/model.ts';
import { golden, outcome } from './helpers/golden-json.ts';

const G = (name: string, fn: () => unknown) => golden('stale', name, outcome(fn));
const PLAN = '# Plan\r\n\r\n## Task 1: one  \r\nbuild a\t\n\n### Task 2: two\nbuild b\n## Task 2.1: sub\nx\n#### Task 3: deep\n\n\n';

test('canon, normalization, sections, refs', () => {
  G('canon', () => [canon({ b: [1, { d: undefined, c: 2 }], a: null }), canon(undefined), canon([]), canon('s'), canon({})]);
  G('normalize', () => [normalizePlanText(PLAN), normalizePlanText('﻿a \t\r\rb\n\n'), normalizePlanText(undefined), normalizePlanText(`x${' '.repeat(5)}y   `)]);
  G('sections', () => [planSection(PLAN, '1'), planSection(PLAN, '2.p3'), planSection(PLAN, '2.1'), planSection(PLAN, '3'), planSection(PLAN, '9'), planSection(PLAN, '3', '#### Task {id}:'), planSection('Task 1: a\nTask 2: b', '1', 'Task {id}:')]);
  G('refs', () => [resolveRef({ default_ref: 'main' }, ''), resolveRef({}, 'v1'), resolveRef(null, ''), outcome(() => resolveRef({}, '-x'))]);
});

/** @param {Record<string, string | null>} plans @param {Record<string, string>} tree @param {Record<string, unknown> | null} [jira] @param {Record<string, unknown> | null} [links] */
const deps = (plans: Record<string, string>, tree: Record<string, string>, jira: Record<string, unknown> | null = null, links: Record<string, readonly unknown[]> | null = null) => ({
  readPlanText: (_ref: string | null | undefined, p: string) => plans[p] ?? null,
  listFiles: (_ref: string | null | undefined, ps: string[]) => Object.fromEntries(ps.map((p) => [p, tree[p] ?? null])),
  ...(jira ? { jiraStamp: (k: string) => jira[k] ?? null } : {}),
  ...(links ? { linkSet: (k: string) => links[k] ?? null } : {}),
});

test('fingerprints with and without each optional input', () => {
  const row = { key: 'A', plans: [{ plan: 'p.md', task: '1' }, { plan: 'gone.md', task: '1' }, { plan: 'p.md', task: '7' }], files: { 'b.js': 1, 'a.js': 1 } };
  const d = deps({ 'p.md': PLAN }, { 'a.js': 'h1' }, { A: 5 }, { A: ['X', { k: 1 }, 'X'] });
  G('fp-full', () => fingerprintTicket(row, d, { ref: 'HEAD', rulesVersion: 3 }));
  G('fp-bare', () => fingerprintTicket({ key: 'A' }, deps({}, {})));
  G('fp-heading', () => fingerprintTicket(row, d, { heading: '^## Task {id}:' }));
  G('fp-null-tree', () => fingerprintTicket({ key: 'A', files: { 'a.js': 1 } }, { ...deps({}, {}), listFiles: () => null }));
  G('fp-jira-zero', () => fingerprintTicket({ key: 'A' }, deps({}, {}, { A: 0 }, { A: [] })));
});

// A -> B -> C chain (B needs A, C needs B), D <-> E cycle, F legacy row with a producer, G not in tickets but a producer of H.
const model = () => buildModel({
  tickets: ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'Z'].map((key) => ({ key })),
  edges: [{ consumer: 'B', producer: 'A' }, { consumer: 'C', producer: 'B' }, { consumer: 'D', producer: 'E' }, { consumer: 'E', producer: 'D' }, { consumer: 'F', producer: 'A' }, { consumer: 'H', producer: 'G' }, { consumer: 'B', producer: 'A' }],
});

test('computeStale and refsUpdate over chains, a cycle, legacy rows and recorded producer digests', () => {
  const m = model();
  const d0 = deps({ 'p.md': PLAN }, { 'a.js': 'h1' }, { A: 1, B: 2 }, { A: ['x'] });
  const rows0 = ['A', 'B', 'C', 'D', 'E', 'G', 'H'].map((key) => ({ key, plans: [{ plan: 'p.md', task: key === 'A' ? '1' : '2' }], files: { 'a.js': 1 } }));
  const fresh = refsUpdate(m, rows0, d0, { rulesVersion: 1, commit: 'c0ffee' }, ['A', 'B', 'C', 'D', 'E', 'G', 'H', 'NOPE']);
  G('refs-update-fresh', () => fresh);
  const legacy = { key: 'F', plans: [], files: {} };
  const rows = [...fresh.rows, legacy];
  G('stale-clean', () => computeStale(m, rows, d0, { rulesVersion: 1, ref: 'HEAD' }));
  const d1 = deps({ 'p.md': PLAN.replace('build a', 'build A') }, { 'a.js': 'h1' }, { A: 1, B: 3 }, { A: ['x', 'y'] });
  const res = computeStale(m, rows, d1, { rulesVersion: 1, ref: 'main' });
  G('stale-changed', () => res);
  G('stale-rules', () => computeStale(m, rows, d0, { rulesVersion: 2 }));
  G('stale-full', () => computeStale(m, rows, d0, { rulesVersion: 1, full: true }));
  G('stale-unavailable', () => computeStale(m, rows, deps({ 'p.md': PLAN }, { 'a.js': 'h1' })));
  G('stale-files', () => computeStale(m, rows, deps({ 'p.md': PLAN }, { 'a.js': 'h2' }, { A: 1, B: 2 }, { A: ['x'] }), { rulesVersion: 1 }));
  G('stale-model-refs-default', () => computeStale(buildModel({ tickets: [{ key: 'A' }], refs: [{ key: 'A', plans: [], files: {}, fp_files: 'old' }] }), null, deps({}, {})));
  const swapped = rows.map((r) => (r.key === 'C' ? { ...r, fp_prods: { Q: 'x' } } : r));
  G('stale-fp-prods-mismatch', () => computeStale(m, swapped, d0, { rulesVersion: 1 }));
  G('stale-keys', () => [staleKeys(res), staleKeys(res, new Set(['B', 'C']))]);
  G('refs-update-default-keys', () => refsUpdate(m, rows, d1, { rulesVersion: 1 }));
  G('refs-update-keep', () => refsUpdate(m, [{ key: 'A', plans: [], files: {}, rules: 'r9', fp_links: 'l9', jira_updated: 'j9', audited_at: 'old', extra: 1, z: 2 }], deps({}, {}), {}, ['A']));
});

test('formatStale in every mode', () => {
  const res = { ref: 'main', clean: 3, stale: [{ key: 'A', reasons: ['plan', 'files'], via: null }, { key: 'B', reasons: ['producer_changed'], via: 'A' }, { key: 'C<x>', reasons: ['jira'], via: 'B\nfake' }] };
  G('format', () => [formatStale(res), formatStale(res, { commit: 'abc', jiraChecked: false, linksChecked: false }), formatStale(res, { list: true }), formatStale(res, { list: true, limit: 1 }),
    formatStale(res, { json: true, commit: 'abc' }), formatStale(res, { json: true }), formatStale({ ref: 'HEAD', clean: 0, stale: [] }), formatStale({ ref: 'HEAD', clean: 2, stale: [] }, { jiraChecked: false })]);
});

test('git adapter through an injected git: caching, absent paths, errors that must propagate', () => {
  const calls: string[][] = [];
  const fail = (stderr: string, extra = {}) => Object.assign(new Error('git failed'), { status: 128, stderr, ...extra });
  const git = (...a: string[]) => {
    calls.push(a);
    if (a[0] === 'ls-tree') return '100644 blob aaa111\tsrc/a.js\n100644 blob bbb222\tdocs/p.md\n040000 tree ccc\tsrc\n';
    if (a[0] === 'rev-parse') return 'abc1234\n';
    const spec = a[2];
    if (spec.endsWith(':docs/p.md')) return PLAN;
    if (spec.endsWith(':gone.md')) throw fail("fatal: path 'gone.md' does not exist in 'HEAD'\n");
    if (spec.endsWith(':disk.md')) throw fail("fatal: path 'disk.md' exists on disk, but not in 'HEAD'\n");
    if (spec.endsWith(':badref.md')) throw fail("fatal: invalid object name 'nope'.\n");
    if (spec.endsWith(':echo.md')) throw fail("error: something about path 'x' does not exist in it\n");
    if (spec.endsWith(':old.md')) throw fail("error: unknown option `end-of-options'\nfatal: path 'old.md' does not exist in 'HEAD'\n");
    if (spec.endsWith(':timeout.md')) throw fail("fatal: path 'timeout.md' does not exist in 'HEAD'\n", { code: 'ETIMEDOUT' });
    if (spec.endsWith(':signal.md')) throw fail("fatal: path 'signal.md' does not exist in 'HEAD'\n", { signal: 'SIGTERM' });
    if (spec.endsWith(':nostatus.md')) throw Object.assign(new Error("fatal: path 'nostatus.md' does not exist in 'HEAD'"), {});
    if (spec.endsWith(':msg.md')) throw Object.assign(new Error("fatal: path 'msg.md' does not exist in 'HEAD'"), { status: 128 });
    throw new Error(`unexpected ${a.join(' ')}`);
  };
  const d = gitDeps('/repo', 'main', { git, jira: { A: { updated: 'u1', links: ['B'], status: 'Done' }, B: { blockedBy: ['C'] } } });
  G('git-read', () => [d.readPlanText(undefined, 'docs/p.md'), d.readPlanText('main', 'docs/p.md'), d.readPlanText('v2', 'gone.md'), d.readPlanText(null, 'disk.md'), d.readPlanText(null, 'msg.md')]);
  G('git-errors', () => ['badref.md', 'echo.md', 'old.md', 'timeout.md', 'signal.md', 'nostatus.md'].map((p) => outcome(() => d.readPlanText(null, p))));
  G('git-paths', () => [outcome(() => d.readPlanText(null, '/etc/passwd')), outcome(() => d.readPlanText('-bad', 'docs/p.md'))]);
  G('git-files', () => [d.listFiles(null, ['src/a.js', 'src', 'missing']), d.listFiles('main', ['docs/p.md'])]);
  G('git-jira', () => [d.jiraStamp('A'), d.jiraStamp('B'), d.jiraStamp('Z'), d.linkSet('A'), d.linkSet('B'), d.linkSet('Z'), d.status('A'), d.status('B'), d.status('Z')]);
  G('git-commit', () => [d.commit(), d.commit('main'), d.commit('v2')]);
  G('git-calls', () => calls);
  const none = gitDeps('/repo', '', { git: () => '' });
  G('git-no-jira', () => [none.jiraStamp('A'), none.linkSet('A'), none.status('A'), none.listFiles(undefined, ['x'])]);
  assert.equal(calls.filter((c) => c[0] === 'ls-tree').length, 1, 'ls-tree cached per ref');
});

// A deeper graph: a three-deep chain whose root key sorts first (one long DFS), a three-cycle, a consumer with two producers at different
// distances, a producer without a refs row, a ticket without a refs row consuming a changed producer, a non-ticket producer, and a row
// with two plans. Plans are sections of one plan file; `edit` changes the text of chosen tasks.
const DEEP_EDGES = [['P1', 'P2'], ['P2', 'P3'], ['C1', 'C2'], ['C2', 'C3'], ['C3', 'C1'], ['X', 'ZP'], ['X', 'Q'], ['Q', 'R'], ['NN', 'N'], ['Y', 'NR'], ['W', 'R'], ['GHOSTC', 'P'], ['N', 'M'], ['N', 'K'], ['H2', 'G2']];
const DEEP_ROWS = ['P1', 'P2', 'P3', 'C1', 'C2', 'C3', 'X', 'ZP', 'R', 'Y', 'M', 'N', 'NN', 'K', 'G2', 'H2'];
const deepModel = () => buildModel({ tickets: [...DEEP_ROWS.filter((k) => k !== 'G2'), 'NR', 'W', 'Q'].map((key) => ({ key })), edges: DEEP_EDGES.map(([consumer, producer]) => ({ consumer, producer })) });
const deepPlan = (edit: string[]) => DEEP_ROWS.map((k) => `## Task ${k}: t\nbody of ${k}${edit.includes(k) ? ' (edited)' : ''}\n`).join('\n') + '## Task M2: second\nmore\n';
const deepRows = () => DEEP_ROWS.map((key) => ({ key, plans: key === 'M' ? [{ plan: 'p.md', task: 'M' }, { plan: 'p.md', task: 'M2' }] : [{ plan: 'p.md', task: key }], files: {} }));
const heading = '^## Task {id}:';

test('deeper graphs: chains, cycles, distances, rows without producers rows, partial refresh, recorded producer sets', () => {
  const m = deepModel(), d0 = deps({ 'p.md': deepPlan([]) }, {}, { P1: 's', X: '' }, {});
  const fresh = refsUpdate(m, deepRows(), d0, { heading, commit: 'c1' }, DEEP_ROWS);
  G('deep-fresh', () => fresh);
  const edited = deps({ 'p.md': deepPlan(['P3', 'C3', 'R', 'ZP', 'G2', 'K']) }, {}, { P1: 's', X: '' }, {});
  G('deep-stale', () => computeStale(m, fresh.rows, edited, { heading }));
  const partial = refsUpdate(m, fresh.rows, edited, { heading }, ['P3', 'C3', 'R', 'ZP', 'G2', 'K', 'P2', 'C1', 'C2']);
  G('deep-partial', () => computeStale(m, partial.rows, edited, { heading }));
  const noJiraField = fresh.rows.map((r) => (r.key === 'X' ? (({ jira_updated, ...rest }) => rest)(r) : r));
  G('deep-jira-empty', () => computeStale(m, noJiraField, d0, { heading }));
  const recorded = fresh.rows.map((r) => (r.key === 'X' ? { ...r, fp_prods: { A0: 'x', ZP: (r.fp_prods as Record<string, string>).ZP, Q: (r.fp_prods as Record<string, string>).Q } } : r)); // refsUpdate wrote fp_prods for this row
  G('deep-recorded-extra', () => computeStale(m, recorded, d0, { heading }));
  const m2 = buildModel({ tickets: ['T', 'ab', 'c'].map((key) => ({ key })), edges: [{ consumer: 'T', producer: 'ab' }, { consumer: 'T', producer: 'c' }] });
  G('deep-recorded-joined', () => computeStale(m2, [{ key: 'T', plans: [], files: {}, fp_files: fingerprintTicket({ key: 'T' }, deps({}, {})).fp_files, fp_prods: { a: 'x', bc: 'y' } }], deps({}, {})));
  G('deep-model-refs', () => refsUpdate(buildModel({ tickets: [{ key: 'A' }], refs: [{ key: 'A', plans: [], files: {} }] }), /** @type {any} */ (null), deps({}, {}), {}, ['A']));
  G('refs-update-extra-order', () => refsUpdate(buildModel({}), [{ key: 'A', plans: [], files: {}, aa: 1, zz: 2, audited_at: 'x' }], deps({}, {}), {}, ['A']).rows);
});

test('normalization and sections at their edges; formatStale list limits', () => {
  G('normalize-blank-line', () => normalizePlanText('a\n \nb\n\t\n'));
  G('section-adjacent', () => [planSection('Task 1:Task 2: b', '1', 'Task {id}:'), planSection('x Task 1: a Task 2: b', '1', 'Task {id}:')]);
  const res = { ref: 'HEAD', clean: 0, stale: Array.from({ length: 45 }, (_, i) => ({ key: i === 0 ? 'K'.repeat(130) : `K-${i}`, reasons: ['plan'], via: i === 1 ? 'V'.repeat(130) : null })) };
  G('format-limit', () => formatStale(res, { list: true }));
  G('format-limit-exact', () => formatStale({ ...res, stale: res.stale.slice(0, 40) }, { list: true }).split('\n').slice(-3));
});

test('git adapter cache keys keep ref and path apart', () => {
  const git = (...a: string[]) => { if (a[0] === 'show') return `text of ${a[2]}`; return ''; };
  const d = gitDeps('/repo', 'main', { git });
  assert.deepEqual([d.readPlanText('v1', 'p.md'), d.readPlanText('v2', 'p.md'), d.readPlanText('a', 'bc'), d.readPlanText('ab', 'c')], ['text of v1:p.md', 'text of v2:p.md', 'text of a:bc', 'text of ab:c']);
});
