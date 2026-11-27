// The one door to plan data: every read and write of a plan kind (tickets, edges, schedule, ... xrefs) goes through a PlanStore, and the only
// backend is EntityStore (lib/store2/entitystore.ts, docs/FORMAT.md). A row is a plain JSON object; the old one-file-per-kind names survive as
// the names of the kinds' canonical text (kindFile) in messages, the index and the solver input.
import fs from 'node:fs';
import path from 'node:path';
import type { Rec } from './store.ts';
import { assertInside, writeAtomicSafe } from './fsafe.ts';
import { oneLine } from './sanitize.ts';
import { PlangraphError } from '../src/errors.ts';
import { EntityStore } from './store2/entitystore.ts';

/** One plan record. */
export type Row = Rec;
/** The v1 kinds, then the graph kinds: every plan data file there is (the card digest and the index fingerprint depend on this order). */
export const SRC_KINDS = Object.freeze(['ticket', 'edge', 'schedule', 'evidence', 'finding', 'meta', 'learning', 'ref', 'openitem'] as const);
export const GRAPH_KINDS = Object.freeze(['person', 'sprint', 'epic', 'repo', 'capacity', 'link', 'xref'] as const);
/** The node kinds of task 12 (docs/FORMAT.md section 4): stored by EntityStore under nodes/<kind>/; not in GRAPH_KINDS, so the card digest and the seven graph files stay as they were. */
export const NODE_KINDS = Object.freeze(['requirement', 'decision', 'team'] as const);
export const KINDS = Object.freeze([...SRC_KINDS, ...GRAPH_KINDS, ...NODE_KINDS] as const);
export type Kind = (typeof KINDS)[number];

const FILES: Readonly<Record<Kind, string>> = Object.freeze({
  ticket: 'tickets.jsonl', edge: 'edges.jsonl', schedule: 'schedule.jsonl', evidence: 'evidence.jsonl', finding: 'findings.jsonl', meta: 'meta.jsonl',
  learning: 'learnings.jsonl', ref: 'refs.jsonl', openitem: 'open-items.jsonl', person: 'people.jsonl', sprint: 'sprints.jsonl', epic: 'epics.jsonl',
  repo: 'repos.jsonl', capacity: 'capacity.jsonl', link: 'links.jsonl', xref: 'xrefs.jsonl',
  requirement: 'requirements.jsonl', decision: 'decisions.jsonl', team: 'teams.jsonl',
});
const BY_FILE: ReadonlyMap<string, Kind> = new Map(KINDS.map((k) => [FILES[k], k]));
/** The name of a kind's canonical text file (messages, the index sources and the solver input call a kind by it). */
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
  /** Several kinds in one call, sharing one parse of the node files they live in (the rows come back in the order of `kinds`). */
  readKinds(kinds: readonly Kind[], opts?: { defaults?: boolean }): Row[][];
  /** Rows of a kind checked by the kind's validator (or `validate`), as readJsonl: a bad row is a data error naming file and line. */
  readValidated(kind: Kind, opts?: { maxBytes?: number; maxLine?: number; validate?: ((r: Rec) => string | null) | undefined }): Row[];
  /** The text of a kind's file, capped; null when absent, a symlink refused. Refusals name the file unless bare (the reader's own message). JSONL only. */
  readText(kind: Kind, opts?: ReadTextOpts): string | null;
  /** The text of a kind's file for the index build and its fingerprint (null when absent). JSONL only. */
  readSource(kind: Kind, maxBytes: number): string | null;
  writeKind(kind: Kind, rows: readonly Row[], opts?: WriteOpts): WriteResult;
  /** Adds or replaces the given rows of a node kind by identity and leaves every other row alone: one read-modify-write under the store lock, so two writers never lose each other's rows. Returns the number of files changed. */
  addRows(kind: Kind, rows: readonly Row[], opts?: WriteOpts): number;
  /** Removes the rows named by `keys` (rows holding the identity columns) of a node kind, under the store lock. Returns the number of files changed. */
  removeRows(kind: Kind, keys: readonly Row[], opts?: WriteOpts): number;
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
  describe(): { backend: 'entity'; root: string };
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

/** The store of a plan directory: always the entity backend (docs/FORMAT.md). root: the repository the writes are confined to. */
export const openStore = (ctx: StoreCtx): PlanStore => new EntityStore(ctx);
/** A store for reading a plan directory when no repository root is at hand (a reader never writes). */
export const readStoreAt = (dir: string): PlanStore => openStore({ dir, root: dir });
