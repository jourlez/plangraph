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
//   meta               meta.jsonl, unchanged (the JsonlStore reads and writes it)
// Every column is kept. A node that exists only to hold a part of another kind (a ref without a ticket row, a link whose source has no row) carries
// `primary false`; a node that holds a ref row lists its stored names in `refcols` (a column whose name a ticket field already uses is stored as
// `ref_<column>` and named in `refmap`). readKind returns what the JsonlStore returns for the same rows: canonical order, schema defaults.
import fs from 'node:fs';
import path from 'node:path';
import { canonFile, SCHEMAS, withDefaults, parseJsonlText } from '../store.ts';
import type { Schema } from '../store.ts';
import { kindFile, JsonlStore, precheckTargets } from '../planstore.ts';
import type { Kind, PlanStore, Row, WriteOpts, WriteResult, ReadTextOpts, StoreCtx } from '../planstore.ts';
import { IngestError, parseJsonl } from '../jsonl.ts';
import { validators } from '../schema.ts';
import { assertInside } from '../fsafe.ts';
import { listNodeFiles, loadRaw } from './nodes.ts';
import { nodePath } from './layout.ts';
import { formatPg, MAX_LINE } from './pg.ts';
import { withTxn } from './txn.ts';
import { writeRun, runFiles, readRuns, writeSchedule, readSchedule, setCurrent, currentVersion, scheduleVersions } from './batches.ts';

type Fields = Record<string, unknown>;
interface Parts { primary: Fields | null; ref: Fields | null; needs: Fields[]; links: Fields[]; xrefs: Fields[]; capacity: Fields[] }
interface Entry { dir: string; id: string; parts: Parts; text: string | null }

const NODE_DIRS = ['ticket', 'person', 'sprint', 'epic', 'repo', 'ext', 'openitem'] as const;
const LINK_SOURCES: ReadonlySet<string> = new Set(['ticket', 'person', 'sprint', 'epic', 'repo']);
const RUN_NAMES: Readonly<Partial<Record<Kind, string>>> = { evidence: 'evidence', finding: 'findings', learning: 'learnings' };
// the node directories each kind reads and writes
const DIRS: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  ticket: ['ticket'], edge: ['ticket'], ref: ['ticket', 'epic'], epic: ['epic'], person: ['person'], capacity: ['person'], sprint: ['sprint'], repo: ['repo'],
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
  constructor(root: string, dirs: readonly string[]) {
    this.root = root;
    for (const dir of dirs) {
      for (const abs of listNodeFiles(root, dir)) {
        const r = loadRaw(root, abs);
        if ('problem' in r || abs !== nodePath(root, dir, r.node.id)) continue; // a damaged or misplaced file is `check`'s business: skipped here
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
  inDir(dirs: readonly string[]): Entry[] { return [...this.entries.values()].filter((e) => dirs.includes(e.dir)); }
}

const canonRows = (kind: Kind, rows: readonly Row[]): Row[] => parseJsonlText(canonFile(rows, SCHEMAS[kindFile(kind)] as Schema), kindFile(kind));

export class EntityStore implements PlanStore {
  readonly ctx: StoreCtx;
  readonly #j: JsonlStore;
  constructor(ctx: StoreCtx) { this.ctx = ctx; this.#j = new JsonlStore(ctx); }
  get #dir(): string { return this.ctx.dir; }

  // ---------- reading ----------
  #raw(kind: Kind): Row[] {
    if (kind === 'schedule') { const v = currentVersion(this.#dir); return v === null ? [] : (() => { try { return readSchedule(this.#dir, v); } catch { return []; } })(); }
    const run = RUN_NAMES[kind];
    if (run) return readRuns(this.#dir, run);
    const m = new Model(this.#dir, DIRS[kind] as readonly string[]);
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
      for (const e of m.entries.values()) { const s = sourceOf(e); for (const l of e.parts.links) out.push({ from: s.id, from_type: s.type, ...without(l, ['k']) }); }
    } else if (kind === 'xref') {
      for (const e of m.entries.values()) { const s = sourceOf(e); for (const x of e.parts.xrefs) out.push({ type: s.type, id: s.id, ...x }); }
    }
    return out;
  }

  readKind(kind: Kind, { defaults = true }: { defaults?: boolean } = {}): Row[] {
    if (kind === 'meta') return this.#j.readKind(kind, { defaults });
    const rows = canonRows(kind, this.#raw(kind));
    return defaults ? rows.map((r) => withDefaults(SCHEMAS[kindFile(kind)] as Schema, r)) : rows;
  }

  readValidated(kind: Kind, { validate }: { maxBytes?: number; maxLine?: number; validate?: ((r: Row) => string | null) | undefined } = {}): Row[] {
    if (kind === 'meta') return this.#j.readValidated(kind, validate ? { validate } : {});
    const file = kindFile(kind), check = validate ?? validators[file];
    return parseJsonl(this.#asText(kind), file, { validate: check });
  }

  #asText(kind: Kind): string { return canonFile(this.readKind(kind, { defaults: false }), SCHEMAS[kindFile(kind)] as Schema); }

  readText(kind: Kind, opts: ReadTextOpts = {}): string | null {
    if (kind === 'meta') return this.#j.readText(kind, opts);
    return this.exists(kind) ? this.#asText(kind) : null;
  }

  readSource(kind: Kind, maxBytes: number): string | null {
    if (kind === 'meta') return this.#j.readSource(kind, maxBytes);
    if (!this.exists(kind)) return null;
    const t = this.#asText(kind);
    if (Buffer.byteLength(t) > maxBytes) throw new IngestError(`${kindFile(kind)}: file too large (limit ${maxBytes} bytes)`);
    return t;
  }

  // ---------- writing ----------
  #mutate(kind: Kind, fn: (m: Model) => void): number {
    const m = new Model(this.#dir, DIRS[kind] as readonly string[]);
    fn(m);
    const changes: Array<{ rel: string; text: string | null }> = [];
    for (const e of m.entries.values()) {
      const t = encode(e);
      if (t !== e.text) changes.push({ rel: path.relative(this.#dir, nodePath(this.#dir, e.dir, e.id)), text: t });
    }
    if (changes.length) withTxn(this.#dir, (tx) => { for (const c of changes) { if (c.text === null) tx.remove(c.rel); else tx.write(c.rel, c.text); } });
    return changes.length;
  }

  #replace(kind: Kind, rows: readonly Row[]): void {
    const dirs = DIRS[kind] as readonly string[];
    this.#mutate(kind, (m) => {
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
          const t = linkDirOf(text1(r.from_type, 'a link from_type'), text1(r.from, 'a link from')), line = without(r, ['from', 'from_type']);
          m.at(t.dir, t.id).parts.links.push(r.rel === 'needs' ? { ...line, k: 'link' } : line); // a stored `needs` line is an edge; a link row with that relation is marked
        }
      } else if (kind === 'xref') {
        clear((p) => { p.xrefs = []; });
        for (const r of rows) { const t = linkDirOf(text1(r.type, 'an xref type'), text1(r.id, 'an xref id')); m.at(t.dir, t.id).parts.xrefs.push(without(r, ['type', 'id'])); }
      }
    });
  }

  #replaceRuns(name: string, rows: readonly Row[]): void {
    const before = runFiles(this.#dir, name).map((f) => f.rel);
    const keep = rows.length ? writeRun(this.#dir, name, rows) : '';
    const stale = before.filter((r) => r !== keep);
    if (stale.length) withTxn(this.#dir, (tx) => { for (const r of stale) tx.remove(r); });
  }

  writeKind(kind: Kind, rows: readonly Row[], opts: WriteOpts = {}): WriteResult {
    if (kind === 'meta') {
      const f = kindFile(kind), t = canonFile(rows, SCHEMAS[f] as Schema);
      if (this.#j.exists(kind) && this.#j.readText(kind, { bare: true }) === t) return { kind, file: f, bytes: Buffer.byteLength(t) }; // same bytes: the file is left alone
      return this.#j.writeKind(kind, rows, opts);
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
    if (kind === 'meta') return this.#j.writeText(kind, text, opts);
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
    if (kind === 'meta') return this.#j.exists(kind) ? [path.join(this.#dir, kindFile(kind))] : [];
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
      assertInside(this.ctx.root, path.join(this.#dir, top)); // a directory that leaves the repository is refused with the same error as a file
    }
    precheckTargets(this.ctx, [...targets.filter((t) => { try { return !fs.lstatSync(t).isDirectory(); } catch { return true; } }), ...extra]);
  }

  exists(kind: Kind): boolean { return this.#files(kind).length > 0; }
  mtimeMs(kind: Kind): number | null {
    let max: number | null = null;
    for (const f of this.#files(kind)) { try { const m = fs.statSync(f).mtimeMs; if (max === null || m > max) max = m; } catch { /* gone */ } }
    return max;
  }
  probe(kind: Kind, maxBytes: number): 'absent' | 'ok' | 'unsafe' {
    const files = this.#files(kind);
    if (!files.length) return 'absent';
    for (const f of files) { let st: fs.Stats; try { st = fs.lstatSync(f); } catch { return 'unsafe'; } if (!st.isFile() || st.size > maxBytes) return 'unsafe'; }
    return 'ok';
  }
  describe(): { backend: 'jsonl' | 'entity'; root: string } { return { backend: 'entity', root: this.ctx.dir }; }
}
