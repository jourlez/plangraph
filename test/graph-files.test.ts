// Tests for lib/graph/files.ts and the graph schemas of lib/store.ts and lib/schema.ts: field shapes with file:line messages, the open grammars
// (extension types, relations and sys are accepted and counted), derived relations refused with their home file, the id rule as a warning,
// duplicate keys, canonical form per file, adversarial two-sided merges by key for every file kind (an independent oracle, 200 random cases
// per file), the unchanged 0-to-1 migration and card line of a directory without graph files (against the frozen 0.3.0 tree).
// NOT covered: the frozen 0.3.0 merge driver and the mixed-version team (test/mixed-version.test.ts), the index (a later task).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as S from '../lib/store.ts';
import { mergeJsonl } from '../lib/merge.ts';
import { rng, genPlan } from './fixtures/gen.ts';
import { GRAPH_FILES, CORE_NODE_TYPES, RELATIONS, DERIVED_RELATIONS, V1_HOME, REL_SEMANTICS, EXT_TYPE_RE, EXT_REL_RE, isNodeType, idProblem, sysOk, xidOk, parseGraphFile, readGraphFiles } from '../lib/graph/files.ts';
import type { GraphNotes, GraphDataErrorCode, Person, Sprint, Epic, Repo, CapacityRow, Link, Xref } from '../lib/graph/files.ts';
import { GRAPH_SRC_FILES, SRC_FILES } from '../src/commands/shared.ts';

const ROOT = path.join(import.meta.dirname, '..');
const FROZEN = path.join(import.meta.dirname, 'fixtures/release-0.3.0');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'graphf-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); tmps.push(d); return d; };
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const msg = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return (e as Error).message; } };
const parse = (file: string, rows: object[]) => parseGraphFile(file, jl(rows));

const ROW: Record<string, object> = {
  'people.jsonl': { id: 'Ana', name: 'Ana Silva', active: true },
  'sprints.jsonl': { n: 3, name: 'S3', start: '2026-01-05', end: '2026-01-16', state: 'open' },
  'epics.jsonl': { id: 'E-1', name: 'Export' },
  'repos.jsonl': { id: 'repo:web', name: 'web', role: 'app', langs: ['ts'], pm: 'npm', cmds: { build: 'build', test: 'test' }, paths: [{ glob: 'packages/web/**', sub: 'web' }], src: 'manual' },
  'capacity.jsonl': { person: 'Ana', sprint: 3, sp: 8, review_h: 4 },
  'links.jsonl': { from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'T-2', to_type: 'ticket' },
  'xrefs.jsonl': { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-12', src: 'hand', seen: '2026-01-05' },
};

test('the graph files are the seven of 0.4.0, in one list the card and the reader share', () => {
  assert.deepEqual([...GRAPH_FILES], ['people.jsonl', 'sprints.jsonl', 'epics.jsonl', 'repos.jsonl', 'capacity.jsonl', 'links.jsonl', 'xrefs.jsonl']);
  assert.deepEqual([...GRAPH_SRC_FILES], [...GRAPH_FILES], 'src/commands/shared.ts lists the same files');
  assert.ok(Object.isFrozen(GRAPH_FILES) && Object.isFrozen(GRAPH_SRC_FILES));
  assert.ok(!GRAPH_SRC_FILES.some((f) => SRC_FILES.includes(f)), 'SRC_FILES (first-use check, v1 card) is unchanged');
  assert.equal(SRC_FILES.length, 9);
  assert.ok(!GRAPH_FILES.includes('plantasks.jsonl'), 'plan tasks are derived, never stored');
});

test('every graph file accepts its valid row, keeps unknown fields and schema_version, and canonical bytes are stable', () => {
  for (const f of GRAPH_FILES) {
    const row = { ...ROW[f], schema_version: 1, zz_future: { b: 1, a: [2] } };
    assert.equal(parse(f, [row]).length, 1, f);
    const c = S.canonFile([row], S.SCHEMAS[f]);
    assert.equal(S.canonFile(S.parseJsonlText(c), S.SCHEMAS[f]), c, `${f} idempotent`);
    assert.match(c, /"schema_version":1,"zz_future":\{"a":\[2\],"b":1\}\}\n$/, `${f}: unknown fields are kept, appended sorted after the known ones`);
    assert.equal(parseGraphFile(f, c).length, 1, `${f}: canonical bytes parse`);
  }
});

test('field shape errors name <file>:<line> and the field, never the value', () => {
  const bad: Array<[string, object, string]> = [
    ['people.jsonl', {}, 'missing "id"'], ['people.jsonl', { id: '' }, '"id" must not be empty'], ['people.jsonl', { id: 3 }, '"id" must be a string'],
    ['people.jsonl', { id: 'A', name: 3 }, '"name" must be a string'], ['people.jsonl', { id: 'A', active: 'yes' }, '"active" must be true or false'],
    ['sprints.jsonl', {}, 'missing "n"'], ['sprints.jsonl', { n: '3' }, '"n" must be a number'], ['sprints.jsonl', { n: 1.5 }, '"n" must be a whole number'],
    ['sprints.jsonl', { n: 1, start: '2026-1-5' }, '"start" must be a date (YYYY-MM-DD)'], ['sprints.jsonl', { n: 1, end: '2026-02-30' }, '"end" must be a date (YYYY-MM-DD)'],
    ['sprints.jsonl', { n: 1, start: '2026-02-02', end: '2026-02-01' }, '"end" must not be before "start"'], ['sprints.jsonl', { n: 1, state: 3 }, '"state" must be a string'],
    ['epics.jsonl', { name: 'x' }, 'missing "id"'], ['epics.jsonl', { id: 'E', name: [] }, '"name" must be a string'],
    ['repos.jsonl', { id: 'r', role: 'tool' }, '"role" must be one of service, lib, app, infra, docs, monorepo'], ['repos.jsonl', { id: 'r', src: 'guess' }, '"src" must be one of scan, manual, catalog'],
    ['repos.jsonl', { id: 'r', langs: ['ts', 1] }, '"langs" must be an array of strings'], ['repos.jsonl', { id: 'r', owners: 'a' }, '"owners" must be an array of strings'],
    ['repos.jsonl', { id: 'r', cmds: { build: 1 } }, '"cmds" values must be strings'], ['repos.jsonl', { id: 'r', cmds: [] }, '"cmds" must be an object'],
    ['repos.jsonl', { id: 'r', paths: [{ glob: 'a' }] }, '"paths" must be an array of {glob, sub} objects'], ['repos.jsonl', { id: 'r', fp: 1 }, '"fp" must be a string'],
    ['capacity.jsonl', { sprint: 1, sp: 1 }, 'missing "person"'],
    ['capacity.jsonl', { person: 'A', sp: 1 }, 'missing "sprint"'], ['capacity.jsonl', { person: 'A', sprint: 1 }, 'missing "sp"'], ['capacity.jsonl', { person: 'A', sprint: 1, sp: -1 }, '"sp" must not be negative'],
    ['capacity.jsonl', { person: 'A', sprint: 1, sp: 1, review_h: -1 }, '"review_h" must not be negative'], ['capacity.jsonl', { person: 'A', sprint: 'x', sp: 1 }, '"sprint" must be a number'],
    ['links.jsonl', { ...ROW['links.jsonl'], attrs: [] }, '"attrs" must be an object'], ['links.jsonl', { from: 'a', rel: 'relates_to', to: 'b', to_type: 'ticket' }, 'missing "from_type"'],
    ['xrefs.jsonl', { ...ROW['xrefs.jsonl'], seen: '2026-13-01' }, '"seen" must be a date (YYYY-MM-DD)'], ['xrefs.jsonl', { type: 'ticket', id: 'T', sys: 'sp' }, 'missing "xid"'],
    ['people.jsonl', { id: 'A', schema_version: 0 }, '"schema_version" must be at least 1'], ['people.jsonl', { id: 'A', schema_version: 'x' }, '"schema_version" must be a number'],
  ];
  for (const [f, row, want] of bad) {
    // the bad row is on line 3, after two valid ones, so the line number is part of the message
    const text = jl([ROW[f] as object, { ...(ROW[f] as object), ...keyShift(f) }, row]);
    assert.equal(msg(() => parseGraphFile(f, text)), `${f}:3: ${want}`, `${f} ${JSON.stringify(row)}`);
  }
});
// a second valid row with another key, so two valid rows do not collide
function keyShift(f: string): object {
  return ({ 'people.jsonl': { id: 'Ben' }, 'sprints.jsonl': { n: 4 }, 'epics.jsonl': { id: 'E-2' }, 'repos.jsonl': { id: 'repo:api' }, 'capacity.jsonl': { person: 'Ben' }, 'links.jsonl': { to: 'T-3' }, 'xrefs.jsonl': { xid: 'ABC-13' } } as Record<string, object>)[f] as object;
}

test('shape errors are all listed, up to ten, with a count', () => {
  const rows = Array.from({ length: 12 }, () => ({ n: 'x' }));
  const e = msg(() => parse('sprints.jsonl', rows)) as string;
  assert.equal(e.split('\n').length, 11);
  assert.match(e, /sprints\.jsonl:1: "n" must be a number\nsprints\.jsonl:2:/);
  assert.match(e, /\.\.\. and 2 more$/);
});

test('sprint numbers may be 0 or negative (the rule of schedule.jsonl), dates are real calendar dates and start may equal end', () => {
  assert.equal(parse('sprints.jsonl', [{ n: 0 }, { n: -2 }, { n: 7, start: '2024-02-29', end: '2024-02-29' }]).length, 3);
  assert.match(msg(() => parse('sprints.jsonl', [{ n: 7, start: '2025-02-29' }])) as string, /"start" must be a date/);
  assert.equal(msg(() => parse('sprints.jsonl', [{ n: 1, start: '2026-01-01' }])), null, 'a lone start or end is fine');
});

test('links: only relates_to, depends_on and touches are hand-authored; LINK_UNKNOWN_REL only for a non-x- unknown relation', () => {
  assert.deepEqual([...RELATIONS], ['relates_to', 'depends_on', 'touches']);
  for (const rel of RELATIONS) assert.equal(parse('links.jsonl', [{ ...ROW['links.jsonl'], rel }]).length, 1, rel);
  const codes: GraphDataErrorCode[] = ['LINK_UNKNOWN_REL', 'LINK_DERIVED_REL', 'DUPLICATE_NODE', 'XREF_BAD_ID'];
  assert.equal(codes.length, 4, 'every code a graph reader throws');
  const e = msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], rel: 'blocks' }])) as string;
  assert.equal(e, 'LINK_UNKNOWN_REL links.jsonl:1: "rel" blocks is not a relation of links.jsonl (relates_to, depends_on, touches or x-<sys>/<rel>)');
  assert.match(msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], rel: 'constructor' }])) as string, /^LINK_UNKNOWN_REL /);
  assert.match(msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], rel: 'Relates_To' }])) as string, /^LINK_UNKNOWN_REL /);
  // an x- relation is accepted and counted; one that breaks the grammar is a shape error, not an unknown relation
  const notes: GraphNotes = { warnings: [], ext: 0 };
  parseGraphFile('links.jsonl', jl([{ ...ROW['links.jsonl'], rel: 'x-github/closes' }, { ...ROW['links.jsonl'], rel: 'x-jira/blocks_by', to: 'T-9' }]), notes);
  assert.equal(notes.ext, 2);
  for (const rel of ['x-github', 'x-/closes', 'x-GitHub/closes', 'x-github/', 'x-a/b/c']) {
    const m = msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], rel }])) as string;
    assert.equal(m, 'links.jsonl:1: "rel" must be x-<sys>/<rel> when it starts with x-', rel);
  }
});

test('links: every derived relation is LINK_DERIVED_REL naming its home file, one case each', () => {
  assert.deepEqual([...DERIVED_RELATIONS], ['needs', 'assigned_to', 'scheduled_in', 'belongs_to', 'implements', 'held_by', 'part_of', 'specified_by', 'tracked_by', 'owned_by']);
  const home: Record<string, string> = { needs: 'edges.jsonl', assigned_to: 'schedule.jsonl', scheduled_in: 'schedule.jsonl', belongs_to: 'tickets.jsonl', implements: 'refs.jsonl', held_by: 'open-items.jsonl', part_of: 'refs.jsonl or repos.jsonl', specified_by: 'refs.jsonl', tracked_by: 'xrefs.jsonl', owned_by: 'repos.jsonl' };
  assert.deepEqual({ ...V1_HOME }, home);
  for (const rel of DERIVED_RELATIONS) assert.equal(msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], rel }])), `LINK_DERIVED_REL links.jsonl:1: "rel" ${rel} is derived, not stored; it lives in ${home[rel]}`, rel);
  assert.ok(Object.isFrozen(V1_HOME) && Object.isFrozen(RELATIONS) && Object.isFrozen(DERIVED_RELATIONS) && Object.isFrozen(CORE_NODE_TYPES) && Object.isFrozen(REL_SEMANTICS));
  for (const r of [...RELATIONS, ...DERIVED_RELATIONS]) assert.ok(Object.hasOwn(REL_SEMANTICS, r), `REL_SEMANTICS covers ${r}`);
  assert.deepEqual(Object.entries(REL_SEMANTICS).filter(([, v]) => ['order', 'load', 'slot', 'gate'].includes(v)).map(([k]) => k).sort(), ['assigned_to', 'held_by', 'needs', 'scheduled_in']);
  assert.equal(REL_SEMANTICS.touches, 'trace'); assert.equal(REL_SEMANTICS.depends_on, 'info'); assert.equal(REL_SEMANTICS.owned_by, 'info'); assert.equal(REL_SEMANTICS.tracked_by, 'identity');
});

test('node type grammar: nine core types, extension types x-<sys>.<kind>, nothing else', () => {
  assert.deepEqual([...CORE_NODE_TYPES], ['ticket', 'person', 'sprint', 'epic', 'plantask', 'openitem', 'plan', 'doc', 'repo']);
  for (const t of [...CORE_NODE_TYPES, 'x-github.pr', 'x-a.b', 'x-linear.issue', `x-${'a'.repeat(24)}.${'b'.repeat(24)}`]) assert.ok(isNodeType(t), t);
  for (const t of ['Ticket', 'x-github', 'x-.pr', 'x-github.', 'x-GitHub.pr', 'github.pr', 'x-a.b.c', `x-${'a'.repeat(25)}.b`, '', 3, null, 'x-1a.b']) assert.ok(!isNodeType(t), String(t));
  assert.ok(EXT_TYPE_RE.test('x-github.pr') && EXT_REL_RE.test('x-github/closes'));
  assert.match(msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], to_type: 'task' }])) as string, /^links\.jsonl:1: "to_type" must be a node type \(ticket, person, .*, repo or x-<sys>\.<kind>\)$/);
  assert.match(msg(() => parse('xrefs.jsonl', [{ ...ROW['xrefs.jsonl'], type: 'x-github' }])) as string, /^xrefs\.jsonl:1: "type" must be a node type/);
});

test('links: typed endpoints, a sprint is S<n>, an open item is key|kind, ids are never parsed otherwise', () => {
  const L = (o: object) => ({ ...ROW['links.jsonl'], ...o });
  assert.equal(parse('links.jsonl', [L({ from: 'S3', from_type: 'sprint' }), L({ to: 'T-1|risk', to_type: 'openitem' }), L({ from: 'docs/a#b.md#1', from_type: 'plantask' }), L({ to: 'sp:s', to_type: 'epic' })]).length, 4);
  assert.equal(msg(() => parse('links.jsonl', [L({ from: '3', from_type: 'sprint' })])), 'links.jsonl:1: "from" must be S<n> for a sprint');
  assert.equal(msg(() => parse('links.jsonl', [L({ from: 'S3', from_type: 'sprint' }), L({ to: 'T-1', to_type: 'openitem' })])), 'links.jsonl:2: "to" must be <key>|<kind> for an openitem');
  assert.equal(msg(() => parse('links.jsonl', [L({ to: 'a|b|c', to_type: 'openitem' })])), 'links.jsonl:1: "to" must be <key>|<kind> for an openitem');
  assert.equal(parse('links.jsonl', [L({ from: 'S-1', from_type: 'sprint' })]).length, 1, 'sprint 0 and below are valid numbers');
});

test('xrefs: sys grammar, generic xid rule, and unknown sys values are accepted and counted (XREF_BAD_ID for the rest)', () => {
  for (const s of ['jira:acme', 'github:owner/repo', 'linear:eng', 'confluence:wiki', 'sp', 'ci:main', 'x-corp', 'gitlab:g/p', 'bitbucket:ws/r', 'local:repo-1', 'bugzilla:main', 'x-corp:team']) assert.ok(sysOk(s), s);
  for (const s of ['Jira:acme', 'jira:', ':acme', 'jira acme', 'https://x.example/a', 'jira:a/b/c', 'github:../x', 'jira:a b', 'x'.repeat(40), '1jira']) assert.ok(!sysOk(s), s);
  for (const x of ['ABC-12', 'sprint/12', 'pull/7', 'issue/3', 'docs/p.md#Task 3', 'a:b', '@scope/pkg', 'x'.repeat(200)]) assert.ok(xidOk(x), x);
  for (const x of ['', 'x'.repeat(201), 'a..b', '../etc', 'https://example.test/x', 'ftp://h', 'a@b.example', 'ana@example.test', 'a\nb', 'a|b', 'é', 'a?b']) assert.ok(!xidOk(x), JSON.stringify(x));
  const notes: GraphNotes = { warnings: [], ext: 0 };
  parseGraphFile('xrefs.jsonl', jl([ROW['xrefs.jsonl'] as object, { ...(ROW['xrefs.jsonl'] as object), sys: 'bugzilla:main' }, { ...(ROW['xrefs.jsonl'] as object), sys: 'x-corp', xid: 'q' }, { ...(ROW['xrefs.jsonl'] as object), type: 'x-github.pr', xid: 'pull/1' }, { ...(ROW['xrefs.jsonl'] as object), sys: 'sp', xid: 'a/1' }]), notes);
  assert.equal(notes.ext, 3, 'a known sys on a core type is not an extension; an unknown sys, an x- sys and an x- type are');
  assert.equal(msg(() => parse('xrefs.jsonl', [{ ...(ROW['xrefs.jsonl'] as object), sys: 'https://x.example' }])), 'XREF_BAD_ID xrefs.jsonl:1: "sys" must be <name>, <name>:<alias> or <name>:<owner>/<repo> (lower-case name, no host, no URL)');
  for (const xid of ['http://h/x', 'a..b', 'a@b.example', 'é']) {
    const m = msg(() => parse('xrefs.jsonl', [{ ...(ROW['xrefs.jsonl'] as object), xid }])) as string;
    assert.match(m, /^XREF_BAD_ID xrefs\.jsonl:1: "xid" must be 1 to 200 characters/);
    assert.ok(!m.includes(xid), 'the value is not echoed');
  }
});

test('the amendment risk case: an x-github.pr node, an x-github/closes link and an unknown xref sys all parse and are counted', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'links.jsonl'), jl([{ from: 'pr-12', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'T-1', to_type: 'ticket' }, { from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'T-2', to_type: 'ticket' }]));
  fs.writeFileSync(path.join(d, 'xrefs.jsonl'), jl([{ type: 'ticket', id: 'T-1', sys: 'newtracker:eng', xid: 'ENG-1' }, { type: 'x-github.pr', id: 'pr-12', sys: 'github:o/r', xid: 'pull/12' }]));
  const g = readGraphFiles(d);
  assert.equal(g.links.length, 2); assert.equal(g.xrefs.length, 2);
  assert.equal(g.ext, 3, 'link 1 (type and relation: one row), xref 1 (unknown sys), xref 2 (x- type)');
  assert.deepEqual(g.warnings, []);
});

test('DUPLICATE_NODE names the file and the id for every keyed file; an identical row twice is one row; links never duplicate', () => {
  const dup: Record<string, [object, object]> = {
    'people.jsonl': [{ id: 'Ana', name: 'A' }, { id: 'Ana', active: false }], 'sprints.jsonl': [{ n: 3, name: 'a' }, { n: 3, name: 'b' }], 'epics.jsonl': [{ id: 'E-1', name: 'a' }, { id: 'E-1', name: 'b' }],
    'repos.jsonl': [{ id: 'repo:a', name: 'a' }, { id: 'repo:a', name: 'b' }], 'capacity.jsonl': [{ person: 'Ana', sprint: 2, sp: 1 }, { person: 'Ana', sprint: 2, sp: 2 }],
    'xrefs.jsonl': [{ ...(ROW['xrefs.jsonl'] as object) }, { ...(ROW['xrefs.jsonl'] as object), seen: '2026-02-02' }],
  };
  const shown: Record<string, string> = { 'people.jsonl': 'id Ana', 'sprints.jsonl': 'n 3', 'epics.jsonl': 'id E-1', 'repos.jsonl': 'id repo:a', 'capacity.jsonl': 'key Ana | 2', 'xrefs.jsonl': 'key ticket | T-1 | jira:acme | ABC-12' };
  for (const [f, [a, b]] of Object.entries(dup)) {
    const m = msg(() => parse(f, [a, b])) as string;
    assert.equal(m, `DUPLICATE_NODE ${f}:2: duplicate ${shown[f]} (a merge by an older plangraph can leave two rows; keep one row, then run plangraph build)`, f);
    assert.equal(parse(f, [a, a]).length, 1, `${f}: identical twice is one row`);
  }
  assert.equal(parse('links.jsonl', [ROW['links.jsonl'] as object, ROW['links.jsonl'] as object, { ...(ROW['links.jsonl'] as object), to: 'T-3' }]).length, 3, 'links is a set: no key, nothing is a duplicate (identical lines collapse at merge and canonicalisation)');
  const many = msg(() => parse('people.jsonl', [{ id: 'a' }, { id: 'a', name: 'x' }, { id: 'b' }, { id: 'b', name: 'y' }])) as string;
  assert.equal(many.split('\n').length, 2, 'every duplicate is listed');
});

test('the id rule is a warning for rows already in a file: 200 characters, no control, bidirectional or line-break character', () => {
  assert.equal(idProblem('x'.repeat(200)), null);
  assert.equal(idProblem('x'.repeat(201)), 'is longer than 200 characters');
  assert.equal(idProblem('é'.repeat(200)), null);
  assert.equal(idProblem('😀'.repeat(200)), null, 'characters, not UTF-16 units');
  assert.equal(idProblem('😀'.repeat(201)), 'is longer than 200 characters');
  assert.equal(idProblem('Ana Silva'), null); assert.equal(idProblem('sp:2026-01-01-w'), null); assert.equal(idProblem('docs/p.md#Task 3'), null); assert.equal(idProblem('K|risk'), null);
  for (const c of ['\u0000', '\u0007', '\t', '\n', '\r', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029', '\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069']) assert.equal(idProblem(`a${c}b`), 'holds a control, bidirectional or line-break character', JSON.stringify(c));
  assert.equal(idProblem('a b'), null, 'a no-break space is visible');
  const notes: GraphNotes = { warnings: [], ext: 0 };
  const rows = parseGraphFile('people.jsonl', jl([{ id: 'ok' }, { id: `bad\u202eid` }, { id: 'y'.repeat(201) }]), notes);
  assert.equal(rows.length, 3, 'never an error');
  assert.deepEqual(notes.warnings, ['people.jsonl:2: "id" holds a control, bidirectional or line-break character (the id rule applies to new rows)', 'people.jsonl:3: "id" is longer than 200 characters (the id rule applies to new rows)']);
  const n2: GraphNotes = { warnings: [], ext: 0 };
  parseGraphFile('links.jsonl', jl([{ ...(ROW['links.jsonl'] as object), to: 'a\u2066b' }]), n2); parseGraphFile('xrefs.jsonl', jl([{ ...(ROW['xrefs.jsonl'] as object), id: 'a\nb'.replace('\n', '\u0001') }]), n2); parseGraphFile('capacity.jsonl', jl([{ person: 'a\u0000', sprint: 1, sp: 1 }]), n2);
  assert.deepEqual(n2.warnings.map((w) => w.split(' ')[0]), ['links.jsonl:1:', 'xrefs.jsonl:1:', 'capacity.jsonl:1:']);
  assert.equal(parseGraphFile('people.jsonl', jl([{ id: 'x' }])).length, 1, 'notes are optional');
});

test('a file that an older merge driver rewrote (keys sorted, lines in hash order) is read; only a non-graph name is refused', () => {
  const rewritten = ['{"active":true,"id":"b","name":"B"}', '{"active":false,"id":"a","name":"A"}'].join('\n') + '\n';
  assert.equal(parseGraphFile('people.jsonl', rewritten).length, 2);
  assert.equal(parseGraphFile('people.jsonl', '\ufeff{"id":"a"}\r\n\r\n{"id":"b"}\r\n').length, 2, 'BOM, CRLF and blank lines');
  assert.throws(() => parseGraphFile('tickets.jsonl', ''), /not a graph file: tickets\.jsonl/);
  assert.throws(() => parseGraphFile('x/../people.jsonl.bak', ''), TypeError);
  assert.match(msg(() => parseGraphFile('people.jsonl', '<<<<<<< ours\n')) as string, /people\.jsonl:1: unresolved git merge conflict marker/);
  assert.match(msg(() => parseGraphFile('people.jsonl', '[1]\n')) as string, /people\.jsonl:1: expected a JSON object/);
  assert.equal(parseGraphFile('./some/dir/people.jsonl', '{"id":"a"}\n').length, 1, 'the file kind is the base name');
});

test('readGraphFiles: absent files give nothing, a symlink and a directory are refused, errors name the file', () => {
  const d = tmp();
  const g = readGraphFiles(d);
  assert.deepEqual([g.people, g.sprints, g.epics, g.repos, g.capacity, g.links, g.xrefs], [[], [], [], [], [], [], []]);
  assert.equal(g.ext, 0); assert.deepEqual(g.warnings, []);
  for (const f of GRAPH_FILES) fs.writeFileSync(path.join(d, f), jl([ROW[f] as object]));
  const all = readGraphFiles(d);
  assert.deepEqual([all.people.length, all.sprints.length, all.epics.length, all.repos.length, all.capacity.length, all.links.length, all.xrefs.length], [1, 1, 1, 1, 1, 1, 1]);
  const first: [Person, Sprint, Epic, Repo, CapacityRow, Link, Xref] = [all.people[0] as Person, all.sprints[0] as Sprint, all.epics[0] as Epic, all.repos[0] as Repo, all.capacity[0] as CapacityRow, all.links[0] as Link, all.xrefs[0] as Xref];
  assert.deepEqual(first.map((r) => r.schema_version), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.equal(all.people[0]?.id, 'Ana'); assert.equal(all.sprints[0]?.n, 3); assert.equal(all.capacity[0]?.review_h, 4); assert.equal(all.links[0]?.from_type, 'ticket'); assert.equal(all.xrefs[0]?.sys, 'jira:acme');
  fs.rmSync(path.join(d, 'epics.jsonl')); fs.symlinkSync(path.join(d, 'people.jsonl'), path.join(d, 'epics.jsonl'));
  assert.equal(msg(() => readGraphFiles(d)), 'epics.jsonl: is a symlink, not a regular file');
  fs.rmSync(path.join(d, 'epics.jsonl')); fs.mkdirSync(path.join(d, 'epics.jsonl'));
  assert.match(msg(() => readGraphFiles(d)) as string, /^epics\.jsonl: /);
  fs.rmSync(path.join(d, 'epics.jsonl'), { recursive: true }); fs.writeFileSync(path.join(d, 'epics.jsonl'), '{"id":"E","name":3}\n');
  assert.equal(msg(() => readGraphFiles(d)), 'epics.jsonl:1: "name" must be a string');
  const big = tmp(); fs.closeSync(fs.openSync(path.join(big, 'links.jsonl'), 'w')); fs.truncateSync(path.join(big, 'links.jsonl'), 64 * 1024 * 1024 + 1);
  assert.match(msg(() => readGraphFiles(big)) as string, /^links\.jsonl: file too large/);
});

test('the schemas: keys, field order, sets and no defaults, exactly as documented', () => {
  const want: Record<string, { order: string[]; sets: string[]; key: object; same?: object }> = {
    'people.jsonl': { order: ['id', 'name', 'active'], sets: [], key: { id: 'a' } },
    'sprints.jsonl': { order: ['n', 'name', 'start', 'end', 'state'], sets: [], key: { n: 2 } },
    'epics.jsonl': { order: ['id', 'name'], sets: [], key: { id: 'a' } },
    'repos.jsonl': { order: ['id', 'name', 'role', 'langs', 'pm', 'runtime', 'frameworks', 'cmds', 'entry', 'deploy', 'owners', 'paths', 'src', 'fp', 'scanned_at', 'scanner'], sets: ['langs', 'frameworks', 'entry', 'owners', 'paths'], key: { id: 'a' } },
    'capacity.jsonl': { order: ['person', 'sprint', 'sp', 'review_h'], sets: [], key: { person: 'a', sprint: 1 } },
    'links.jsonl': { order: ['from', 'from_type', 'rel', 'to', 'to_type', 'attrs'], sets: [], key: {} },
    'xrefs.jsonl': { order: ['type', 'id', 'sys', 'xid', 'src', 'seen', 'note'], sets: [], key: { type: 't', id: 'a', sys: 's', xid: 'x' } },
  };
  for (const f of GRAPH_FILES) {
    const s = S.SCHEMAS[f] as S.Schema, w = want[f] as (typeof want)[string];
    assert.deepEqual([s.file, s.order, s.sets, s.defaults], [f, w.order, w.sets, {}], f);
  }
  const id = (f: string, r: object) => (S.SCHEMAS[f] as S.Schema).id(r as S.Rec);
  assert.equal(id('people.jsonl', { id: 'a', name: 'x' }), id('people.jsonl', { id: 'a', name: 'y' }), 'identity is the key, not the content');
  assert.notEqual(id('people.jsonl', { id: 'a' }), id('people.jsonl', { id: 'b' }));
  assert.equal(id('sprints.jsonl', { n: 2, name: 'x' }), id('sprints.jsonl', { n: 2 })); assert.notEqual(id('sprints.jsonl', { n: 2 }), id('sprints.jsonl', { n: 3 }));
  assert.equal(id('capacity.jsonl', { person: 'a', sprint: 1, sp: 1 }), id('capacity.jsonl', { person: 'a', sprint: 1, sp: 9 })); assert.notEqual(id('capacity.jsonl', { person: 'a', sprint: 1 }), id('capacity.jsonl', { person: 'a', sprint: 2 })); assert.notEqual(id('capacity.jsonl', { person: 'a', sprint: 1 }), id('capacity.jsonl', { person: 'b', sprint: 1 }));
  const xr = { type: 't', id: 'a', sys: 's', xid: 'x' };
  for (const f of ['type', 'id', 'sys', 'xid']) assert.notEqual(id('xrefs.jsonl', xr), id('xrefs.jsonl', { ...xr, [f]: 'zz' }), `xrefs key field ${f}`);
  assert.equal(id('xrefs.jsonl', xr), id('xrefs.jsonl', { ...xr, seen: '2026-01-01', note: 'n' }));
  const l = { from: 'a', from_type: 'ticket', rel: 'relates_to', to: 'b', to_type: 'ticket' };
  assert.equal(id('links.jsonl', l), id('links.jsonl', { to_type: 'ticket', to: 'b', rel: 'relates_to', from_type: 'ticket', from: 'a' }), 'field order is not identity');
  for (const f of ['from', 'from_type', 'rel', 'to', 'to_type']) assert.notEqual(id('links.jsonl', l), id('links.jsonl', { ...l, [f]: 'zz' }), `links field ${f}`);
  assert.notEqual(id('links.jsonl', l), id('links.jsonl', { ...l, attrs: { conf: 'high' } }), 'attrs are part of the whole record');
  assert.equal(id('links.jsonl', { ...l, attrs: { b: 1, a: 2 } }), id('links.jsonl', { ...l, attrs: { a: 2, b: 1 } }), 'nested key order is not identity');
  assert.equal((S.SCHEMAS['links.jsonl'] as S.Schema).sort(l), (S.SCHEMAS['links.jsonl'] as S.Schema).id(l));
  // a set field of a repo is written sorted and deduped; the paths objects too
  assert.equal(S.canonLine({ id: 'r', owners: ['b', 'a', 'b'], paths: [{ sub: 'z', glob: 'z/**' }, { glob: 'a/**', sub: 'a' }] }, S.SCHEMAS['repos.jsonl']), '{"id":"r","owners":["a","b"],"paths":[{"glob":"a/**","sub":"a"},{"glob":"z/**","sub":"z"}]}');
  assert.deepEqual([...S.V1_FILES], ['edges.jsonl', 'evidence.jsonl', 'findings.jsonl', 'learnings.jsonl', 'meta.jsonl', 'open-items.jsonl', 'refs.jsonl', 'schedule.jsonl', 'tickets.jsonl']);
  assert.ok(Object.isFrozen(S.V1_FILES));
  assert.equal(S.canonFile([ROW['links.jsonl'] as S.Rec, ROW['links.jsonl'] as S.Rec], S.SCHEMAS['links.jsonl']), '{"from":"T-1","from_type":"ticket","rel":"relates_to","to":"T-2","to_type":"ticket"}\n', 'two equal lines collapse');
  assert.equal(S.canonFile([{ n: 10 }, { n: 9 }, { n: -1 }], S.SCHEMAS['sprints.jsonl']), '{"n":-1}\n{"n":10}\n{"n":9}\n', 'sorted as text, like every key');
});

// ---------- keyed merge: an independent oracle, adversarial two-sided edits ----------
type R = Record<string, unknown>;
const stable = (v: unknown, set = false): string => {
  if (Array.isArray(v)) { const items = v.map((x) => stable(x)); return `[${(set ? [...new Set(items)].sort() : items).join(',')}]`; }
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as R)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
};
type Oracle = { rows: R[]; conflicts: string[] };
function oracle(base: R[], ours: R[], theirs: R[], keyFields: string[], sets: string[]): Oracle {
  const kOf = (r: R) => keyFields.map((f) => String(r[f])).join(' | ');
  const idx = (rs: R[]) => new Map(rs.map((r) => [kOf(r), r]));
  const B = idx(base), O = idx(ours), T = idx(theirs), rows: R[] = [], conflicts: string[] = [];
  const same = (a: R | undefined, b: R | undefined) => (a === undefined || b === undefined ? a === b : [...new Set([...Object.keys(a), ...Object.keys(b)])].every((f) => stable(a[f], sets.includes(f)) === stable(b[f], sets.includes(f))));
  for (const k of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const b = B.get(k), o = O.get(k), t = T.get(k);
    if (same(o, t)) { if (o) rows.push(o); continue; }
    if (same(o, b)) { if (t) rows.push(t); continue; }
    if (same(t, b)) { if (o) rows.push(o); continue; }
    if (!o || !t || !b) { conflicts.push(k); continue; }
    const out: R = {}; let clash = false;
    for (const f of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
      const isSet = sets.includes(f), bv = b[f], ov = o[f], tv = t[f];
      if (isSet) {
        const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []), has = (xs: unknown[], x: unknown) => xs.some((y) => stable(y) === stable(x));
        const merged = [...arr(ov), ...arr(tv)].filter((x, i, all) => all.findIndex((y) => stable(y) === stable(x)) === i).filter((x) => !(has(arr(bv), x) && !(has(arr(ov), x) && has(arr(tv), x))));
        if (Array.isArray(ov) || Array.isArray(tv)) out[f] = merged;
      } else if (stable(ov) === stable(tv)) { if (ov !== undefined) out[f] = ov; }
      else if (stable(ov) === stable(bv)) { if (tv !== undefined) out[f] = tv; }
      else if (stable(tv) === stable(bv)) { if (ov !== undefined) out[f] = ov; }
      else clash = true;
    }
    if (clash) conflicts.push(k); else rows.push(out);
  }
  return { rows, conflicts };
}

const POOL = {
  name: ['Ana', 'Ben', 'Cleo', 'é "q"', 'x y'], bool: [true, false], date: ['2026-01-05', '2026-02-02', '2026-03-09'], span: [['2026-01-05', '2026-01-16'], ['2026-02-02', '2026-02-13'], ['2026-03-09', '2026-03-09']], num: [0, 1, 5, 13], word: ['npm', 'uv', 'cargo', 'make'], role: ['service', 'lib', 'app'],
  state: ['open', 'closed', 'planned'],
};
type Model = { file: string; keyFields: string[]; sets: string[]; row(i: number, pick: <T>(a: T[]) => T): R; edit(row: R, pick: <T>(a: T[]) => T): void };
const MODELS: Model[] = [
  { file: 'people.jsonl', keyFields: ['id'], sets: [], row: (i, p) => ({ id: `P${i}`, name: p(POOL.name), active: p(POOL.bool) }), edit: (r, p) => { if (p([0, 1])) r.name = p(POOL.name); else r.active = p(POOL.bool); } },
  // start and end change together (a field-level merge keeps each field, not the rule start <= end, so a test that edits them apart would build invalid files)
  { file: 'sprints.jsonl', keyFields: ['n'], sets: [], row: (i, p) => { const [start, end] = p(POOL.span); return { n: i - 2, name: p(POOL.name), start, end, state: p(POOL.state) }; }, edit: (r, p) => { const c = p([0, 1, 2]); if (c === 0) r.name = p(POOL.name); else if (c === 1) [r.start, r.end] = p(POOL.span); else r.state = p(POOL.state); } },
  { file: 'epics.jsonl', keyFields: ['id'], sets: [], row: (i, p) => ({ id: `E${i}`, name: p(POOL.name) }), edit: (r, p) => { r.name = p(POOL.name); if (p([0, 1])) r.zz_future = p(POOL.word); } },
  { file: 'repos.jsonl', keyFields: ['id'], sets: ['langs', 'frameworks', 'entry', 'owners', 'paths'],
    row: (i, p) => ({ id: `repo:r${i}`, name: p(POOL.name), role: p(POOL.role), owners: [p(POOL.name), p(POOL.name)], langs: ['ts'], paths: [{ glob: 'a/**', sub: 'a' }], cmds: { build: p(POOL.word), test: 'test' } }),
    edit: (r, p) => { const c = p([0, 1, 2, 3]); if (c === 0) r.role = p(POOL.role); else if (c === 1) r.owners = [...(r.owners as string[]), p(POOL.name)]; else if (c === 2) r.paths = [{ glob: `${p(POOL.word)}/**`, sub: p(POOL.word) }]; else r.cmds = { build: p(POOL.word), test: 'test' }; } },
  { file: 'capacity.jsonl', keyFields: ['person', 'sprint'], sets: [], row: (i, p) => ({ person: `P${i % 3}`, sprint: Math.floor(i / 3), sp: p(POOL.num), review_h: p(POOL.num) }), edit: (r, p) => { if (p([0, 1])) r.sp = p(POOL.num); else r.review_h = p(POOL.num); } },
  { file: 'xrefs.jsonl', keyFields: ['type', 'id', 'sys', 'xid'], sets: [], row: (i, p) => ({ type: 'ticket', id: `T-${i}`, sys: 'jira:acme', xid: `ABC-${i}`, seen: p(POOL.date), src: p(['hand', 'import:jira']) }), edit: (r, p) => { const c = p([0, 1, 2]); if (c === 0) r.seen = p(POOL.date); else if (c === 1) r.src = p(['hand', 'import:jira']); else r.note = p(POOL.name); } },
];

for (const m of MODELS) {
  test(`merge by key: ${m.file} against an independent oracle, 200 random two-sided cases (edits, adds, deletes, same and different)`, () => {
    const spec = S.SCHEMAS[m.file] as S.Schema;
    let conflicted = 0, clean = 0, merged = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 104729 + m.file.length), pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)] as T;
      const base: R[] = []; for (let i = 0; i < 8; i++) if (r() < 0.8) base.push(m.row(i, pick));
      const side = (): R[] => {
        const rows = base.map((x) => structuredClone(x)).filter(() => r() > 0.12);
        for (const x of rows) if (r() < 0.45) { m.edit(x, pick); if (r() < 0.25) m.edit(x, pick); }
        for (let i = 6; i < 11; i++) if (r() < 0.3 && !rows.some((x) => m.keyFields.every((f) => x[f] === m.row(i, pick)[f]))) rows.push(m.row(i, pick));
        return rows;
      };
      // sometimes one side is exactly the other side with one more edit, or a side equals the base (the common git cases)
      const o = side(), t = r() < 0.15 ? structuredClone(o) : r() < 0.1 ? base.map((x) => structuredClone(x)) : side();
      const want = oracle(base, o, t, m.keyFields, m.sets);
      const got = mergeJsonl({ base: S.canonFile(base, spec), ours: S.canonFile(o, spec), theirs: S.canonFile(t, spec) }, spec, { name: m.file });
      assert.deepEqual(got.conflicts.map((c) => c.key).sort(), want.conflicts.map((k) => k).sort(), `seed ${seed}: conflict keys`);
      if (want.conflicts.length) { conflicted++; continue; }
      clean++;
      assert.equal(got.text, S.canonFile(want.rows, spec), `seed ${seed}: merged text`);
      assert.equal(parseGraphFile(m.file, got.text).length, want.rows.length, `seed ${seed}: the merged file is a valid graph file`);
      merged++;
    }
    assert.ok(conflicted > 10 && clean > 40, `the fuzz reaches both outcomes (${conflicted} conflicted, ${clean} clean)`);
    assert.equal(merged, clean);
  });
}

test('merge by key: one side changes name, the other changes active: one row with both (people), per file the named adversarial cases', () => {
  const P = S.SCHEMAS['people.jsonl'] as S.Schema, base = jl([{ id: 'a', name: 'A', active: true }]);
  const r = mergeJsonl({ base, ours: jl([{ id: 'a', name: 'B', active: true }]), theirs: jl([{ id: 'a', name: 'A', active: false }]) }, P);
  assert.deepEqual([r.conflicts, r.text], [[], '{"id":"a","name":"B","active":false}\n']);
  const c = mergeJsonl({ base, ours: jl([{ id: 'a', name: 'B', active: true }]), theirs: jl([{ id: 'a', name: 'C', active: true }]) }, P);
  assert.deepEqual(c.conflicts.map((x) => [x.key, x.detail]), [['a', 'both sides changed field name']]);
  assert.match(c.text, /^<<<<<<< ours\n.*\n=======\n.*\n>>>>>>> theirs\n$/);
  // a field added on each side, a field removed on one side and kept on the other, an unknown field from a newer tool
  const x = mergeJsonl({ base: jl([{ id: 'a', name: 'A', zz: 1 }]), ours: jl([{ id: 'a', name: 'A', zz: 1, schema_version: 2 }]), theirs: jl([{ id: 'a', zz: 1, active: true }]) }, P);
  assert.deepEqual([x.conflicts, x.text], [[], '{"id":"a","active":true,"schema_version":2,"zz":1}\n']);
  // delete against edit conflicts, delete against untouched deletes, add of the same row on both sides merges, add of different rows conflicts
  assert.deepEqual(mergeJsonl({ base, ours: '', theirs: jl([{ id: 'a', name: 'Z', active: true }]) }, P).conflicts.map((y) => y.detail), ['deleted in ours, edited in theirs']);
  assert.deepEqual(mergeJsonl({ base, ours: '', theirs: base }, P), { text: '', conflicts: [] });
  assert.deepEqual(mergeJsonl({ base: '', ours: jl([{ id: 'n' }]), theirs: jl([{ id: 'n' }]) }, P), { text: '{"id":"n"}\n', conflicts: [] });
  assert.deepEqual(mergeJsonl({ base: '', ours: jl([{ id: 'n', name: 'x' }]), theirs: jl([{ id: 'n', name: 'y' }]) }, P).conflicts.map((y) => y.detail), ['added differently on both sides']);
  // sprints: two branches add different sprints; the same sprint number with different names conflicts
  const Sp = S.SCHEMAS['sprints.jsonl'] as S.Schema;
  assert.equal(mergeJsonl({ base: '', ours: jl([{ n: 4, name: 'S4' }]), theirs: jl([{ n: 5, name: 'S5' }]) }, Sp).text, '{"n":4,"name":"S4"}\n{"n":5,"name":"S5"}\n');
  assert.equal(mergeJsonl({ base: '', ours: jl([{ n: 4, name: 'a' }]), theirs: jl([{ n: 4, name: 'b' }]) }, Sp).conflicts.length, 1);
  // repos: owners is a set; two branches each add an owner and a path: both kept, canonical order
  const Re = S.SCHEMAS['repos.jsonl'] as S.Schema;
  const rb = { id: 'repo:w', owners: ['ana'], paths: [{ glob: 'a/**', sub: 'a' }] };
  const rr = mergeJsonl({ base: jl([rb]), ours: jl([{ ...rb, owners: ['ana', 'zed'], paths: [...rb.paths, { glob: 'z/**', sub: 'z' }] }]), theirs: jl([{ ...rb, owners: ['ana', 'bo'], role: 'app' }]) }, Re);
  assert.deepEqual([rr.conflicts, rr.text], [[], '{"id":"repo:w","role":"app","owners":["ana","bo","zed"],"paths":[{"glob":"a/**","sub":"a"},{"glob":"z/**","sub":"z"}]}\n']);
  assert.equal(mergeJsonl({ base: jl([rb]), ours: jl([{ ...rb, owners: [] }]), theirs: jl([{ ...rb, owners: ['ana', 'bo'] }]) }, Re).text, '{"id":"repo:w","owners":["bo"],"paths":[{"glob":"a/**","sub":"a"}]}\n', 'a removal on one side and an addition on the other both apply');
  // two branches add different repo nodes: clean, sorted by id
  assert.equal(mergeJsonl({ base: '', ours: jl([{ id: 'repo:b', name: 'b' }]), theirs: jl([{ id: 'repo:a', name: 'a' }]) }, Re).text, '{"id":"repo:a","name":"a"}\n{"id":"repo:b","name":"b"}\n');
  // capacity: the key is person + sprint; a different sprint of the same person is a different row
  const Ca = S.SCHEMAS['capacity.jsonl'] as S.Schema;
  assert.deepEqual(mergeJsonl({ base: '', ours: jl([{ person: 'a', sprint: 1, sp: 5 }]), theirs: jl([{ person: 'a', sprint: 2, sp: 5 }]) }, Ca).conflicts, []);
  assert.equal(mergeJsonl({ base: jl([{ person: 'a', sprint: 1, sp: 5 }]), ours: jl([{ person: 'a', sprint: 1, sp: 6 }]), theirs: jl([{ person: 'a', sprint: 1, sp: 5, review_h: 3 }]) }, Ca).text, '{"person":"a","sprint":1,"sp":6,"review_h":3}\n');
  // xrefs: one row per (type, id, sys, xid); a two-sided edit of different fields of one xref is one row
  const Xr = S.SCHEMAS['xrefs.jsonl'] as S.Schema, xb = { type: 'ticket', id: 'T-1', sys: 'jira:acme', xid: 'ABC-1', seen: '2026-01-05' };
  assert.equal(mergeJsonl({ base: jl([xb]), ours: jl([{ ...xb, seen: '2026-02-02' }]), theirs: jl([{ ...xb, note: 'checked' }]) }, Xr).text, '{"type":"ticket","id":"T-1","sys":"jira:acme","xid":"ABC-1","seen":"2026-02-02","note":"checked"}\n');
  assert.equal(mergeJsonl({ base: '', ours: jl([xb]), theirs: jl([{ ...xb, id: 'T-2' }]) }, Xr).text.split('\n').filter(Boolean).length, 2, 'one reference per node, not per external id');
  // a duplicate key already in a side (left by an older driver) is never silently kept as a new duplicate
  const dup = mergeJsonl({ base: jl([{ id: 'a', name: 'A' }]), ours: jl([{ id: 'a', name: 'B' }, { id: 'a', name: 'C' }]), theirs: jl([{ id: 'a', name: 'A' }]) }, P);
  assert.deepEqual(dup.conflicts.map((y) => y.detail), ['duplicate key in the result']);
});

test('merge of links.jsonl is a set: 200 random cases, no line is ever lost or invented', () => {
  const spec = S.SCHEMAS['links.jsonl'] as S.Schema;
  const pool: R[] = [];
  for (const rel of ['relates_to', 'depends_on', 'touches', 'x-github/closes']) for (let i = 0; i < 3; i++) pool.push({ from: `T-${i}`, from_type: 'ticket', rel, to: `repo:r${i}`, to_type: 'repo', ...(rel === 'touches' ? { attrs: { conf: 'high', why: 'w' } } : {}) });
  const line = (x: R) => S.canonLine(x, spec);
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed * 7 + 3), subset = (p: number) => pool.filter(() => r() < p);
    const base = subset(0.4), o = r() < 0.3 ? base : subset(0.5), t = r() < 0.3 ? base : subset(0.5);
    const inb = new Set(base.map(line)), ino = new Set(o.map(line)), int = new Set(t.map(line));
    const expected = pool.filter((x) => { const k = line(x), a = ino.has(k), b = int.has(k), c = inb.has(k); return (a || b) && !(c && !(a && b)); });
    const got = mergeJsonl({ base: S.canonFile(base, spec), ours: S.canonFile(o, spec), theirs: S.canonFile(t, spec) }, spec, { name: 'links.jsonl' });
    assert.deepEqual(got.conflicts, [], `seed ${seed}`);
    assert.equal(got.text, S.canonFile(expected, spec), `seed ${seed}`);
  }
  // an edit of one link is a delete plus an add: the old line goes, the new one stays, a concurrent identical edit collapses
  const a = { from: 'a', from_type: 'ticket', rel: 'touches', to: 'r', to_type: 'repo', attrs: { conf: 'low' } }, b = { ...a, attrs: { conf: 'high' } };
  assert.equal(mergeJsonl({ base: S.canonFile([a], spec), ours: S.canonFile([b], spec), theirs: S.canonFile([b], spec) }, spec).text, S.canonFile([b], spec));
  assert.equal(mergeJsonl({ base: S.canonFile([a], spec), ours: S.canonFile([b], spec), theirs: S.canonFile([a], spec) }, spec).text, S.canonFile([b], spec));
});

test('the real merge driver (bin/plangraph-merge) merges each graph file kind by key from the basename', () => {
  const d = tmp();
  const cases: Array<[string, object, object, object, string]> = [
    ['people.jsonl', { id: 'a', name: 'A', active: true }, { id: 'a', name: 'B', active: true }, { id: 'a', name: 'A', active: false }, '{"id":"a","name":"B","active":false}\n'],
    ['sprints.jsonl', { n: 1, name: 'a' }, { n: 1, name: 'b' }, { n: 1, name: 'a', state: 'closed' }, '{"n":1,"name":"b","state":"closed"}\n'],
    ['epics.jsonl', { id: 'E', name: 'a' }, { id: 'E', name: 'b' }, { id: 'E', name: 'a', zz: 1 }, '{"id":"E","name":"b","zz":1}\n'],
    ['repos.jsonl', { id: 'r', owners: ['a'] }, { id: 'r', owners: ['a', 'b'] }, { id: 'r', owners: ['a', 'c'], role: 'lib' }, '{"id":"r","role":"lib","owners":["a","b","c"]}\n'],
    ['capacity.jsonl', { person: 'a', sprint: 1, sp: 5 }, { person: 'a', sprint: 1, sp: 6 }, { person: 'a', sprint: 1, sp: 5, review_h: 2 }, '{"person":"a","sprint":1,"sp":6,"review_h":2}\n'],
    ['links.jsonl', { from: 'a', from_type: 'ticket', rel: 'relates_to', to: 'b', to_type: 'ticket' }, { from: 'a', from_type: 'ticket', rel: 'relates_to', to: 'b', to_type: 'ticket' }, { from: 'a', from_type: 'ticket', rel: 'relates_to', to: 'c', to_type: 'ticket' }, '{"from":"a","from_type":"ticket","rel":"relates_to","to":"c","to_type":"ticket"}\n'], // an edit is a delete plus an add
    ['xrefs.jsonl', { type: 'ticket', id: 'T', sys: 'sp', xid: 'x' }, { type: 'ticket', id: 'T', sys: 'sp', xid: 'x', seen: '2026-01-01' }, { type: 'ticket', id: 'T', sys: 'sp', xid: 'x', note: 'n' }, '{"type":"ticket","id":"T","sys":"sp","xid":"x","seen":"2026-01-01","note":"n"}\n'],
  ];
  for (const [f, b, o, t, want] of cases) {
    const dir = path.join(d, f.replace('.jsonl', '')); fs.mkdirSync(dir);
    for (const [n, c] of [['base', b], ['ours', o], ['theirs', t]] as const) fs.writeFileSync(path.join(dir, n), jl([c]));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/plangraph-merge'), path.join(dir, 'base'), path.join(dir, 'ours'), path.join(dir, 'theirs'), `.plangraph/${f}`], { encoding: 'utf8' });
    assert.deepEqual([r.status, r.stderr, fs.readFileSync(path.join(dir, 'ours'), 'utf8')], [0, '', want], f);
  }
  // a conflict exits 1 with the key on stderr and the markers in the file
  const dir = path.join(d, 'c'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'b'), jl([{ id: 'a', name: 'A' }])); fs.writeFileSync(path.join(dir, 'o'), jl([{ id: 'a', name: 'B' }])); fs.writeFileSync(path.join(dir, 't'), jl([{ id: 'a', name: 'C' }]));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/plangraph-merge'), path.join(dir, 'b'), path.join(dir, 'o'), path.join(dir, 't'), '.plangraph/people.jsonl'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /1 conflict\(s\) in \.plangraph\/people\.jsonl[\s\S]*a: both sides changed field name/);
  assert.match(fs.readFileSync(path.join(dir, 'o'), 'utf8'), /^<<<<<<< ours/);
});

// ---------- a directory without graph files is unchanged (against the frozen 0.3.0 tree) ----------
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const runIn = (tree: string, cwd: string, args: string[]) => spawnSync(process.execPath, [path.join(tree, 'bin/plangraph'), ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });
function v1Repo(): string {
  const d = tmp('graphv1-'); execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(runIn(FROZEN, d, ['init']).status, 0);
  const p = genPlan({ n: 12, people: 3, seed: 5, cap: 9 }), b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify(p.config));
  return d;
}

test('card line of a v1-only directory equals the frozen 0.3.0 card line; a present graph file changes only its digest', () => {
  const d = v1Repo();
  const old = runIn(FROZEN, d, ['card', '--line']), now = runIn(ROOT, d, ['card', '--line']);
  assert.equal(old.status, 0, old.stderr);
  assert.deepEqual([now.status, now.stdout, now.stderr], [0, old.stdout, old.stderr], 'identical bytes without a graph file');
  assert.match(now.stdout, /^plangraph: 12 tickets, last sprint \d+, \d+ violations @[0-9a-f]{8}\n$/);
  const digest = (s: string) => s.replace(/@[0-9a-f]{8}\n$/, '');
  const seen = new Set([now.stdout]);
  for (const f of GRAPH_FILES) {
    const p = path.join(d, '.plangraph', f);
    fs.writeFileSync(p, jl([ROW[f] as object]));
    const r = runIn(ROOT, d, ['card', '--line']);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(digest(r.stdout), digest(now.stdout), `${f}: only the digest changes`);
    assert.ok(!seen.has(r.stdout), `${f}: the digest changed`); seen.add(r.stdout);
    fs.rmSync(p);
    assert.equal(runIn(ROOT, d, ['card', '--line']).stdout, old.stdout, `${f}: removed again, the 0.3.0 line is back`);
  }
  fs.writeFileSync(path.join(d, '.plangraph', 'people.jsonl'), '');
  assert.notEqual(runIn(ROOT, d, ['card', '--line']).stdout, old.stdout, 'a present empty file counts');
  fs.rmSync(path.join(d, '.plangraph', 'people.jsonl'));
  fs.symlinkSync(path.join(d, '.plangraph', 'tickets.jsonl'), path.join(d, '.plangraph', 'people.jsonl'));
  const sym = runIn(ROOT, d, ['card', '--line']);
  assert.notEqual(sym.status, 0, 'a symlinked graph file is refused, as a symlinked data file is');
  assert.match(sym.stderr, /people\.jsonl: is a symlink/);
});

test('the 0-to-1 migration plans the same files as the frozen 0.3.0 for a legacy directory that also holds graph files', async () => {
  const d = tmp('graphmig-');
  const t = [{ sp: 2, key: 'T-2', summary: 'b' }, { key: 'T-1', sp: 1, summary: 'a' }], sc = [{ sprint: 1, key: 'T-1', owner: 'Ana' }];
  fs.writeFileSync(path.join(d, 'tickets.jsonl'), jl(t)); fs.writeFileSync(path.join(d, 'schedule.jsonl'), jl(sc));
  fs.writeFileSync(path.join(d, 'people.jsonl'), '{"name":"Ana Silva","id":"Ana"}\n{"id":"Ben"}\n'); // not canonical: must stay untouched
  fs.writeFileSync(path.join(d, 'links.jsonl'), '{"to":"b","from":"a","rel":"relates_to","from_type":"ticket","to_type":"ticket"}\n');
  const F = await import(pathToFileURL(path.join(FROZEN, 'lib/store.ts')).href) as typeof S;
  const want = JSON.parse(JSON.stringify(F.planMigration(d))), got = JSON.parse(JSON.stringify(S.planMigration(d)));
  assert.deepEqual(got, want);
  assert.deepEqual(got.steps[0].files, ['schedule.jsonl', 'tickets.jsonl'], 'only the v1 files; a graph file is never rewritten by the migration');
  const before = Object.fromEntries(['people.jsonl', 'links.jsonl'].map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]));
  S.runMigration(d, { write: true });
  for (const f of Object.keys(before)) assert.equal(fs.readFileSync(path.join(d, f), 'utf8'), before[f], `${f} untouched`);
  assert.equal(S.readFormat(d).format_version, 1);
  assert.equal(fs.readFileSync(path.join(d, 'tickets.jsonl'), 'utf8'), S.canonFile(t, S.SCHEMAS['tickets.jsonl']));
});

test('REL_SEMANTICS is exactly the frozen table; every known sys is a known sys; keys never run together; lines are counted after a BOM', () => {
  assert.deepEqual({ ...REL_SEMANTICS }, { needs: 'order', assigned_to: 'load', scheduled_in: 'slot', held_by: 'gate', belongs_to: 'group', implements: 'trace', part_of: 'trace', specified_by: 'trace', touches: 'trace', tracked_by: 'identity', relates_to: 'info', depends_on: 'info', owned_by: 'info' });
  for (const sys of ['jira:a', 'github:o/r', 'gitlab:g/p', 'bitbucket:w/r', 'linear:a', 'confluence:a', 'ci:a', 'local:a', 'sp']) {
    const notes: GraphNotes = { warnings: [], ext: 0 };
    parseGraphFile('xrefs.jsonl', jl([{ ...(ROW['xrefs.jsonl'] as object), sys }]), notes);
    assert.equal(notes.ext, 0, sys);
  }
  for (const sys of ['jira', 'github', 'ci', 'spx']) { const notes: GraphNotes = { warnings: [], ext: 0 }; parseGraphFile('xrefs.jsonl', jl([{ ...(ROW['xrefs.jsonl'] as object), sys }]), notes); assert.equal(notes.ext, 1, `${sys}: a known name without its alias is not a known sys`); }
  assert.equal(parse('capacity.jsonl', [{ person: 'a1', sprint: 2, sp: 1 }, { person: 'a', sprint: 12, sp: 1 }]).length, 2, 'a1 + 2 and a + 12 are two rows');
  assert.equal(parse('xrefs.jsonl', [{ type: 'ticket', id: 'a', sys: 'sp', xid: 'bc' }, { type: 'ticket', id: 'ab', sys: 'sp', xid: 'c' }]).length, 2);
  assert.equal(msg(() => parseGraphFile('sprints.jsonl', '\uFEFF{"n":1}\n{"n":"x"}\n')), 'sprints.jsonl:2: "n" must be a number');
  assert.equal((msg(() => parseGraphFile('links.jsonl', `${jl([ROW['links.jsonl'] as object])}\n${jl([{ ...(ROW['links.jsonl'] as object), rel: 'zzz' }])}`)) as string).split(' ')[1], 'links.jsonl:3:', 'blank lines are counted');
});
