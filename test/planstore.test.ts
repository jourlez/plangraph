// Tests for lib/planstore.ts: the JsonlStore reproduces today's reads and writes byte for byte, and no plan-data access bypasses it.
// NOT covered: the entity backend (tasks 9 and 10), the Python solver's own reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPlan } from './fixtures/gen.ts';
import { sourceFilesIn } from './helpers/source-files.ts';
import * as S from '../lib/store.ts';
import * as P from '../lib/planstore.ts';
import { PlangraphError } from '../src/errors.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-planstore-')));
const plan = genPlan({ n: 12, seed: 7 });

// one hand-made row set per kind (the three v1 kinds come from genPlan); unsorted on purpose
const ROWS: Record<P.Kind, P.Row[]> = {
  ticket: plan.tickets as unknown as P.Row[], edge: plan.edges, schedule: plan.schedule,
  evidence: [{ key: 'T-2', source: 'audit', verdict: 'BLOCKED', resolution: 'wait', needs: 'T-1' }, { key: 'T-1', source: 'audit', verdict: 'READY', resolution: '', needs: '' }],
  finding: [{ key: 'T-2', kind: 'gap', text: 'b' }, { key: 'T-1', kind: 'gap', text: 'a' }],
  meta: [{ k: 'z', v: '1' }, { k: 'a', v: '2' }],
  learning: [{ id: 'L-2', kind: 'rule', topic: 't', text: 'x', why: '', source: '' }, { id: 'L-1', kind: 'rule', topic: 't', text: 'y', why: '', source: '' }],
  ref: [{ key: 'T-1', plans: [{ plan: 'p.md', task: '1' }], files: {}, fp_files: '', jira_updated: '', audited_at: '' }],
  openitem: [{ key: 'T-1', kind: 'followup', status: 'open' }, { key: 'T-1', kind: 'decision', status: 'open' }],
  person: [{ id: 'Ben' }, { id: 'Ana', name: 'Ana A' }],
  sprint: [{ n: 2 }, { n: 1, name: 'one' }],
  epic: [{ id: 'E1' }, { id: 'E0', name: 'zero' }],
  repo: [{ id: 'api', langs: ['ts', 'go'] }, { id: 'web' }],
  capacity: [{ person: 'Ben', sprint: 1, sp: 8 }, { person: 'Ana', sprint: 1, sp: 5, review_h: 2 }],
  link: [{ from: 'T-1', from_type: 'ticket', rel: 'related', to: 'T-2', to_type: 'ticket' }],
  xref: [{ type: 'ticket', id: 'T-1', sys: 'jira', xid: 'ABC-1' }],
};

test('every kind has a file name and a schema, and the list is closed', () => {
  assert.deepEqual(Object.keys(ROWS).sort(), [...P.KINDS].sort());
  for (const k of P.KINDS) { const f = P.kindFile(k); assert.ok(S.SCHEMAS[f], `${k}: no schema for ${f}`); assert.equal(P.kindOfFile(f), k); }
  assert.equal(P.kindOfFile('config.json'), undefined);
  assert.equal(P.SRC_KINDS.length + P.GRAPH_KINDS.length, P.KINDS.length);
});

test('writeKind writes the bytes the old writer wrote, readKind reads them back', () => {
  for (const k of P.KINDS) {
    const d = tmp(), legacy = tmp(), st = P.openStore({ dir: d, root: d }), f = P.kindFile(k);
    const r = st.writeKind(k, ROWS[k]);
    assert.equal(r.kind, k);
    S.writeAtomic(path.join(legacy, f), S.canonFile(ROWS[k], S.SCHEMAS[f]), { root: legacy });
    assert.equal(fs.readFileSync(path.join(d, f), 'utf8'), fs.readFileSync(path.join(legacy, f), 'utf8'), k);
    assert.deepEqual(st.readKind(k, { defaults: false }), S.readRecords(d, f, { defaults: false }), k);
    assert.deepEqual(st.readKind(k), S.readRecords(d, f), k);
    assert.equal(st.exists(k), true);
    assert.equal(r.bytes, fs.statSync(path.join(d, f)).size);
  }
});

test('describe, exists and a missing kind', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  assert.deepEqual(st.describe(), { backend: 'jsonl', root: d });
  assert.equal(st.exists('ticket'), false);
  assert.deepEqual(st.readKind('ticket'), []);
  assert.deepEqual(st.readValidated('ticket'), []);
  assert.equal(st.readText('ticket'), null);
  assert.equal(st.readSource('ticket', 1024), null);
  assert.equal(st.mtimeMs('ticket'), null);
  assert.equal(st.probe('ticket', 1024), 'absent');
});

test('readValidated and readText keep the readers errors', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  fs.writeFileSync(path.join(d, 'tickets.jsonl'), '{"summary":"no key"}\n');
  assert.throws(() => st.readValidated('ticket'), (e: Error) => /^tickets\.jsonl:/.test(e.message));
  fs.writeFileSync(path.join(d, 'edges.jsonl'), 'x'.repeat(100));
  assert.throws(() => st.readText('edge', { maxBytes: 10 }), { message: 'edges.jsonl: file too large (limit 10 bytes)' });
  assert.throws(() => st.readText('edge', { maxBytes: 10, bare: true }), { message: 'file too large (limit 10 bytes)' });
  assert.throws(() => st.readSource('edge', 10), { message: 'edges.jsonl: file too large (limit 10 bytes)' });
  fs.symlinkSync(path.join(d, 'edges.jsonl'), path.join(d, 'meta.jsonl'));
  for (const f of [() => st.readKind('meta'), () => st.readText('meta'), () => st.readSource('meta', 1024)]) assert.throws(f, { message: /meta\.jsonl: is a symlink/ });
  assert.equal(st.probe('meta', 1024), 'unsafe');
  assert.equal(st.probe('edge', 10), 'unsafe');
  assert.equal(st.probe('edge', 1000), 'ok');
});

test('writes refuse a symlink target (REFUSED) and precheck writes nothing', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  fs.writeFileSync(path.join(d, 'x'), '');
  fs.symlinkSync(path.join(d, 'x'), path.join(d, 'edges.jsonl'));
  assert.throws(() => st.writeKind('edge', ROWS.edge, { precheck: true }), (e: unknown) => e instanceof PlangraphError && e.code === 'REFUSED' && /refusing to write edges\.jsonl: it is a symlink \(nothing was written\)/.test(e.message));
  assert.throws(() => st.precheck(['ticket', 'edge']), { code: 'REFUSED' });
  assert.equal(fs.existsSync(path.join(d, 'tickets.jsonl')), false);
  assert.throws(() => st.writeKind('edge', ROWS.edge), { code: 'REFUSED' });
});

test('writeChanged validates all, writes only the kinds whose canonical rows changed', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  st.writeKind('person', [{ id: 'Ana' }]);
  const n = st.writeChanged([{ kind: 'person', rows: [{ id: 'Ana' }], old: [{ id: 'Ana' }] }, { kind: 'epic', rows: [{ id: 'E1' }], old: [] }], { validate: true });
  assert.equal(n, 1);
  assert.equal(fs.readFileSync(path.join(d, 'epics.jsonl'), 'utf8'), '{"id":"E1"}\n');
  assert.throws(() => st.writeChanged([{ kind: 'epic', rows: [{ nope: 1 }], old: [] }], { validate: true }), (e: Error) => /^epics\.jsonl:/.test(e.message));
});

test('writeText writes the text as given (a kind with its own serializer)', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  st.writeText('openitem', '{"key":"T-1"}\n');
  assert.equal(fs.readFileSync(path.join(d, 'open-items.jsonl'), 'utf8'), '{"key":"T-1"}\n');
});

// ---- no plan-data access outside the store ----
// A line that names readRecords, canonFile, canonText, writeState or readJsonl as a call or import must be in lib/planstore.ts or on this list.
// Each exception says why; a stale exception (matches nothing) fails the test, so the list cannot rot.
const EXCEPTIONS: Array<{ file: string; line: RegExp; reason: string }> = [
  { file: 'lib/store.ts', line: /readRecords|canonFile|canonText/, reason: 'definitions of the JSONL primitives the JsonlStore wraps (canonText is a pure text helper)' },
  { file: 'lib/jsonl.ts', line: /readJsonl/, reason: 'definition of the validated file reader the JsonlStore wraps' },
  { file: 'src/commands/shared.ts', line: /writeState/, reason: 'writeState re-export for files that are not plan kinds (config.json, .gitignore, CARD.md, report files)' },
  { file: 'src/commands/plan.ts', line: /writeState|canonFile/, reason: 'init writes config.json and .gitignore, which are not plan kinds' },
  { file: 'src/commands/openitems.ts', line: /writeState/, reason: 'open-items --write also writes OPEN-ITEMS.md, a rendered document and not a plan kind' },
  { file: 'src/commands/queries.ts', line: /writeState/, reason: 'card --write writes CARD.md, not a plan kind' },
  { file: 'src/commands/report.ts', line: /writeState/, reason: 'report writes REPORT.md and REPORT.html, not plan kinds' },
  { file: 'lib/store2/entitystore.ts', line: /canonFile/, reason: 'the entity backend of the PlanStore: it builds the canonical row order and text of a kind from entity files' },
  { file: 'src/commands/import.ts', line: /canonFile/, reason: 'cache/obs.jsonl is an observation cache, not a plan kind (it has its own column order)' },
];
const CALLS = /\b(readRecords|canonFile|canonText|writeState|readJsonl)\b/;
const SKIP_DIRS = ['lib', 'src', 'scripts', 'mcp', 'evals', 'bin'];

test('no file outside lib/planstore.ts reads or writes a plan kind through the primitives', () => {
  const files = sourceFilesIn(ROOT, SKIP_DIRS.filter((d) => fs.existsSync(path.join(ROOT, d)))).filter((f) => f !== 'lib/planstore.ts' && !f.startsWith('scripts/mutate'));
  const used = new Set<number>(), bad: string[] = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((text, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(text)) return; // a comment line
      const code = text.replace(/\/\/.*$/, '');
      if (!CALLS.test(code)) return;
      const hit = EXCEPTIONS.findIndex((e) => e.file === f && e.line.test(code));
      if (hit >= 0) used.add(hit); else bad.push(`${f}:${i + 1}: ${text.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(bad, [], 'route these through PlanStore (lib/planstore.ts) or list them in EXCEPTIONS with a reason');
  const stale = EXCEPTIONS.filter((_, i) => !used.has(i)).map((e) => `${e.file}: ${e.line}`);
  assert.deepEqual(stale, [], 'these exceptions match nothing: delete them');
});

test('the planstore module is the only place that knows the file names of the plan kinds in the index definition', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/db.ts'), 'utf8');
  const defs = src.slice(src.indexOf('const DEFS'), src.indexOf('export const TABLES'));
  assert.doesNotMatch(defs, /\.jsonl'/, 'DEFS names kinds, not files');
});
