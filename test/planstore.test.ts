// Tests for lib/planstore.ts: the entity backend behind the one PlanStore door (round trip of every kind, a damaged file skipped, refused write
// targets), and no plan-data access bypasses it. NOT covered: the Python solver's own reads; the mapping itself is test/entitystore.test.ts.
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
  requirement: [{ id: 'R-b', text: 'later', status: 'accepted' }, { id: 'R-a', text: 'first', kind: 'ears', source: 'docs/spec.md#a', acceptance: ['b', 'a'], priority: 'high' }],
  decision: [{ id: 'D-1', title: 'use x', status: 'proposed', date: '2026-01-02', affects: ['src/**', 'api'] }],
  team: [{ id: 'TEAM-1', name: 'core', members: ['Ben', 'Ana'], owns: ['api'] }],
};

test('every kind has a file name and a schema, and the list is closed', () => {
  assert.deepEqual(Object.keys(ROWS).sort(), [...P.KINDS].sort());
  for (const k of P.KINDS) { const f = P.kindFile(k); assert.ok(S.SCHEMAS[f], `${k}: no schema for ${f}`); assert.equal(P.kindOfFile(f), k); }
  assert.equal(P.kindOfFile('config.json'), undefined);
  assert.equal(P.SRC_KINDS.length + P.GRAPH_KINDS.length + P.NODE_KINDS.length, P.KINDS.length);
});

test('writeKind then readKind round-trips every kind in canonical order, and readText is the canonical text of the kind', () => {
  for (const k of P.KINDS) {
    const d = tmp(), st = P.openStore({ dir: d, root: d }), f = P.kindFile(k), schema = S.SCHEMAS[f] as S.Schema;
    const r = st.writeKind(k, ROWS[k]), text = S.canonFile(ROWS[k], schema);
    assert.equal(r.kind, k);
    assert.deepEqual(st.readKind(k, { defaults: false }), S.parseJsonlText(text, f), k);
    assert.deepEqual(st.readKind(k), S.parseJsonlText(text, f).map((x) => S.withDefaults(schema, x)), k);
    assert.equal(st.readText(k), text, k);
    assert.equal(st.exists(k), true);
    assert.equal(r.bytes, Buffer.byteLength(text));
  }
});

test('the one plan kind that stays a single file is meta.jsonl; every other kind is entity files, batch files or a schedule version', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  for (const k of P.KINDS) st.writeKind(k, ROWS[k]);
  assert.equal(fs.readFileSync(path.join(d, 'meta.jsonl'), 'utf8'), S.canonFile(ROWS.meta, S.SCHEMAS['meta.jsonl'] as S.Schema));
  for (const k of P.KINDS) if (k !== 'meta') assert.equal(fs.existsSync(path.join(d, P.kindFile(k))), false, `${k}: no old-layout file`);
  for (const dir of ['nodes/ticket', 'nodes/person', 'nodes/sprint', 'nodes/epic', 'nodes/repo', 'nodes/openitem', 'schedules', 'runs/evidence', 'runs/findings', 'runs/learnings']) assert.ok(fs.existsSync(path.join(d, dir)), dir);
});

test('describe, exists and a missing kind', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  assert.deepEqual(st.describe(), { backend: 'entity', root: d });
  assert.equal(st.exists('ticket'), false);
  assert.deepEqual(st.readKind('ticket'), []);
  assert.deepEqual(st.readValidated('ticket'), []);
  assert.equal(st.readText('ticket'), null);
  assert.equal(st.readSource('ticket', 1024), null);
  assert.equal(st.mtimeMs('ticket'), null);
  assert.equal(st.probe('ticket', 1024), 'absent');
});

test('readValidated and readText keep the readers errors (meta.jsonl, the single file)', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  fs.writeFileSync(path.join(d, 'meta.jsonl'), 'not json\n');
  assert.throws(() => st.readValidated('meta'), (e: Error) => /^meta\.jsonl:1: invalid JSON/.test(e.message));
  fs.writeFileSync(path.join(d, 'meta.jsonl'), 'x'.repeat(100));
  assert.throws(() => st.readText('meta', { maxBytes: 10 }), { message: 'meta.jsonl: file too large (limit 10 bytes)' });
  assert.throws(() => st.readText('meta', { maxBytes: 10, bare: true }), { message: 'file too large (limit 10 bytes)' });
  assert.throws(() => st.readSource('meta', 10), { message: 'meta.jsonl: file too large (limit 10 bytes)' });
  assert.equal(st.probe('meta', 10), 'unsafe');
  assert.equal(st.probe('meta', 1000), 'ok');
  fs.rmSync(path.join(d, 'meta.jsonl')); fs.writeFileSync(path.join(d, 'other'), ''); fs.symlinkSync(path.join(d, 'other'), path.join(d, 'meta.jsonl'));
  for (const f of [() => st.readKind('meta'), () => st.readText('meta'), () => st.readSource('meta', 1024)]) assert.throws(f, { message: /meta\.jsonl: is a symlink/ });
  assert.equal(st.probe('meta', 1024), 'unsafe');
});

test('a damaged node file is skipped by the readers, never thrown', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  st.writeKind('person', [{ id: 'Ana' }, { id: 'Ben' }]);
  const dir = path.join(d, 'nodes/person', 'ab'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad~00000000.pg'), 'id "bad"\n<<<<<<< a\nname "x"\n=======\nname "y"\n>>>>>>> b\n');
  fs.writeFileSync(path.join(dir, 'worse~11111111.pg'), 'not a node file\n\u0000');
  assert.deepEqual(st.readKind('person').map((r) => r.id), ['Ana', 'Ben']);
});

test('writes refuse a symlink target (REFUSED) and precheck writes nothing', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  fs.mkdirSync(path.join(d, 'nodes')); fs.mkdirSync(path.join(d, 'elsewhere'));
  fs.symlinkSync(path.join(d, 'elsewhere'), path.join(d, 'nodes', 'ticket'));
  assert.throws(() => st.writeKind('ticket', ROWS.ticket, { precheck: true }), (e: unknown) => e instanceof PlangraphError && e.code === 'REFUSED' && /refusing to write ticket: it is a symlink \(nothing was written\)/.test(e.message));
  assert.throws(() => st.precheck(['person', 'ticket']), { code: 'REFUSED' });
  assert.equal(fs.existsSync(path.join(d, 'nodes', 'person')), false);
  assert.deepEqual(fs.readdirSync(path.join(d, 'elsewhere')), []);
});

test('writeChanged validates all, writes only the kinds whose canonical rows changed', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  st.writeKind('person', [{ id: 'Ana' }]);
  const n = st.writeChanged([{ kind: 'person', rows: [{ id: 'Ana' }], old: [{ id: 'Ana' }] }, { kind: 'epic', rows: [{ id: 'E1' }], old: [] }], { validate: true });
  assert.equal(n, 1);
  assert.equal(st.readText('epic'), '{"id":"E1"}\n');
  assert.throws(() => st.writeChanged([{ kind: 'epic', rows: [{ nope: 1 }], old: [] }], { validate: true }), (e: Error) => /^epics\.jsonl:/.test(e.message));
});

test('writeText writes rows from text (a kind with its own serializer)', () => {
  const d = tmp(), st = P.openStore({ dir: d, root: d });
  st.writeText('openitem', '{"key":"T-1","kind":"gap","status":"open"}\n');
  assert.deepEqual(st.readKind('openitem', { defaults: false }), [{ key: 'T-1', kind: 'gap', status: 'open' }]);
  assert.ok(fs.existsSync(path.join(d, 'nodes', 'openitem')));
});

// ---- no plan-data access outside the store ----
// A line that names readRecords, canonFile, canonText, writeState or readJsonl as a call or import must be in lib/planstore.ts or on this list.
// Each exception says why; a stale exception (matches nothing) fails the test, so the list cannot rot.
const EXCEPTIONS: Array<{ file: string; line: RegExp; reason: string }> = [
  { file: 'lib/store.ts', line: /readRecords|canonFile|canonText/, reason: 'definitions of the canonical-text primitives the store builds on (canonText is a pure text helper)' },
  { file: 'lib/jsonl.ts', line: /readJsonl/, reason: 'definition of the validated file reader the store wraps (meta.jsonl, snapshots)' },
  { file: 'src/commands/shared.ts', line: /writeState/, reason: 'writeState re-export for files that are not plan kinds (config.json, .gitignore, CARD.md, report files)' },
  { file: 'src/commands/plan.ts', line: /writeState|canonFile/, reason: 'init writes config.json and .gitignore, which are not plan kinds' },
  { file: 'src/commands/openitems.ts', line: /writeState/, reason: 'open-items --write also writes OPEN-ITEMS.md, a rendered document and not a plan kind' },
  { file: 'src/commands/queries.ts', line: /writeState/, reason: 'card --write writes CARD.md, not a plan kind' },
  { file: 'src/commands/report.ts', line: /writeState/, reason: 'report writes REPORT.md and REPORT.html, not plan kinds' },
  { file: 'lib/store2/entitystore.ts', line: /readRecords|canonFile|readJsonl|writeState/, reason: 'the entity backend of the PlanStore: it builds the canonical row order and text of a kind from entity files and keeps meta.jsonl as a single file' },
  { file: 'lib/store2/adopt.ts', line: /readRecords/, reason: 'reads the old-layout files it converts into the store' },
  { file: 'lib/solver-input.ts', line: /canonFile/, reason: 'the derived solver input is the v1-shaped canonical text of five kinds' },
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
