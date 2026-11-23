// Grammar-fuzz goldens for the markdown parsers (test/golden/mutation-kills/grammar-fuzz.json, UPDATE_GOLDEN=1 rewrites): a seeded
// generator assembles documents from the constructs the parsers look at (front matter, headings at levels 1-4, the sections they know,
// bullets and numbered items with every marker, dates, indented continuations, fences of both kinds and their indentation, HTML comments
// across lines, template placeholders, trailing ellipses, Jira keys, sp: task keys and paths, tabs and CR line ends) and pins a short
// fingerprint of each parse. Written to kill mutants of lib/integrations/openwolf.mjs and lib/integrations/superpowers.mjs that survived
// scripts/mutate-all.mjs; a changed fingerprint names the document (rerun with UPDATE_GOLDEN=1 only after reviewing the change).
// The fingerprints pin behavior, they do not prove it right (the parser tests argue correctness).
import { test } from 'node:test';
import crypto from 'node:crypto';
import { parseCerebrum, parseStatus, scanKeys } from '../lib/integrations/openwolf.mjs';
import { parsePlan, parseLedger, ledgerIdentity, firstLineNamesPlan } from '../lib/integrations/superpowers.mjs';
import { rng } from './fixtures/gen.mjs';
import { golden, normalise, outcome } from './helpers/golden-json.mjs';

const fp = (/** @type {() => unknown} */ fn) => crypto.createHash('sha256').update(JSON.stringify(normalise(outcome(fn)))).digest('hex').slice(0, 12);
/** @param {() => number} r @param {readonly string[]} a */
const pick = (r, a) => a[Math.floor(r() * a.length)];

const WORDS = ['use', 'migrations', 'never', 'the', 'store', 'config', 'SHOP-12', 'ABC-1', 'sp:plan-x/3', 'sp:a-b/12', '`lib/pay/x.ts`', 'lib/a-b_c.', 'ok:', '**bold**', 'x---y', 'T-1.', 'AB-12a', 'a-ABC-3', 'Z9-0', 'see...', 'wait…', '{{tpl}}', '<_fill_>', 'id=7', 'A', '>'];
const LEAD = ['- ', '* ', '+ ', '1. ', '2) ', '10. ', '1234567890. ', '-', '  - ', '    - ', '\t- ', ''];
const HEAD = ['# Cerebrum', '## User Preferences', '## Key Learnings', '## Do-Not-Repeat', '## Decision Log', '### Open decisions', '## 🚀 Next quest', '## ✅ Done', '## Context', '#### deep', '###no-space', '## Notes'];
/** one generated line @param {() => number} r */
const line = (r) => {
  const k = r();
  if (k < 0.12) return pick(r, HEAD);
  if (k < 0.16) return pick(r, ['```', '~~~', '   ```', '    ```', '```js']);
  if (k < 0.2) return pick(r, ['<!-- note -->', '<!-- open', 'close -->', 'x <!-- a --> y <!-- b', '-->']);
  if (k < 0.23) return pick(r, ['---', '> quote', '| a | b |', '']);
  const date = r() < 0.3 ? pick(r, ['[2031-03-28] ', '2031-04-01 ', '[2031-1-2] ', '[2031-03-28 ']) : '';
  const words = Array.from({ length: 1 + Math.floor(r() * 7) }, () => pick(r, WORDS)).join(pick(r, [' ', ' ', '\t', ', ']));
  return `${pick(r, LEAD)}${date}${words}${r() < 0.1 ? '\r' : ''}`;
};
/** a document of n lines, sometimes with front matter @param {number} seed @param {number} n */
const doc = (seed, n) => { const r = rng(seed); const ls = Array.from({ length: n }, () => line(r)); return (r() < 0.4 ? '---\na: 1\n---\n' : '') + ls.join('\n'); };

test('openwolf parsers over 300 generated documents', () => {
  const out = [];
  for (let s = 1; s <= 300; s++) { const d = doc(s, 4 + (s % 40)); out.push(`${s} ${fp(() => parseCerebrum(d))} ${fp(() => parseStatus(d))} ${fp(() => scanKeys(d))}`); }
  golden('grammar-fuzz', 'openwolf', out);
});

const PLAN_LINES = ['### Task 1: Base', '### Task 2: Use base', '## Task 3: other level', '### Task 2a: alias', '### Task 4 (alias): body', '**Files:**', '- Create: `src/a.js`', '- Modify: `src/b.js:10-20`', '- Test: `test/a.test.mjs`', '- Create: `../up.js`',
  'Uses `Base` from Task 1.', 'Depends on Task 2.', 'Produces `Widget`.', '```', '```js', '**Goal:** a widget', '# Widget Plan', '- [ ] Step 1', 'Task 9', '### Task: missing id', '### Task 5:', ''];
const LEDGER_LINES = ['# Plan: docs/superpowers/plans/p.md', 'Task 1: complete (abc123..def456)', 'Task 2: in progress', 'Task 3: blocked on review', 'Task 4: Ruling: keep it', 'Task 5: parked — later — Ruling: no', 'Task 6: minor (deferred): rename',
  '  Minor: spacing', '  note line', 'Task 7: complete (HEAD..abc)', 'Task 2: complete', 'Task x: odd', 'Task 8 (alias): done', 'random text', '', '- Task 1: done'];
test('superpowers parsers over 300 generated plans and ledgers', () => {
  const out = [];
  for (let s = 1; s <= 300; s++) {
    const r = rng(1000 + s), plan = Array.from({ length: 3 + (s % 30) }, () => pick(r, PLAN_LINES)).join('\n'), ledger = Array.from({ length: 2 + (s % 20) }, () => pick(r, LEDGER_LINES)).join('\n');
    out.push(`${s} ${fp(() => parsePlan(plan, 'docs/superpowers/plans/p.md'))} ${fp(() => parseLedger(ledger, 'l.md'))} ${fp(() => ledgerIdentity(ledger))} ${fp(() => firstLineNamesPlan(ledger, 'docs/superpowers/plans/p.md', 'p'))}`);
  }
  golden('grammar-fuzz', 'superpowers', out);
});
