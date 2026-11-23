// Characterization goldens for lib/render.mjs (test/golden/mutation-kills/render.json, UPDATE_GOLDEN=1 rewrites), written to kill mutants
// that survived scripts/mutate-all.mjs: bound() defaults, table cells, budget() at every token limit around its edges (including a
// single line too long for any marker), outputMode, and the session card at every budget from 1 to 260 tokens for a model with ties in
// verdicts and findings, over-cap rows, one person, no sprints and a stale index. Names are invented.
// NOT covered: the card in the CLI (test/contract.test.mjs, test/golden.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bound, table, budget, outputMode, renderCard, estTokens, CARD_BUDGET } from '../lib/render.mjs';
import { buildModel } from '../lib/model.mjs';
import { fenceInline } from '../lib/sanitize.mjs';
import { golden, outcome } from './helpers/golden-json.mjs';

const G = (/** @type {string} */ name, /** @type {() => unknown} */ fn) => golden('render', name, outcome(fn));

test('bound, table, outputMode', () => {
  const many = Array.from({ length: 25 }, (_, i) => `l${i}`);
  G('bound-default', () => bound(many));
  G('bound-20', () => bound(many.slice(0, 20)));
  G('bound-21', () => bound(many.slice(0, 21)));
  G('table', () => table([{ a: 'x|y', b: '  two\n lines ', c: null }, { a: 0, b: undefined, c: 'z' }], ['a', 'b', 'c']));
  G('table-no-header', () => table([{ a: 1 }], ['a'], { header: false }));
  G('mode', () => [outputMode(['-v', 'x', '--json']), outputMode(['--verbose', '', '-vv']), outputMode([])]);
});

test('budget at every limit around its edges', () => {
  const text = Array.from({ length: 12 }, (_, i) => `line number ${i} ${'x'.repeat(i * 3)}`).join('\n');
  G('budget-sweep', () => Array.from({ length: 70 }, (_, k) => budget(text, k)));
  G('budget-exact-fit', () => { const t = 'abcdefg'; return [budget(t, estTokens(t + '\n')), budget(t, estTokens(t + '\n') - 1)]; });
  G('budget-one-long-line', () => [1, 2, 3, 10].map((k) => budget('y'.repeat(200), k)));
});

const rich = () => buildModel({
  tickets: [
    { key: 'A', sp: 8, verdict: 'READY' }, { key: 'B', sp: 5, verdict: 'BLOCKED' }, { key: 'C', sp: 5, verdict: 'READY' }, { key: 'D', sp: 3, verdict: 'BLOCKED' },
    { key: 'E', sp: 2 }, { key: 'F', sp: 9, verdict: 'a-very-long-verdict-name-beyond-twenty' }, { key: 'G', sp: 1, verdict: 'NEEDS' }, { key: 'H', sp: 1, verdict: 'ZED' }, { key: 'I', sp: 1, verdict: 'ALPHA' },
  ],
  edges: [{ consumer: 'B', producer: 'A' }, { consumer: 'C', producer: 'A' }],
  schedule: [
    { key: 'A', owner: 'Ana', sprint: 2 }, { key: 'B', owner: 'Ana', sprint: 2 }, { key: 'C', owner: 'Ben', sprint: 4 }, { key: 'D', owner: 'Ben', sprint: 4 },
    { key: 'E', owner: 'Cleo-with-a-long-name', sprint: 3 }, { key: 'F', owner: 'Cleo-with-a-long-name', sprint: 3 }, { key: 'G', owner: 'Dan', sprint: 5 }, { key: 'H', owner: 'Dan', sprint: 1 }, { key: 'I', owner: 'Eva', sprint: 'x' },
  ],
  config: { caps: { default: 7, Ben: 7 } },
  findings: [{ key: 'A', kind: 'risk' }, { key: 'B', kind: 'risk' }, { key: 'C', kind: 'question' }, { key: 'D', kind: 'question' }, { key: 'E', kind: 'blocker' }, { key: 'F', kind: 'zz' }],
});

test('session card at every budget, stale and fresh', () => {
  const m = rich();
  G('card-default', () => renderCard(m, { fp: 'ABCDEF0123456789zz' }));
  G('card-sweep', () => Array.from({ length: 52 }, (_, k) => renderCard(m, { fp: '0123456789abcdef' }, { maxTokens: 1 + k * 5 })));
  G('card-sweep-stale', () => Array.from({ length: 30 }, (_, k) => renderCard(m, { fp: 'deadbeef', stale: true }, { maxTokens: 1 + k * 3 })));
  G('card-one-person-no-sprints', () => renderCard(buildModel({ tickets: [{ key: 'A' }], schedule: [{ key: 'A', owner: 'Ana', sprint: null }] }), {}));
  G('card-empty', () => renderCard(buildModel({}), { stale: 'yes' }));
  G('card-one-sprint', () => renderCard(buildModel({ tickets: [{ key: 'A', sp: 1 }, { key: 'B', sp: 1 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 3 }, { key: 'B', owner: 'Ben', sprint: 3 }] }), {}));
  assert.equal(CARD_BUDGET, 250);
  assert.ok(estTokens(renderCard(m, {}) + '\n') <= 250);
});

test('budget counts the trailing newline: a text of exactly 4k characters needs k+1 tokens', () => {
  assert.deepEqual(budget('abcdefgh', 3), { text: 'abcdefgh', truncated: false, omitted: 0 });
  assert.equal(budget('abcdefgh', 2).truncated, true);
});

test('card: verdict and finding names are cut at 20 characters; a ticket without story points adds 0 load', () => {
  const m = buildModel({ tickets: [{ key: 'A', sp: 0, verdict: 'v'.repeat(30) }, { key: 'B', verdict: 'v'.repeat(30) }, { key: 'C', sp: 2 }], schedule: [{ key: 'A', owner: 'Ana', sprint: 1 }, { key: 'B', owner: 'Ana', sprint: 1 }, { key: 'C', owner: 'Ana', sprint: 1 }], config: { caps: { default: 2 } }, findings: [{ key: 'A', kind: 'k'.repeat(30) }] });
  const card = renderCard(m, {});
  assert.ok(card.includes(`verdicts: ${fenceInline(`2 ${'v'.repeat(20)}, 1 unrated`)}`), card);
  assert.ok(card.includes(`findings: ${fenceInline(`${'k'.repeat(20)} 1`)}`), card);
  assert.ok(card.includes('over cap: none'), 'two points on a cap of two is not over: the 0-point and point-less tickets add nothing');
});

test('card: over-cap rows order by excess, then owner, then sprint, and show the top 3', () => {
  const rows = [['Zoe', 1, 5], ['Ana', 2, 5], ['Ana', 1, 5], ['Ben', 1, 9], ['Cy', 1, 4]];
  const m = buildModel({ tickets: rows.map(([o, s, sp]) => ({ key: `${o}${s}`, sp })), schedule: rows.map(([o, s]) => ({ key: `${o}${s}`, owner: o, sprint: s })), config: { caps: { default: 3 } } });
  assert.ok(renderCard(m, {}).includes(`over cap: ${fenceInline('Ben S1 +6, Ana S1 +2, Ana S2 +2, +2 more')}`), renderCard(m, {}));
});

test('card: the budget counts the trailing newline, and lines are dropped from the least important', () => {
  for (let n = 1; n <= 12; n++) {
    const m = buildModel({ tickets: Array.from({ length: n }, (_, i) => ({ key: `K${i}`, sp: 1, verdict: i % 2 ? 'READY' : 'NEEDS' })), schedule: Array.from({ length: n }, (_, i) => ({ key: `K${i}`, owner: 'Ana', sprint: 1 + i })), findings: [{ key: 'K0', kind: 'risk' }] });
    const all = renderCard(m, {}, { maxTokens: 1000 });
    assert.equal(renderCard(m, {}, { maxTokens: estTokens(all + '\n') }), all, `n=${n}: an exact fit is kept whole`);
    assert.notEqual(renderCard(m, {}, { maxTokens: estTokens(all + '\n') - 1 }), all, `n=${n}: one token less drops something`);
  }
  G('card-fine-sweep', () => Array.from({ length: 80 }, (_, k) => renderCard(rich(), { fp: 'abc' }, { maxTokens: k + 1 })));
});

test('card: over-cap rows of one owner order by sprint whatever order they were met', () => {
  const rows = [['Ana', 1, 5], ['Ana', 2, 5], ['Ana', 3, 5]];
  const m = buildModel({ tickets: rows.map(([o, s, sp]) => ({ key: `${o}${s}`, sp })), schedule: rows.map(([o, s]) => ({ key: `${o}${s}`, owner: o, sprint: s })), config: { caps: { default: 3 } } });
  assert.ok(renderCard(m, {}).includes(`over cap: ${fenceInline('Ana S1 +2, Ana S2 +2, Ana S3 +2')}`), renderCard(m, {}));
});
