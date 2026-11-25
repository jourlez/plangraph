// Property (h): parse/serialize canonical round trip per docs/FORMAT.md, for every record shape over a small value domain.
// Layer 1 (pure, lib/store.ts): for every schema (and an unknown file), every record with one or two known fields set to each value of
// V (absent, null, string, integer, fraction, boolean, object with unsorted keys, array) plus an unknown field (absent, string, nested
// object), and a duplicate-line file: canonLine == a clean-room canonical serializer (known fields in schema order, unknown sorted, nested
// keys sorted, set fields sorted and deduplicated, arrays otherwise in order), and canon(parse(canon(x))) == canon(x) (idempotent).
// Layer 2 (CLI, in-process): `plangraph build` then `plangraph export` for every exported table, every known column x V x unknown field:
//   a boolean, object or array in a known TEXT column is a data error (exit 2, `file:line: "field" must be a string or a number`);
//   an integer column follows its validator (sp: number >= 0, fractions allowed; sprint: whole number; v2_sprint: number);
//   everything else round-trips byte for byte (canonical file of the exported table == canonical input), except that a schedule row
//   without `version` comes back with `"version":"current"` (the documented exception; an explicit `"version":null` too, because every
//   reader, lib/model.ts and the build, takes null as the default there: the oracle follows the library on this reading).
// NOT covered: learnings.jsonl and refs.jsonl (never exported), values outside V (big integers beyond 2^53, unicode edge cases), more
// than two known fields varied at once, the migration framework.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMAS, canonLine, canonFile, parseJsonlText, specOf } from '../../lib/store.ts';
import type { Spec } from '../../lib/store.ts';
import { makeRepo, run, tmpBase, rmBase } from './cli.ts';
import type { Level } from './enum.ts';

type Rec = Record<string, unknown>;
/** the part of a store.ts schema this file reads */
interface Schema { order?: string[]; sets?: string[] }
const ABSENT = Symbol('absent');
const V: unknown[] = [ABSENT, null, 'x', 7, 1.5, true, { b: 1, a: [2, 1] }, ['z', 'y', 'z']];
const U: unknown[] = [ABSENT, 'u', { y: 1, x: { d: 2, c: 1 } }];

// ---- clean-room canonical serializer ----
function cv(v: unknown, isSet = false): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) { let xs = v.map((x: unknown) => cv(x)); if (isSet) xs = [...new Set(xs)].sort(); return '[' + xs.join(',') + ']'; }
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => (v as Rec)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + cv((v as Rec)[k])).join(',') + '}'; // typeof v === 'object' and not null
  return JSON.stringify(v);
}
function oracleLine(rec: Rec, schema: Schema): string {
  const ks = Object.keys(rec), order = schema.order || [], sets = new Set(schema.sets || []);
  const known = order.filter((k) => ks.includes(k)), rest = ks.filter((k) => !order.includes(k)).sort();
  return '{' + [...known, ...rest].map((k) => JSON.stringify(k) + ':' + cv(rec[k], sets.has(k))).join(',') + '}';
}
const fail: (what: string, x: unknown) => never = (what, x) => assert.fail(`format: ${what}\n${JSON.stringify(x)}`);
const setF = (r: Rec, f: string, v: unknown): void => { if (v !== ABSENT) r[f] = v; };

export function assurePure(lvl: Level): { records: number; files: number } {
  const counts = { records: 0, files: 0 };
  const schemas: Array<[string, Spec]> = [...Object.entries(SCHEMAS), ['other.jsonl', specOf(null)]];
  for (const [file, schema] of schemas) {
    const fields = (schema.order || []).length ? schema.order : ['a', 'b'];
    const pairs: string[][] = [];
    for (let i = 0; i < fields.length; i++) for (let j = lvl === 'full' ? i : fields.length; j < fields.length; j++) pairs.push([fields[i], fields[j]]);
    for (let i = 0; i < fields.length; i++) pairs.push([fields[i]]);
    const recs: Rec[] = [];
    for (const fs2 of pairs) for (const a of V) for (const b of fs2.length > 1 ? V : [ABSENT]) for (const u of U) {
      const r: Rec = {}; setF(r, fs2[0], a); if (fs2.length > 1 && fs2[1] !== fs2[0]) setF(r, fs2[1], b); setF(r, 'zz_unknown', u); if (u !== ABSENT) r.aa_unknown = 0; // two unknown fields: their sorted order is checked
      if (!Object.keys(r).length) continue;
      const line = canonLine(r, schema), want = oracleLine(r, schema);
      if (line !== want) fail(`${file}: canonLine differs`, { r, line, want });
      const back = canonLine(JSON.parse(line), schema);
      if (back !== line) fail(`${file}: line not idempotent`, { r, line, back });
      recs.push(r); counts.records++;
    }
    const text = canonFile([...recs, ...recs.slice(0, 5)], schema), again = canonFile(parseJsonlText(text, file), schema);
    if (again !== text) fail(`${file}: file not idempotent`, {});
    if (text && text.split('\n').filter(Boolean).length !== new Set(text.split('\n').filter(Boolean)).size) fail(`${file}: duplicate line kept`, {});
    counts.files++;
  }
  return counts;
}

// ---- layer 2: build + export through the CLI ----
const TABLES: Record<string, { base: (i: number) => Rec; ints: Record<string, string> }> = {
  'tickets.jsonl': { base: (i: number) => ({ key: `K${i}` }), ints: { sp: 'nonneg', v2_sprint: 'num' } },
  'schedule.jsonl': { base: (i: number) => ({ key: `K${i}`, owner: 'Ana', sprint: 1 }), ints: { sprint: 'int' } },
  'edges.jsonl': { base: (i: number) => ({ consumer: `C${i}`, producer: 'P' }), ints: {} },
  'evidence.jsonl': { base: (i: number) => ({ key: `K${i}`, source: 's', verdict: 'READY' }), ints: {} },
  'findings.jsonl': { base: (i: number) => ({ key: `K${i}`, kind: 'k', text: 't' }), ints: {} },
  'meta.jsonl': { base: (i: number) => ({ k: `k${i}`, v: 'x' }), ints: {} },
};
const REQUIRED: Record<string, string[]> = { 'tickets.jsonl': ['key'], 'schedule.jsonl': ['key'], 'edges.jsonl': ['consumer', 'producer'], 'evidence.jsonl': [], 'findings.jsonl': ['key', 'kind', 'text'], 'meta.jsonl': [] };
const PK: Record<string, string[]> = { 'tickets.jsonl': ['key'], 'schedule.jsonl': ['key', 'version'], 'edges.jsonl': ['consumer', 'producer'], 'findings.jsonl': ['key', 'kind', 'text'], 'meta.jsonl': ['k'], 'evidence.jsonl': [] };
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// The expected data error for one field value, or null (stated from docs/FORMAT.md and the documented validators).
function expectedError(file: string, f: string, v: unknown): string | null {
  if (v === ABSENT) return REQUIRED[file].includes(f) ? `missing "${f}"` : null;
  const kind = TABLES[file].ints[f];
  if (kind) {
    if (v === null) return null;
    if (!isNum(v)) return `"${f}" must be a number`;
    if (kind === 'int' && !Number.isSafeInteger(v)) return `"${f}" must be a whole number`;
    if (kind === 'nonneg' && v < 0) return `"${f}" must not be negative`;
    return null;
  }
  if (REQUIRED[file].includes(f)) return v === null ? `missing "${f}"` : typeof v !== 'string' ? `"${f}" must be a string` : null;
  if (file === 'schedule.jsonl' && (f === 'owner' || f === 'version') && v !== null && typeof v !== 'string') return `"${f}" must be a string`;
  if (file === 'tickets.jsonl' && f === 'v2_owner' && v !== null && typeof v !== 'string') return `"${f}" must be a string`;
  if (file === 'tickets.jsonl' && f === 'impl_status' && v !== null) return '"impl_status" must be one of todo, in_progress, done, blocked';
  if (v === null || typeof v === 'string' || typeof v === 'number') return null;
  return `"${f}" must be a string or a number`;
}

export async function assureBuildExport(lvl: Level): Promise<{ valid: number; invalid: number; builds: number }> {
  const counts = { valid: 0, invalid: 0, builds: 0 };
  const base = tmpBase();
  try {
    for (const [file, spec] of Object.entries(TABLES)) {
      const schema = SCHEMAS[file as keyof typeof SCHEMAS], /* TABLES and SCHEMAS list the same files */ fields = lvl === 'full' ? schema.order : schema.order.slice(0, 2);
      const valid: Array<{ r: Rec; err: string | null; f: string }> = [], invalid: Array<{ r: Rec; err: string | null; f: string }> = []; let i = 0;
      for (const f of fields) for (const v of [...V, -1, '5']) for (const u of PK[file].includes(f) ? [ABSENT] : lvl === 'full' ? U : [ABSENT, 'u']) { // a PK value twice would be a duplicate key
        if (PK[file].includes(f) && !(v === ABSENT || typeof v !== 'string')) continue; // a PK string value collides; a bad one is tested
        const r = spec.base(i++); if (v === ABSENT) delete r[f]; else r[f] = v;
        setF(r, 'zz_unknown', u);
        const err = expectedError(file, f, v);
        (err ? invalid : valid).push({ r, err, f });
      }
      // one build + export for all valid records of the table
      const root = makeRepo(base, { 'format.json': '{"format_version":1,"min_reader":1}\n', [file]: valid.map((x) => x.r) });
      const b = await run(root, ['build']); counts.builds++;
      if (b.code !== 0) fail(`${file}: build of valid records failed`, { err: b.err, out: b.out });
      const e = await run(root, ['export']);
      if (e.code !== 0) fail(`${file}: export failed`, { err: e.err });
      const got = fs.readFileSync(path.join(root, '.plangraph', file), 'utf8');
      // schedule: a row without `version` (absent, or null: model.ts and build both read it with `??`) comes back as "current"
      const want = canonFile(valid.map((x) => (file === 'schedule.jsonl' && x.r.version == null ? { ...x.r, version: 'current' } : x.r)), schema);
      if (got !== want) {
        const gl = got.split('\n'), wl = want.split('\n'), d = wl.findIndex((l, k) => l !== gl[k]);
        fail(`${file}: build/export round trip differs`, { want: wl[d], got: gl[d] });
      }
      counts.valid += valid.length;
      // every invalid record alone: exit 2 and the documented message at line 1
      for (const x of lvl === 'full' ? invalid : invalid.slice(0, 3)) {
        const root2 = makeRepo(base, { 'format.json': '{"format_version":1,"min_reader":1}\n', [file]: [x.r] });
        const r = await run(root2, ['build']); counts.builds++;
        if (r.code !== 2 || !r.err.includes(`${file}:1: ${x.err}`)) fail(`${file}: expected data error`, { r: x.r, want: x.err, code: r.code, err: r.err });
        counts.invalid++;
      }
    }
  } finally { rmBase(base); }
  return counts;
}
