// The one door to plan data: every read and write of a plan file (tickets, edges, schedule, ... xrefs) goes through a PlanStore.
// JsonlStore is today's behavior byte for byte (canonical files in the plan directory, atomic writes, same refusals and messages); the entity
// backend (docs/superpowers/specs, section 4.0) will implement the same interface. A row is a plain JSON object. JsonlStore returns rows in
// file order (a canonical file is sorted by the kind's key; a hand-edited one is read as it is, as before).
import fs from 'node:fs';
import path from 'node:path';
import { canonFile, readRecords, SCHEMAS } from './store.ts';
import type { Rec } from './store.ts';
import { readJsonl, readDataCapped, presentDataFile, parseJsonl, IngestError, DATA_REFUSALS } from './jsonl.ts';
import { validators } from './schema.ts';
import { assertInside, writeAtomicSafe } from './fsafe.ts';
import { oneLine } from './sanitize.ts';
import { PlangraphError } from '../src/errors.ts';

/** One plan record. */
export type Row = Rec;
/** The v1 kinds, then the graph kinds: every plan data file there is (the card digest and the index fingerprint depend on this order). */
export const SRC_KINDS = Object.freeze(['ticket', 'edge', 'schedule', 'evidence', 'finding', 'meta', 'learning', 'ref', 'openitem'] as const);
export const GRAPH_KINDS = Object.freeze(['person', 'sprint', 'epic', 'repo', 'capacity', 'link', 'xref'] as const);
export const KINDS = Object.freeze([...SRC_KINDS, ...GRAPH_KINDS] as const);
export type Kind = (typeof KINDS)[number];

const FILES: Readonly<Record<Kind, string>> = Object.freeze({
  ticket: 'tickets.jsonl', edge: 'edges.jsonl', schedule: 'schedule.jsonl', evidence: 'evidence.jsonl', finding: 'findings.jsonl', meta: 'meta.jsonl',
  learning: 'learnings.jsonl', ref: 'refs.jsonl', openitem: 'open-items.jsonl', person: 'people.jsonl', sprint: 'sprints.jsonl', epic: 'epics.jsonl',
  repo: 'repos.jsonl', capacity: 'capacity.jsonl', link: 'links.jsonl', xref: 'xrefs.jsonl',
});
const BY_FILE: ReadonlyMap<string, Kind> = new Map(KINDS.map((k) => [FILES[k], k]));
/** The JSONL file name of a kind (what the JsonlStore keeps it in, and what messages call it). */
export const kindFile = (k: Kind): string => FILES[k];
/** The kind kept in a file of that name, or undefined (config.json, cache files, ...). */
export const kindOfFile = (file: string): Kind | undefined => BY_FILE.get(file);

export interface WriteResult { kind: Kind; file: string; bytes: number }
export interface WriteOpts { precheck?: boolean }
export interface StoreCtx { dir: string; root: string }
export interface ReadTextOpts { maxBytes?: number; bare?: boolean }

export interface PlanStore {
  /** Rows of a kind (no row for a missing file). defaults: fill the schema defaults (default true). Unvalidated, as readRecords. */
  readKind(kind: Kind, opts?: { defaults?: boolean }): Row[];
  /** Rows of a kind checked by the kind's validator (or `validate`), as readJsonl: a bad row is a data error naming file and line. */
  readValidated(kind: Kind, opts?: { maxBytes?: number; maxLine?: number; validate?: ((r: Rec) => string | null) | undefined }): Row[];
  /** The text of a kind's file, capped; null when absent, a symlink refused. Refusals name the file unless bare (the reader's own message). JSONL only. */
  readText(kind: Kind, opts?: ReadTextOpts): string | null;
  /** The text of a kind's file for the index build and its fingerprint (null when absent). JSONL only. */
  readSource(kind: Kind, maxBytes: number): string | null;
  writeKind(kind: Kind, rows: readonly Row[], opts?: WriteOpts): WriteResult;
  /** Writes text as given: for a kind that has its own serializer (open-items) and for seed text. JSONL only. */
  writeText(kind: Kind, text: string, opts?: WriteOpts): WriteResult;
  /** Validates (optionally) and writes only the kinds whose canonical rows differ from `old`, after one precheck of every target; returns how many were written. */
  writeChanged(entries: ReadonlyArray<{ kind: Kind; rows: readonly Row[]; old: readonly Row[] }>, opts?: { validate?: boolean }): number;
  /** Refuses (REFUSED, nothing written) a target that is a symlink, not a regular file, or outside the repository; extra: further absolute paths checked after the kinds. */
  precheck(kinds: readonly Kind[], extra?: readonly string[]): void;
  exists(kind: Kind): boolean;
  /** Modification time of a kind's file; null when absent. JSONL only. */
  mtimeMs(kind: Kind): number | null;
  /** 'absent', 'ok' (a readable regular file of at most maxBytes) or 'unsafe', by lstat only (nothing is opened or read). JSONL only. */
  probe(kind: Kind, maxBytes: number): 'absent' | 'ok' | 'unsafe';
  describe(): { backend: 'jsonl' | 'entity'; root: string };
}

// ---------- confined state writes (moved here from src/commands/shared.ts, which re-exports them) ----------
/** A refused write target (symlink, outside the repository) is a REFUSED error (exit 4); anything else is rethrown. */
export function refuseWrite(e: unknown): never {
  if ((e as NodeJS.ErrnoException | undefined)?.code === 'SYMLINK' || (e as NodeJS.ErrnoException | undefined)?.code === 'OUTSIDE_REPO') throw new PlangraphError('REFUSED', `refusing to write: ${oneLine((e as Error).message, 200)} (nothing was written)`, { cause: e }); // lib/fsafe.ts throws coded Errors
  throw e;
}
/** Check every target before the first write, so a refusable one (symlink, directory, outside the repository) fails with nothing written. */
export function precheckTargets(ctx: { root: string }, files: string[]): void {
  for (const f of files) {
    let st = null;
    try { st = fs.lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // fs throws errno errors
    if (st && !st.isFile()) throw new PlangraphError('REFUSED', `refusing to write ${oneLine(path.basename(f), 80)}: ${st.isSymbolicLink() ? 'it is a symlink' : 'not a regular file'} (nothing was written)`);
    try { assertInside(ctx.root, f); } catch (e) { refuseWrite(e); }
  }
}
/** Atomic write (temp file, fsync, rename) confined to the repository; symlink targets refused. */
export function writeState(ctx: { root: string }, file: string, text: string): void {
  try { writeAtomicSafe(file, text, { root: ctx.root }); } catch (e) { refuseWrite(e); }
}

const MAX = 64 * 1024 * 1024;
type Coded = Error & { code?: string };

export class JsonlStore implements PlanStore {
  readonly ctx: StoreCtx;
  constructor(ctx: StoreCtx) { this.ctx = ctx; }
  #path(kind: Kind): string { return path.join(this.ctx.dir, FILES[kind]); }

  readKind(kind: Kind, { defaults = true }: { defaults?: boolean } = {}): Row[] { return readRecords(this.ctx.dir, FILES[kind], { defaults }); }

  readValidated(kind: Kind, { maxBytes, maxLine, validate }: { maxBytes?: number; maxLine?: number; validate?: ((r: Rec) => string | null) | undefined } = {}): Row[] {
    return readJsonl(this.#path(kind), { ...(maxBytes === undefined ? {} : { maxBytes }), ...(maxLine === undefined ? {} : { maxLine }), validate });
  }

  readText(kind: Kind, { maxBytes = MAX, bare = false }: ReadTextOpts = {}): string | null {
    const f = this.#path(kind);
    if (!presentDataFile(f)) return null; // a symlink is refused, as in build
    try { return readDataCapped(f, maxBytes); }
    catch (e) { if (!bare && DATA_REFUSALS.has((e as Coded).code as string)) throw new IngestError(`${FILES[kind]}: ${(e as Coded).message}`); throw e; } // whatever was thrown: a code it lacks is not a refusal
  }

  readSource(kind: Kind, maxBytes: number): string | null {
    const name = FILES[kind], f = this.#path(kind);
    // A source file is a regular file inside the plan directory: a symlink (even to a file outside the repo) is refused before any read.
    let st = null; try { st = fs.lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } // fs throws errno errors
    if (st?.isSymbolicLink()) throw new IngestError(`${name}: is a symlink, not a regular file`);
    try { return readDataCapped(f, maxBytes); } // O_NOFOLLOW + dev/ino check: no swap after the lstat
    catch (e) { // fs errno errors and readDataCapped's coded refusals
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // fs and the readers throw errno-style errors with a code
      if (DATA_REFUSALS.has((e as { code: string }).code)) throw new IngestError(`${name}: ${(e as Error).message}`); // a missing code is simply not in the set
      throw e;
    }
  }

  #text(kind: Kind, rows: readonly Row[]): string { return canonFile(rows, SCHEMAS[FILES[kind]]); }
  #put(kind: Kind, text: string): WriteResult { writeState(this.ctx, this.#path(kind), text); return { kind, file: FILES[kind], bytes: Buffer.byteLength(text) }; }

  writeKind(kind: Kind, rows: readonly Row[], { precheck = false }: WriteOpts = {}): WriteResult { return this.writeText(kind, this.#text(kind, rows), { precheck }); }

  writeText(kind: Kind, text: string, { precheck = false }: WriteOpts = {}): WriteResult {
    if (precheck) this.precheck([kind]);
    return this.#put(kind, text);
  }

  writeChanged(entries: ReadonlyArray<{ kind: Kind; rows: readonly Row[]; old: readonly Row[] }>, { validate = false }: { validate?: boolean } = {}): number {
    const out: Array<[Kind, string]> = [];
    for (const { kind, rows, old } of entries) {
      const text = this.#text(kind, rows);
      if (validate) parseJsonl(text, FILES[kind], { validate: validators[FILES[kind]] } as { validate?: (r: Rec) => string | null }); // learnings.jsonl has no validator: parseJsonl destructures validate, so undefined acts as absent
      if (text !== this.#text(kind, old)) out.push([kind, text]);
    }
    // Pre-check every target before the first write, so a refusable target (symlink, directory, outside the repo) fails with nothing written.
    this.precheck(out.map(([k]) => k));
    for (const [k, text] of out) this.#put(k, text);
    return out.length;
  }

  precheck(kinds: readonly Kind[], extra: readonly string[] = []): void { precheckTargets(this.ctx, [...kinds.map((k) => this.#path(k)), ...extra]); }
  exists(kind: Kind): boolean { return fs.existsSync(this.#path(kind)); }
  mtimeMs(kind: Kind): number | null {
    try { return fs.statSync(this.#path(kind)).mtimeMs; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } // fs throws errno errors
  }
  probe(kind: Kind, maxBytes: number): 'absent' | 'ok' | 'unsafe' {
    const p = this.#path(kind); let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw e; } // fs errno errors
    if (!st.isFile() || st.size > maxBytes) return 'unsafe';
    try { fs.accessSync(p, fs.constants.R_OK); } catch { return 'unsafe'; }
    return 'ok';
  }
  describe(): { backend: 'jsonl' | 'entity'; root: string } { return { backend: 'jsonl', root: this.ctx.dir }; }
}

/** The store of a plan directory. root: the repository the writes are confined to. */
export const openStore = (ctx: StoreCtx): PlanStore => new JsonlStore(ctx);
/** A store for reading a plan directory when no repository root is at hand (a reader never writes). */
export const readStoreAt = (dir: string): PlanStore => new JsonlStore({ dir, root: dir });
