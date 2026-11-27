// Tests for lib/graph/files.ts and the graph schemas of lib/store.ts and lib/schema.ts: field shapes with file:line messages, the open grammars
// (extension types, relations and sys are accepted and counted), derived relations refused with their home file, the id rule as a warning,
// duplicate keys, canonical form per file, 
// per file), the card line of a directory without graph files.
// NOT covered: the index (a later task).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as S from '../lib/store.ts';
import { genPlan } from './fixtures/gen.ts';
import { nodePath } from '../lib/store2/layout.ts';
import { GRAPH_FILES, CORE_NODE_TYPES, RELATIONS, DERIVED_RELATIONS, V1_HOME, REL_SEMANTICS, EXT_TYPE_RE, EXT_REL_RE, isNodeType, idProblem, sysOk, xidOk, parseGraphFile, readGraphFiles } from '../lib/graph/files.ts';
import type { GraphNotes, GraphDataErrorCode, Person, Sprint, Epic, Repo, CapacityRow, Link, Xref } from '../lib/graph/files.ts';
import { GRAPH_SRC_FILES, SRC_FILES } from '../src/commands/shared.ts';
import { writePlanFile } from './helpers/plan-dir.ts';

const ROOT = path.join(import.meta.dirname, '..');
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

test('links: only the stored relations (relates_to, depends_on, touches, satisfies, affects, supersedes, member_of, alias_of) are hand-authored; LINK_UNKNOWN_REL only for a non-x- unknown relation', () => {
  assert.deepEqual([...RELATIONS], ['relates_to', 'depends_on', 'touches', 'satisfies', 'affects', 'supersedes', 'member_of', 'alias_of']);
  for (const rel of RELATIONS) assert.equal(parse('links.jsonl', [{ ...ROW['links.jsonl'], rel }]).length, 1, rel);
  const codes: GraphDataErrorCode[] = ['LINK_UNKNOWN_REL', 'LINK_DERIVED_REL', 'DUPLICATE_NODE', 'XREF_BAD_ID'];
  assert.equal(codes.length, 4, 'every code a graph reader throws');
  const e = msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], rel: 'blocks' }])) as string;
  assert.equal(e, 'LINK_UNKNOWN_REL links.jsonl:1: "rel" blocks is not a relation of links.jsonl (relates_to, depends_on, touches, satisfies, affects, supersedes, member_of, alias_of or x-<sys>/<rel>)');
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

test('node type grammar: twelve core types, extension types x-<sys>.<kind>, nothing else', () => {
  assert.deepEqual([...CORE_NODE_TYPES], ['ticket', 'person', 'sprint', 'epic', 'plantask', 'openitem', 'plan', 'doc', 'repo', 'requirement', 'decision', 'team']);
  for (const t of [...CORE_NODE_TYPES, 'x-github.pr', 'x-a.b', 'x-linear.issue', `x-${'a'.repeat(24)}.${'b'.repeat(24)}`]) assert.ok(isNodeType(t), t);
  for (const t of ['Ticket', 'x-github', 'x-.pr', 'x-github.', 'x-GitHub.pr', 'github.pr', 'x-a.b.c', `x-${'a'.repeat(25)}.b`, '', 3, null, 'x-1a.b']) assert.ok(!isNodeType(t), String(t));
  assert.ok(EXT_TYPE_RE.test('x-github.pr') && EXT_REL_RE.test('x-github/closes'));
  assert.match(msg(() => parse('links.jsonl', [{ ...ROW['links.jsonl'], to_type: 'task' }])) as string, /^links\.jsonl:1: "to_type" must be a node type \(ticket, person, .*, team or x-<sys>\.<kind>\)$/);
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
  writePlanFile(d, 'links.jsonl', jl([{ from: 'pr-12', from_type: 'x-github.pr', rel: 'x-github/closes', to: 'T-1', to_type: 'ticket' }, { from: 'T-1', from_type: 'ticket', rel: 'relates_to', to: 'T-2', to_type: 'ticket' }]));
  writePlanFile(d, 'xrefs.jsonl', jl([{ type: 'ticket', id: 'T-1', sys: 'newtracker:eng', xid: 'ENG-1' }, { type: 'x-github.pr', id: 'pr-12', sys: 'github:o/r', xid: 'pull/12' }]));
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

test('readGraphFiles: absent files give nothing, a damaged node file is skipped, errors name the file', () => {
  const d = tmp();
  const g = readGraphFiles(d);
  assert.deepEqual([g.people, g.sprints, g.epics, g.repos, g.capacity, g.links, g.xrefs], [[], [], [], [], [], [], []]);
  assert.equal(g.ext, 0); assert.deepEqual(g.warnings, []);
  for (const f of GRAPH_FILES) writePlanFile(d, f, jl([ROW[f] as object]));
  const all = readGraphFiles(d);
  assert.deepEqual([all.people.length, all.sprints.length, all.epics.length, all.repos.length, all.capacity.length, all.links.length, all.xrefs.length], [1, 1, 1, 1, 1, 1, 1]);
  const first: [Person, Sprint, Epic, Repo, CapacityRow, Link, Xref] = [all.people[0] as Person, all.sprints[0] as Sprint, all.epics[0] as Epic, all.repos[0] as Repo, all.capacity[0] as CapacityRow, all.links[0] as Link, all.xrefs[0] as Xref];
  assert.deepEqual(first.map((r) => r.schema_version), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.equal(all.people[0]?.id, 'Ana'); assert.equal(all.sprints[0]?.n, 3); assert.equal(all.capacity[0]?.review_h, 4); assert.equal(all.links[0]?.from_type, 'ticket'); assert.equal(all.xrefs[0]?.sys, 'jira:acme');
  // a damaged node file (here a conflict) is skipped by the reader, never thrown: the other epics are read
  const dn = path.dirname(nodePath(d, 'epic', 'E')); fs.mkdirSync(dn, { recursive: true }); fs.writeFileSync(path.join(dn, 'bad~00000000.pg'), 'id "bad"\n<<<<<<< a\nname "x"\n=======\nname "y"\n>>>>>>> b\n');
  assert.deepEqual(readGraphFiles(d).epics.map((e) => e.id), ['E-1']); fs.rmSync(path.join(dn, 'bad~00000000.pg'));
  writePlanFile(d, 'epics.jsonl', '{"id":"E","name":3}\n');
  assert.equal(msg(() => readGraphFiles(d)), 'epics.jsonl:1: "name" must be a string');
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
  assert.equal(S.canonFile([ROW['links.jsonl'] as S.Rec, ROW['links.jsonl'] as S.Rec], S.SCHEMAS['links.jsonl']), '{"from":"T-1","from_type":"ticket","rel":"relates_to","to":"T-2","to_type":"ticket"}\n', 'two equal lines collapse');
  assert.equal(S.canonFile([{ n: 10 }, { n: 9 }, { n: -1 }], S.SCHEMAS['sprints.jsonl']), '{"n":-1}\n{"n":10}\n{"n":9}\n', 'sorted as text, like every key');
});

// ---------- a directory without graph files: its card line changes only by the digest when a graph file appears ----------
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const runIn = (cwd: string, args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'bin/plangraph'), ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data') } });
function v1Repo(): string {
  const d = tmp('graphv1-'); execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(runIn(d, ['init']).status, 0);
  const p = genPlan({ n: 12, people: 3, seed: 5, cap: 9 }), b = path.join(d, '.plangraph');
  writePlanFile(b, 'tickets.jsonl', jl(p.tickets)); writePlanFile(b, 'edges.jsonl', jl(p.edges)); writePlanFile(b, 'schedule.jsonl', jl(p.schedule));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify(p.config));
  return d;
}

test('card line of a v1-only directory: a present graph file changes only its digest, a removed one gives the line back', () => {
  const d = v1Repo();
  const old = runIn(d, ['card', '--line']), now = runIn(d, ['card', '--line']);
  assert.equal(old.status, 0, old.stderr);
  assert.deepEqual([now.status, now.stdout, now.stderr], [0, old.stdout, old.stderr], 'identical bytes without a graph file');
  assert.match(now.stdout, /^plangraph: 12 tickets, last sprint \d+, \d+ violations @[0-9a-f]{8}\n$/);
  const digest = (s: string) => s.replace(/@[0-9a-f]{8}\n$/, '');
  const seen = new Set([now.stdout]);
  for (const f of GRAPH_FILES) {
    const b = path.join(d, '.plangraph');
    writePlanFile(b, f, jl([ROW[f] as object]));
    const r = runIn(d, ['card', '--line']);
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.equal(digest(r.stdout), digest(now.stdout), `${f}: only the digest changes`);
    assert.ok(!seen.has(r.stdout), `${f}: the digest changed`); seen.add(r.stdout);
    writePlanFile(b, f, ''); // no row left: the kind has no data again
    assert.equal(runIn(d, ['card', '--line']).stdout, old.stdout, `${f}: removed again, the first line is back`);
  }
});

test('REL_SEMANTICS is exactly the frozen table; every known sys is a known sys; keys never run together; lines are counted after a BOM', () => {
  assert.deepEqual({ ...REL_SEMANTICS }, { needs: 'order', assigned_to: 'load', scheduled_in: 'slot', held_by: 'gate', belongs_to: 'group', implements: 'trace', part_of: 'trace', specified_by: 'trace', touches: 'trace', tracked_by: 'identity', relates_to: 'info', depends_on: 'info', owned_by: 'info', satisfies: 'trace', affects: 'info', supersedes: 'info', member_of: 'info', alias_of: 'info' });
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
