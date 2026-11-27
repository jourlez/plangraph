// EntityStore: the PlanStore backend that keeps a plan as entity files (spec 4.0). It implements the mapping of every old file to its new home:
//   tickets            nodes/ticket/<key>            fields of the row
//   edges              `needs` link lines of the consumer ticket: links {"rel":"needs","to":<producer>,"attrs":{kind,note,...}}
//   refs               fields plans, files, fp_files, jira_updated, audited_at (and any other column) on the ticket node; a ref keyed
//                      `sp:<slug>` (no `/`, a plan or epic row) lives on nodes/epic/<key>
//   people sprints epics repos   nodes/person|sprint|epic|repo; capacity rows are repeated `capacity {"sprint":..,"sp":..,"review_h":..}` lines on the person
//   links xrefs        `links` and `xrefs` lines of the source node; a source type with no node directory (plantask, plan, doc, openitem, x-*) lives
//                      in nodes/ext/ keyed `pg:<type>/<id>` (one directory, so the hash layout and `check` see it: nodes/ext/<h2>/..., not nodes/ext/<type>/..)
//   schedule           schedules/<version>.jsonl (immutable, all rows of the schedule in one version) plus schedules/CURRENT
//   evidence findings learnings   sealed run files (runs/<evidence|findings|learnings>/<yyyy-mm>/<h8>.jsonl)
//   openitem           nodes/openitem/ keyed `<key>|<kind>`; the status and any other column are fields
//   meta               meta.jsonl, unchanged (a single canonical file: MetaFile below)
// Every column is kept. A node that exists only to hold a part of another kind (a ref without a ticket row, a link whose source has no row) carries
// `primary false`; a node that holds a ref row lists its stored names in `refcols` (a column whose name a ticket field already uses is stored as
// `ref_<column>` and named in `refmap`). readKind returns the rows in canonical order with the schema defaults.
import fs from 'node:fs';
import path from 'node:path';
import { canonFile, readRecords, SCHEMAS, withDefaults, parseJsonlText } from '../store.ts';
import type { Schema, Rec } from '../store.ts';
import { kindFile, precheckTargets, refuseWrite, writeState } from '../planstore.ts';
import type { Kind, PlanStore, Row, WriteOpts, WriteResult, ReadTextOpts, StoreCtx } from '../planstore.ts';
import { IngestError, parseJsonl, readJsonl, readDataCapped, presentDataFile, DATA_REFUSALS } from '../jsonl.ts';
import { validators } from '../schema.ts';
import { assertInside } from '../fsafe.ts';
import { listNodeFiles, loadRaw, refuseOccupied } from './nodes.ts';
import { nodePath } from './layout.ts';
import { formatPg, MAX_LINE } from './pg.ts';
import { withTxn } from './txn.ts';
import { writeRun, runFiles, readRuns, writeSchedule, readSchedule, setCurrent, currentVersion, scheduleVersions } from './batches.ts';

type Fields = Record<string, unknown>;
interface Parts { primary: Fields | null; ref: Fields | null; needs: Fields[]; links: Fields[]; xrefs: Fields[]; capacity: Fields[] }
interface Entry { dir: string; id: string; parts: Parts; text: string | null }

const NODE_DIRS = ['ticket', 'person', 'sprint', 'epic', 'repo', 'requirement', 'decision', 'team', 'ext', 'openitem'] as const;
const LINK_SOURCES: ReadonlySet<string> = new Set(['ticket', 'person', 'sprint', 'epic', 'repo', 'requirement', 'decision', 'team']);
const RUN_NAMES: Readonly<Partial<Record<Kind, string>>> = { evidence: 'evidence', finding: 'findings', learning: 'learnings' };
// the node directories each kind reads and writes
const DIRS: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  ticket: ['ticket'], edge: ['ticket'], ref: ['ticket', 'epic'], epic: ['epic'], person: ['person'], capacity: ['person'], sprint: ['sprint'], repo: ['repo'], requirement: ['requirement'], decision: ['decision'], team: ['team'],
  openitem: ['openitem'], link: NODE_DIRS.filter((d) => d !== 'openitem'), xref: NODE_DIRS.filter((d) => d !== 'openitem'),
};
const RESERVED: ReadonlySet<string> = new Set(['id', 'links', 'xrefs', 'capacity', 'primary', 'refcols', 'refmap']);
const isObj = (v: unknown): v is Fields => v !== null && typeof v === 'object' && !Array.isArray(v);
const emptyParts = (): Parts => ({ primary: null, ref: null, needs: [], links: [], xrefs: [], capacity: [] });
const without = (r: Fields, drop: ReadonlySet<string> | readonly string[]): Fields => { const d = new Set(drop), o: Fields = {}; for (const k of Object.keys(r)) if (!d.has(k) && r[k] !== undefined) o[k] = r[k]; return o; };
const text1 = (v: unknown, what: string): string => { if (typeof v !== 'string' || v === '') throw new TypeError(`${what} must be a non-empty string`); return v; };

/** How a primary kind names its node: the directory, the columns that become the id, and the id from a row / the row from an id. */
const PRIMARY: Readonly<Record<string, { dir: string; idCols: readonly string[]; id(r: Fields): string; row(id: string, f: Fields): Fields }>> = {
  ticket: { dir: 'ticket', idCols: ['key'], id: (r) => text1(r.key, 'a ticket key'), row: (id, f) => ({ key: id, ...f }) },
  person: { dir: 'person', idCols: ['id'], id: (r) => text1(r.id, 'a person id'), row: (id, f) => ({ id, ...f }) },
  epic: { dir: 'epic', idCols: ['id'], id: (r) => text1(r.id, 'an epic id'), row: (id, f) => ({ id, ...f }) },
  repo: { dir: 'repo', idCols: ['id'], id: (r) => text1(r.id, 'a repo id'), row: (id, f) => ({ id, ...f }) },
  requirement: { dir: 'requirement', idCols: ['id'], id: (r) => text1(r.id, 'a requirement id'), row: (id, f) => ({ id, ...f }) },
  decision: { dir: 'decision', idCols: ['id'], id: (r) => text1(r.id, 'a decision id'), row: (id, f) => ({ id, ...f }) },
  team: { dir: 'team', idCols: ['id'], id: (r) => text1(r.id, 'a team id'), row: (id, f) => ({ id, ...f }) },
  sprint: { dir: 'sprint', idCols: ['n'], id: (r) => { if (typeof r.n === 'number' && Number.isFinite(r.n)) return String(r.n); return text1(r.n, 'a sprint n'); }, row: (id, f) => ({ n: /^-?\d+$/.test(id) ? Number(id) : id, ...f }) },
  openitem: { dir: 'openitem', idCols: ['key', 'kind'], id: (r) => `${text1(r.key, 'an open item key')}|${text1(r.kind, 'an open item kind')}`, row: (id, f) => { const i = id.lastIndexOf('|'); return { key: id.slice(0, i), kind: id.slice(i + 1), ...f }; } },
};

const refDirOf = (key: string): string => (key.startsWith('sp:') && !key.includes('/') ? 'epic' : 'ticket');
const linkDirOf = (type: string, id: string): { dir: string; id: string } => (LINK_SOURCES.has(type) ? { dir: type, id } : { dir: 'ext', id: `pg:${type}/${id}` });
const fromExt = (id: string): { type: string; id: string } => { const rest = id.slice(3), i = rest.indexOf('/'); return { type: rest.slice(0, i), id: rest.slice(i + 1) }; };
const sourceOf = (e: Entry): { type: string; id: string } => (e.dir === 'ext' ? fromExt(e.id) : { type: e.dir, id: e.id });

function decode(dir: string, node: Fields): Parts {
  const p = emptyParts(), stored = new Set<string>();
  const refcols = Array.isArray(node.refcols) ? (node.refcols as string[]) : null, refmap = isObj(node.refmap) ? (node.refmap as Record<string, string>) : {};
  if (refcols) {
    p.ref = {};
    for (const s of refcols) { stored.add(s); if (node[s] !== undefined) p.ref[refmap[s] ?? s] = node[s]; }
  }
  if (node.primary !== false && dir !== 'ext') p.primary = without(node, new Set([...RESERVED, ...stored]));
  for (const l of (Array.isArray(node.links) ? node.links : []) as Fields[]) {
    if (!isObj(l)) continue;
    if (l.rel === 'needs' && l.k !== 'link') p.needs.push(l); else p.links.push(l);
  }
  for (const x of (Array.isArray(node.xrefs) ? node.xrefs : []) as Fields[]) if (isObj(x)) p.xrefs.push(x);
  for (const c of (Array.isArray(node.capacity) ? node.capacity : []) as Fields[]) if (isObj(c)) p.capacity.push(c);
  return p;
}

function encode(e: Entry): string | null {
  const p = e.parts;
  if (!p.primary && !p.ref && !p.needs.length && !p.links.length && !p.xrefs.length && !p.capacity.length) return null;
  const f: Fields = {};
  for (const [k, v] of Object.entries(p.primary ?? {})) { if (RESERVED.has(k)) throw new TypeError(`${e.dir} ${e.id.slice(0, 60)}: the column name ${k} is reserved by the entity layout`); f[k] = v; }
  if (!p.primary) f.primary = false;
  if (p.ref) {
    const cols: string[] = [], map: Record<string, string> = {};
    for (const [c, v] of Object.entries(p.ref)) {
      if (v === undefined) continue;
      let s = c;
      if (RESERVED.has(c) || Object.hasOwn(f, c)) { s = `ref_${c}`; if (Object.hasOwn(f, s)) throw new TypeError(`${e.dir} ${e.id.slice(0, 60)}: the ref column ${c} collides with a ticket column`); map[s] = c; }
      f[s] = v; cols.push(s);
    }
    f.refcols = cols.sort();
    if (Object.keys(map).length) f.refmap = map;
  }
  const links = [...p.needs, ...p.links];
  if (links.length) f.links = links;
  if (p.xrefs.length) f.xrefs = p.xrefs;
  if (p.capacity.length) f.capacity = p.capacity;
  const out = formatPg({ id: e.id, ...f });
  for (const line of out.split('\n')) if (Buffer.byteLength(line) > MAX_LINE) throw new Error(`${e.dir} ${e.id.slice(0, 60)}: a field is longer than 8 KiB, which a .pg line cannot hold`);
  return out;
}

class Model {
  readonly entries = new Map<string, Entry>();
  readonly root: string;
  readonly dirs: ReadonlySet<string>;
  /** Files that exist but are not the node of any entry: a damaged file (conflict markers, a bad line, oversize) or a file that holds another id.
   * They are skipped when reading (`check` reports them); a write that would land on one is refused, so it is never overwritten. */
  readonly occupied = new Map<string, string>();
  constructor(root: string, dirs: readonly string[]) {
    this.root = root;
    this.dirs = new Set(dirs);
    for (const dir of dirs) {
      for (const abs of listNodeFiles(root, dir)) {
        const r = loadRaw(root, abs);
        if ('problem' in r) { if (r.problem.code !== 'SYMLINK') this.occupied.set(abs, r.problem.code); continue; } // a symlink is refused by the transaction itself
        if (abs !== nodePath(root, dir, r.node.id)) { this.occupied.set(abs, 'it holds a different id'); continue; }
        this.entries.set(`${dir}\0${r.node.id}`, { dir, id: r.node.id, parts: decode(dir, r.node), text: r.text });
      }
    }
  }
  at(dir: string, id: string): Entry {
    const k = `${dir}\0${id}`;
    let e = this.entries.get(k);
    if (!e) { e = { dir, id, parts: emptyParts(), text: null }; this.entries.set(k, e); }
    return e;
  }
  find(dir: string, id: string): Entry | undefined { return this.entries.get(`${dir}\0${id}`); }
  inDir(dirs: readonly string[]): Entry[] { return [...this.entries.values()].filter((e) => dirs.includes(e.dir)); }
}

// ---------- meta.jsonl: the one plan file that stays a single canonical file ----------
const MAX = 64 * 1024 * 1024;
type Coded = Error & { code?: string };
class MetaFile {
  readonly ctx: StoreCtx;
  readonly name = kindFile('meta');
  constructor(ctx: StoreCtx) { this.ctx = ctx; }
  get path(): string { return path.join(this.ctx.dir, this.name); }
  rows(defaults: boolean): Row[] { return readRecords(this.ctx.dir, this.name, { defaults }); }
  validated(validate: ((r: Rec) => string | null) | undefined): Row[] { return readJsonl(this.path, { validate }); }
  text(maxBytes = MAX, bare = false): string | null {
    if (!presentDataFile(this.path)) return null; // a symlink is refused, as in build
    try { return readDataCapped(this.path, maxBytes); }
    catch (e) { if (!bare && DATA_REFUSALS.has((e as Coded).code as string)) throw new IngestError(`${this.name}: ${(e as Coded).message}`); throw e; } // whatever was thrown: a code it lacks is not a refusal
  }
  source(maxBytes: number): string | null {
    // a source file is a regular file inside the plan directory: a symlink (even to a file outside the repo) is refused before any read
    let st = null; try { st = fs.lstatSync(this.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // fs throws errno errors
    if (st?.isSymbolicLink()) throw new IngestError(`${this.name}: is a symlink, not a regular file`);
    try { return readDataCapped(this.path, maxBytes); } // O_NOFOLLOW + dev/ino check: no swap after the lstat
    catch (e) { // fs errno errors and readDataCapped's coded refusals
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (DATA_REFUSALS.has((e as { code: string }).code)) throw new IngestError(`${this.name}: ${(e as Error).message}`);
      throw e;
    }
  }
  write(text: string, precheck: boolean): WriteResult {
    if (precheck) precheckTargets(this.ctx, [this.path]);
    writeState(this.ctx, this.path, text);
    return { kind: 'meta', file: this.name, bytes: Buffer.byteLength(text) };
  }
  exists(): boolean { return fs.existsSync(this.path); }
}

const canonRows = (kind: Kind, rows: readonly Row[]): Row[] => parseJsonlText(canonFile(rows, SCHEMAS[kindFile(kind)] as Schema), kindFile(kind));

export class EntityStore implements PlanStore {
  readonly ctx: StoreCtx;
  readonly #m: MetaFile;
  readonly #txn: { durable?: boolean };
  /** durable: false skips the fsync of staged files (the fixture conversion in lib/store2/adopt.ts); every other caller keeps the default. */
  constructor(ctx: StoreCtx, { durable = true }: { durable?: boolean } = {}) { this.ctx = ctx; this.#m = new MetaFile(ctx); this.#txn = durable ? {} : { durable: false }; }
  get #dir(): string { return this.ctx.dir; }

  // ---------- reading ----------
  // The parsed node files of ONE readKinds call, shared by the kinds that live in the same files (link, ref and xref all read every ticket file: parsing them
  // once per kind tripled the cost of loadExtras on a large plan). Outside readKinds every read parses the files as they are on disk now.
  #pool: Model[] | null = null;
  #modelFor(dirs: readonly string[]): Model {
    const have = this.#pool?.find((m) => dirs.every((d) => m.dirs.has(d)));
    if (have) return have;
    const m = new Model(this.#dir, dirs);
    this.#pool?.push(m);
    return m;
  }
  /** readKind for several kinds over one parse of the node files they share; the rows come back in the order of `kinds`. */
  readKinds(kinds: readonly Kind[], opts: { defaults?: boolean } = {}): Row[][] {
    this.#pool = [];
    try { return kinds.map((k) => this.readKind(k, opts)); } finally { this.#pool = null; }
  }
  #raw(kind: Kind): Row[] {
    if (kind === 'schedule') { const v = currentVersion(this.#dir); return v === null ? [] : (() => { try { return readSchedule(this.#dir, v); } catch { return []; } })(); }
    const run = RUN_NAMES[kind];
    if (run) return readRuns(this.#dir, run);
    const m = this.#modelFor(DIRS[kind] as readonly string[]);
    const out: Row[] = [];
    if (kind in PRIMARY) {
      const pr = PRIMARY[kind] as (typeof PRIMARY)[string];
      for (const e of m.inDir([pr.dir])) if (e.parts.primary) out.push(pr.row(e.id, e.parts.primary));
    } else if (kind === 'edge') {
      for (const e of m.inDir(['ticket'])) for (const l of e.parts.needs) out.push({ consumer: e.id, producer: l.to, ...(isObj(l.attrs) ? l.attrs : {}) });
    } else if (kind === 'ref') {
      for (const e of m.inDir(['ticket', 'epic'])) if (e.parts.ref) out.push({ key: e.id, ...e.parts.ref });
    } else if (kind === 'capacity') {
      for (const e of m.inDir(['person'])) for (const c of e.parts.capacity) out.push({ person: e.id, ...c });
    } else if (kind === 'link') {
      for (const e of m.inDir(DIRS.link as readonly string[])) { const s = sourceOf(e); for (const l of e.parts.links) out.push({ from: s.id, from_type: s.type, ...without(l, ['k']) }); }
    } else if (kind === 'xref') {
      for (const e of m.inDir(DIRS.xref as readonly string[])) { const s = sourceOf(e); for (const x of e.parts.xrefs) out.push({ type: s.type, id: s.id, ...x }); }
    }
    return out;
  }

  readKind(kind: Kind, { defaults = true }: { defaults?: boolean } = {}): Row[] {
    if (kind === 'meta') return this.#m.rows(defaults);
    const rows = canonRows(kind, this.#raw(kind));
    return defaults ? rows.map((r) => withDefaults(SCHEMAS[kindFile(kind)] as Schema, r)) : rows;
  }

  readValidated(kind: Kind, { validate }: { maxBytes?: number; maxLine?: number; validate?: ((r: Row) => string | null) | undefined } = {}): Row[] {
    if (kind === 'meta') return this.#m.validated(validate);
    const file = kindFile(kind), check = validate ?? validators[file];
    return parseJsonl(this.#asText(kind), file, { validate: check });
  }

  #asText(kind: Kind): string { return canonFile(this.readKind(kind, { defaults: false }), SCHEMAS[kindFile(kind)] as Schema); }

  readText(kind: Kind, opts: ReadTextOpts = {}): string | null {
    if (kind === 'meta') return this.#m.text(opts.maxBytes, opts.bare);
    return this.exists(kind) ? this.#asText(kind) : null;
  }

  readSource(kind: Kind, maxBytes: number): string | null {
    if (kind === 'meta') return this.#m.source(maxBytes);
    if (!this.exists(kind)) return null;
    const t = this.#asText(kind);
    if (Buffer.byteLength(t) > maxBytes) throw new IngestError(`${kindFile(kind)}: file too large (limit ${maxBytes} bytes)`);
    return t;
  }

  // ---------- writing ----------
  /** Build the model, run `fn` on it and write the changed files, all inside one transaction under the store lock: what `fn` read is what is on disk when it writes. */
  #mutate(kinds: readonly Kind[], fn: (m: Model) => void): number {
    let count = 0;
    withTxn(this.#dir, (tx) => {
      const m = new Model(this.#dir, [...new Set(kinds.flatMap((k) => DIRS[k] as readonly string[]))]);
      fn(m);
      const changes: Array<{ rel: string; text: string | null }> = [];
      for (const e of m.entries.values()) {
        const t = encode(e);
        if (t === e.text) continue;
        const abs = nodePath(this.#dir, e.dir, e.id), why = m.occupied.get(abs);
        if (t !== null && why !== undefined) refuseOccupied(this.#dir, abs, why); // never write over a file that could not be read as this node
        changes.push({ rel: path.relative(this.#dir, abs), text: t });
      }
      for (const c of changes) { if (c.text === null) tx.remove(c.rel); else tx.write(c.rel, c.text); }
      count = changes.length;
    }, this.#txn);
    return count;
  }

  #replace(kind: Kind, rows: readonly Row[]): void { this.#mutate([kind], (m) => this.#apply(m, kind, rows)); }

  /** Writes several node kinds in one pass over the node files and one transaction (a bulk conversion reads and rewrites each node once, not once per kind). */
  writeKinds(entries: ReadonlyArray<readonly [Kind, readonly Row[]]>): void {
    const kinds = entries.map(([k]) => k);
    for (const k of kinds) if (k === 'meta' || k === 'schedule' || RUN_NAMES[k]) throw new TypeError(`${k} is not a node kind: write it with writeKind`);
    this.#mutate(kinds, (m) => { for (const [k, rows] of entries) this.#apply(m, k, canonRows(k, rows)); });
  }

  /** Adds or replaces rows by identity (a ticket by key, an xref by type+id+sys+xid, a link by from_type+from+rel+to, an edge by consumer+producer, a capacity by
   * person+sprint, a ref by key) and leaves every other row alone, in one read-modify-write under the store lock. Returns how many files changed. */
  addRows(kind: Kind, rows: readonly Row[], opts: WriteOpts = {}): number {
    this.#nodeKind(kind);
    if (opts.precheck) this.precheck([kind]);
    const canon = canonRows(kind, rows);
    return this.#mutate([kind], (m) => this.#add(m, kind, canon));
  }

  /** Removes the rows named by `keys` (rows holding the identity columns of addRows; a primary kind by its id columns). Returns how many files changed. */
  removeRows(kind: Kind, keys: readonly Row[], opts: WriteOpts = {}): number {
    this.#nodeKind(kind);
    if (opts.precheck) this.precheck([kind]);
    return this.#mutate([kind], (m) => this.#remove(m, kind, keys));
  }

  #nodeKind(kind: Kind): void { if (kind === 'meta' || kind === 'schedule' || RUN_NAMES[kind]) throw new TypeError(`${kind} is not a node kind: write it with writeKind`); }

  #add(m: Model, kind: Kind, rows: readonly Row[]): void {
    if (kind in PRIMARY) {
      const pr = PRIMARY[kind] as (typeof PRIMARY)[string];
      for (const r of rows) m.at(pr.dir, pr.id(r)).parts.primary = without(r, pr.idCols);
    } else if (kind === 'edge') {
      for (const r of rows) {
        const to = text1(r.producer, 'an edge producer'), attrs = without(r, ['consumer', 'producer']), p = m.at('ticket', text1(r.consumer, 'an edge consumer')).parts;
        p.needs = [...p.needs.filter((l) => l.to !== to), { rel: 'needs', to, ...(Object.keys(attrs).length ? { attrs } : {}) }];
      }
    } else if (kind === 'ref') {
      for (const r of rows) { const key = text1(r.key, 'a ref key'); m.at(refDirOf(key), key).parts.ref = without(r, ['key']); }
    } else if (kind === 'capacity') {
      for (const r of rows) { const p = m.at('person', text1(r.person, 'a capacity person')).parts; p.capacity = [...p.capacity.filter((c) => c.sprint !== r.sprint), without(r, ['person'])]; }
    } else if (kind === 'link') {
      for (const r of rows) {
        const t = linkDirOf(text1(r.from_type, 'a link from_type'), text1(r.from, 'a link source id')), line = without(r, ['from', 'from_type']), p = m.at(t.dir, t.id).parts;
        p.links = [...p.links.filter((l) => !(l.rel === r.rel && l.to === r.to)), r.rel === 'needs' ? { ...line, k: 'link' } : line];
      }
    } else if (kind === 'xref') {
      for (const r of rows) {
        const t = linkDirOf(text1(r.type, 'an xref type'), text1(r.id, 'an xref id')), p = m.at(t.dir, t.id).parts;
        p.xrefs = [...p.xrefs.filter((x) => !(x.sys === r.sys && x.xid === r.xid)), without(r, ['type', 'id'])];
      }
    }
  }

  #remove(m: Model, kind: Kind, keys: readonly Row[]): void {
    if (kind in PRIMARY) {
      const pr = PRIMARY[kind] as (typeof PRIMARY)[string];
      for (const r of keys) { const e = m.find(pr.dir, pr.id(r)); if (e) e.parts.primary = null; }
    } else if (kind === 'edge') {
      for (const r of keys) { const e = m.find('ticket', text1(r.consumer, 'an edge consumer')); if (e) e.parts.needs = e.parts.needs.filter((l) => l.to !== r.producer); }
    } else if (kind === 'ref') {
      for (const r of keys) { const key = text1(r.key, 'a ref key'), e = m.find(refDirOf(key), key); if (e) e.parts.ref = null; }
    } else if (kind === 'capacity') {
      for (const r of keys) { const e = m.find('person', text1(r.person, 'a capacity person')); if (e) e.parts.capacity = e.parts.capacity.filter((c) => c.sprint !== r.sprint); }
    } else if (kind === 'link') {
      for (const r of keys) { const t = linkDirOf(text1(r.from_type, 'a link from_type'), text1(r.from, 'a link source id')), e = m.find(t.dir, t.id); if (e) e.parts.links = e.parts.links.filter((l) => !(l.rel === r.rel && l.to === r.to)); }
    } else if (kind === 'xref') {
      for (const r of keys) { const t = linkDirOf(text1(r.type, 'an xref type'), text1(r.id, 'an xref id')), e = m.find(t.dir, t.id); if (e) e.parts.xrefs = e.parts.xrefs.filter((x) => !(x.sys === r.sys && x.xid === r.xid)); }
    }
  }

  #apply(m: Model, kind: Kind, rows: readonly Row[]): void {
    const dirs = DIRS[kind] as readonly string[];
    {
      const clear = (fn: (p: Parts) => void) => { for (const e of m.inDir(dirs)) fn(e.parts); };
      if (kind in PRIMARY) {
        const pr = PRIMARY[kind] as (typeof PRIMARY)[string];
        clear((p) => { p.primary = null; });
        for (const r of rows) m.at(pr.dir, pr.id(r)).parts.primary = without(r, pr.idCols);
      } else if (kind === 'edge') {
        clear((p) => { p.needs = []; });
        for (const r of rows) { const attrs = without(r, ['consumer', 'producer']); m.at('ticket', text1(r.consumer, 'an edge consumer')).parts.needs.push({ rel: 'needs', to: text1(r.producer, 'an edge producer'), ...(Object.keys(attrs).length ? { attrs } : {}) }); }
      } else if (kind === 'ref') {
        clear((p) => { p.ref = null; });
        for (const r of rows) { const key = text1(r.key, 'a ref key'); m.at(refDirOf(key), key).parts.ref = without(r, ['key']); }
      } else if (kind === 'capacity') {
        clear((p) => { p.capacity = []; });
        for (const r of rows) m.at('person', text1(r.person, 'a capacity person')).parts.capacity.push(without(r, ['person']));
      } else if (kind === 'link') {
        clear((p) => { p.links = []; });
        for (const r of rows) {
          const t = linkDirOf(text1(r.from_type, 'a link from_type'), text1(r.from, 'a link source id')), line = without(r, ['from', 'from_type']);
          m.at(t.dir, t.id).parts.links.push(r.rel === 'needs' ? { ...line, k: 'link' } : line); // a stored `needs` line is an edge; a link row with that relation is marked
        }
      } else if (kind === 'xref') {
        clear((p) => { p.xrefs = []; });
        for (const r of rows) { const t = linkDirOf(text1(r.type, 'an xref type'), text1(r.id, 'an xref id')); m.at(t.dir, t.id).parts.xrefs.push(without(r, ['type', 'id'])); }
      }
    }
  }

  #replaceRuns(name: string, rows: readonly Row[]): void {
    const before = runFiles(this.#dir, name).map((f) => f.rel);
    const keep = rows.length ? writeRun(this.#dir, name, rows) : '';
    const stale = before.filter((r) => r !== keep);
    if (stale.length) withTxn(this.#dir, (tx) => { for (const r of stale) tx.remove(r); }, this.#txn);
  }

  writeKind(kind: Kind, rows: readonly Row[], opts: WriteOpts = {}): WriteResult {
    if (kind === 'meta') {
      const f = kindFile(kind), t = canonFile(rows, SCHEMAS[f] as Schema);
      if (this.#m.exists() && this.#m.text(MAX, true) === t) return { kind, file: f, bytes: Buffer.byteLength(t) }; // same bytes: the file is left alone
      return this.#m.write(t, Boolean(opts.precheck));
    }
    if (opts.precheck) this.precheck([kind]);
    const canon = canonRows(kind, rows);
    if (kind === 'schedule') { const v = writeSchedule(this.#dir, canon); if (currentVersion(this.#dir) !== v) setCurrent(this.#dir, v); }
    else if (RUN_NAMES[kind]) this.#replaceRuns(RUN_NAMES[kind] as string, canon);
    else this.#replace(kind, canon);
    return { kind, file: this.#label(kind), bytes: Buffer.byteLength(canonFile(rows, SCHEMAS[kindFile(kind)] as Schema)) };
  }

  #label(kind: Kind): string { return kind === 'schedule' ? 'schedules' : RUN_NAMES[kind] ? `runs/${RUN_NAMES[kind]}` : kind === 'meta' ? kindFile(kind) : `nodes/${(DIRS[kind] as readonly string[])[0]}`; }

  writeText(kind: Kind, text: string, opts: WriteOpts = {}): WriteResult {
    if (kind === 'meta') return this.#m.write(text, Boolean(opts.precheck));
    return this.writeKind(kind, parseJsonlText(text, kindFile(kind)), opts);
  }

  writeChanged(entries: ReadonlyArray<{ kind: Kind; rows: readonly Row[]; old: readonly Row[] }>, { validate = false }: { validate?: boolean } = {}): number {
    const out: Array<{ kind: Kind; rows: readonly Row[] }> = [];
    for (const { kind, rows, old } of entries) {
      const f = kindFile(kind), sch = SCHEMAS[f] as Schema, text = canonFile(rows, sch);
      if (validate) parseJsonl(text, f, { validate: validators[f] } as { validate?: (r: Row) => string | null });
      if (text !== canonFile(old, sch)) out.push({ kind, rows });
    }
    this.precheck(out.map((o) => o.kind));
    for (const o of out) this.writeKind(o.kind, o.rows);
    return out.length;
  }

  // ---------- files ----------
  #files(kind: Kind): string[] {
    if (kind === 'meta') return this.#m.exists() ? [this.#m.path] : [];
    if (kind === 'schedule') return [...scheduleVersions(this.#dir).map((v) => path.join(this.#dir, 'schedules', `${v}.jsonl`)), ...(fs.existsSync(path.join(this.#dir, 'schedules', 'CURRENT')) ? [path.join(this.#dir, 'schedules', 'CURRENT')] : [])];
    const run = RUN_NAMES[kind];
    if (run) return runFiles(this.#dir, run).map((f) => path.join(this.#dir, f.rel));
    const dirs = kind in PRIMARY ? [(PRIMARY[kind] as (typeof PRIMARY)[string]).dir] : (DIRS[kind] as readonly string[]);
    return dirs.flatMap((d) => listNodeFiles(this.#dir, d));
  }

  precheck(kinds: readonly Kind[], extra: readonly string[] = []): void {
    const targets: string[] = [];
    for (const k of kinds) {
      if (k === 'meta') { targets.push(path.join(this.#dir, kindFile(k))); continue; }
      const top = k === 'schedule' ? 'schedules' : RUN_NAMES[k] ? path.join('runs', RUN_NAMES[k] as string) : path.join('nodes', (DIRS[k] as readonly string[])[0] as string);
      targets.push(path.join(this.#dir, top));
      try { assertInside(this.ctx.root, path.join(this.#dir, top)); } catch (e) { refuseWrite(e); } // a directory that leaves the repository is refused with the same error as a file
    }
    precheckTargets(this.ctx, [...targets.filter((t) => { try { return !fs.lstatSync(t).isDirectory(); } catch { return true; } }), ...extra]);
  }

  /** True when the kind holds data: a node kind needs a row of its own (a node that exists only to hold a part of another kind, such as a ref on an epic, does not make `epics` present). */
  exists(kind: Kind): boolean {
    if (!this.#files(kind).length) return false;
    return kind === 'meta' || kind === 'schedule' || RUN_NAMES[kind] ? true : this.#raw(kind).length > 0;
  }
  mtimeMs(kind: Kind): number | null {
    let max: number | null = null;
    for (const f of this.#files(kind)) { try { const m = fs.statSync(f).mtimeMs; if (max === null || m > max) max = m; } catch { /* gone */ } }
    return max;
  }
  /** The directories on the way to a kind's files (nodes, nodes/ticket, schedules, runs/findings, ...): each must be a plain directory when it exists. */
  #roads(kind: Kind): string[] {
    if (kind === 'meta') return [];
    if (kind === 'schedule') return ['schedules'];
    const run = RUN_NAMES[kind];
    if (run) return ['runs', path.join('runs', run)];
    const dirs = kind in PRIMARY ? [(PRIMARY[kind] as (typeof PRIMARY)[string]).dir] : (DIRS[kind] as readonly string[]);
    return ['nodes', ...dirs.map((d) => path.join('nodes', d))];
  }
  probe(kind: Kind, maxBytes: number): 'absent' | 'ok' | 'unsafe' {
    for (const r of this.#roads(kind)) { try { if (!fs.lstatSync(path.join(this.#dir, r)).isDirectory()) return 'unsafe'; } catch { /* absent: nothing there */ } } // a symlink, FIFO or file where a directory belongs
    const files = this.#files(kind);
    if (!files.length) return 'absent';
    for (const f of files) { let st: fs.Stats; try { st = fs.lstatSync(f); } catch { return 'unsafe'; } if (!st.isFile() || st.size > maxBytes) return 'unsafe'; }
    return 'ok';
  }
  describe(): { backend: 'entity'; root: string } { return { backend: 'entity', root: this.ctx.dir }; }
}
