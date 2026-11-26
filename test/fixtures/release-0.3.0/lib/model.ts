// In-memory plan model, loaded from the JSONL text (the source of truth). Pure data, no SQLite, so library modules and tests
// can work on plain objects. A model is: { tickets: Map<key,row>, edges: [{consumer,producer,kind,note}], prods: Map<consumer,[producer]>,
// cons: Map<producer,[consumer]>, sched: Map<key,{owner,sprint}>, config, findings, evidence, learnings, refs }.
import path from 'node:path';
import type fs from 'node:fs';
import { readJsonl, readDataCapped, IngestError } from './jsonl.ts';

/** What the config reader's catch reads from a thrown value (whatever was thrown is read the same way as before). */
type Coded = Error & { code?: string };

// ---------------------------------------------------------------- record types
// Field names are the known columns of each file (lib/store SCHEMAS order, docs/FORMAT.md section 1). A record has passed the file's
// validator (lib/schema): required fields are strings and typed optional fields have their type, but any known field may still hold an
// explicit null (the validators treat null as absent, and defaults are applied only to absent fields), so optional fields admit null.
// Unknown fields are kept and never interpreted (FORMAT.md, unknown-field rule): the index signature carries them.

/** impl_status values (lib/schema IMPL_STATUSES). */
export type ImplStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
/** One line of tickets.jsonl. */
export interface Ticket {
  key: string;
  summary?: string | null; epic?: string | null; sp?: number | null; jira_status?: string | null; v2_owner?: string | null; v2_sprint?: number | null;
  verdict?: string | null; verdict_source?: string | null; first_verdict?: string | null; impl_status?: ImplStatus | null;
  [extra: string]: unknown;
}
/** One line of edges.jsonl: the consumer needs the producer. `kind` defaults to plan_need on read. */
export interface Edge { consumer: string; producer: string; kind?: string | null; note?: string | null; [extra: string]: unknown }
/** One line of schedule.jsonl. `version` defaults to current on read; only current rows reach Model.sched. */
export interface ScheduleRow { version?: string | null; key: string; owner?: string | null; sprint?: number | null; [extra: string]: unknown }
/** A current placement in Model.sched: a schedule row's owner and sprint (either may be null in a validated row). */
export interface Placement { owner: ScheduleRow['owner']; sprint: ScheduleRow['sprint'] }
/** config.json as readConfig returns it: a JSON object, otherwise unchecked (the file is hand-edited). The named keys are the ones the
 * libraries read, typed as docs/CONTRACT.md describes them; each reader still tests the value it uses (ownNumber, Array.isArray, ...). */
export interface PlanConfig {
  caps?: Record<string, unknown>; min_per_sprint?: Record<string, unknown>; first_sprint?: number; end_sprint?: number; frozen_before_sprint?: number;
  closed_statuses?: string[]; frozen_statuses?: string[]; ignore_link_kinds?: string[]; minimize_load_of?: string[];
  [key: string]: unknown;
}
/** A record of findings, evidence, learnings or refs (typed with their libraries). */
export type PlanRecord = Record<string, unknown>;
/** The loaded plan. prods: consumer -> sorted producers; cons: producer -> sorted consumers (edges of an ignored kind left out of both). */
export interface Model {
  tickets: Map<string, Ticket>;
  edges: Edge[];
  prods: Map<string, string[]>;
  cons: Map<string, string[]>;
  sched: Map<string, Placement>;
  config: PlanConfig;
  findings: PlanRecord[];
  evidence: PlanRecord[];
  learnings: PlanRecord[];
  refs: PlanRecord[];
}
/** buildModel's input: validated rows (loadModel) or literal test fixtures. A fixture that is deliberately ill-typed (a string `sp` or
 * `sprint`, to pin how the libraries treat bad data) says so with `as unknown as Ticket[] // deliberate misuse`. */
export interface ModelRecords {
  tickets?: readonly Ticket[]; edges?: readonly Edge[]; schedule?: readonly ScheduleRow[]; config?: PlanConfig;
  findings?: readonly object[]; evidence?: readonly object[]; learnings?: readonly object[]; refs?: readonly object[];
}

// A per-person number from a config map (caps, min_per_sprint): an OWN property holding a finite number, else the map's `default`
// (same rule), else `fallback`. A person named `constructor`, `toString` or `__proto__` never reads a prototype member.
export const ownNumber = (map: unknown, person: string, fallback: number): number => {
  const m = (map !== null && typeof map === 'object' ? map : {}) as Record<string, unknown>; // an object's own keys are read below, each tested
  const get = (k: string) => (Object.hasOwn(m, k) && typeof m[k] === 'number' && Number.isFinite(m[k]) ? m[k] as number : undefined); // typeof just tested it
  return get(person) ?? get('default') ?? fallback;
};
export const capOf = (cfg: { caps?: unknown } | null | undefined, person: string): number => ownNumber((cfg || {}).caps, person, 140);

// Build a model from already-parsed records (used by tests and by loadModel).
export function buildModel({ tickets = [], edges = [], schedule = [], config = {}, findings = [], evidence = [], learnings = [], refs = [] }: ModelRecords = {}): Model {
  const skip = new Set<unknown>(config.ignore_link_kinds || []);
  const prods = new Map<string, string[]>(), cons = new Map<string, string[]>();
  for (const e of edges) {
    if (skip.has(e.kind)) continue;
    if (!prods.has(e.consumer)) prods.set(e.consumer, []);
    if (!cons.has(e.producer)) cons.set(e.producer, []);
    (prods.get(e.consumer) as string[]).push(e.producer); (cons.get(e.producer) as string[]).push(e.consumer); // both set just above
  }
  for (const m of [prods, cons]) for (const a of m.values()) a.sort();
  const sched = new Map(schedule.filter((r) => (r.version ?? 'current') === 'current').map((r) => [r.key, { owner: r.owner, sprint: r.sprint }]));
  return { tickets: new Map(tickets.map((t) => [t.key, t])), edges: edges as Edge[], prods, cons, sched, config, findings: findings as PlanRecord[], evidence: evidence as PlanRecord[], learnings: learnings as PlanRecord[], refs: refs as PlanRecord[] }; // the lists are returned as given: edges is readonly in the input only so that a frozen fixture fits (the model holds the same array, as before); the record lists are validated rows
}

// config.json: THE one reader (loadModel, src/context.ts ctx.config() and every command go through it). Small and repo-controlled: one
// capped read through the same data-file reader as every plangraph file (lib/jsonl.ts readDataCapped: lstat refuses a symlink, one fd opened
// with O_NOFOLLOW, its fstat dev/ino compared with the lstat, a FIFO, device or directory refused, at most CONFIG_MAX bytes), then a JSON object.
// Missing -> {}. Failures are an IngestError (exit 2 in the CLI) with a `code` and a fixed message naming the base file only (never a path
// or the content). A symlink swapped in between the lstat and the open fails the open (SYMLINK); any other file swapped in is refused
// (SWAPPED). Residual: an INTERMEDIATE directory swapped in that window is not detected (no openat; docs/CONTRACT.md).
export const CONFIG_MAX = 64 * 1024;
/** fsImpl: for tests that force a swap at an exact point (default node:fs) */
export function readConfig(f: string, { fsImpl }: { fsImpl?: typeof fs } = {}): PlanConfig {
  const name = path.basename(f), fail = (what: string, code: string) => Object.assign(new IngestError(`${name}: ${what}`), { code });
  let text: string;
  try { text = readDataCapped(f, CONFIG_MAX, fsImpl ? { fsImpl } : {}); } catch (e) { // its lstat refuses a symlink, its O_NOFOLLOW open one swapped in
    if ((e as Coded).code === 'SYMLINK') throw fail('is a symlink', 'SYMLINK'); // whatever was thrown: read its code (unchecked: a thrown null would throw here, pre-existing)
    if ((e as Coded).code === 'TOO_LARGE' || (e as Coded).code === 'NOT_A_FILE' || (e as Coded).code === 'SWAPPED') throw fail((e as Coded).message, (e as Coded).code as string); // whatever was thrown: read its code and message (the code was compared on this line)
    if ((e as Coded).code === 'ENOENT' || (e as Coded).code === 'ENOTDIR') return {}; // whatever was thrown: read its code
    throw e;
  }
  let v: unknown;
  try { v = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw fail('not valid JSON', 'BAD_JSON'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw fail('must be a JSON object', 'NOT_OBJECT');
  return v as PlanConfig; // tested on the line above: a non-null, non-array object
}
/** config: an already-read config (the CLI passes ctx.config()). */
export function loadModel(dir: string, { config }: { config?: PlanConfig } = {}): Model {
  const j = (n: string) => readJsonl(path.join(dir, n));
  return buildModel({ tickets: j('tickets.jsonl') as Ticket[], edges: j('edges.jsonl') as Edge[], schedule: j('schedule.jsonl') as ScheduleRow[], config: config ?? readConfig(path.join(dir, 'config.json')), findings: j('findings.jsonl'), evidence: j('evidence.jsonl'), learnings: j('learnings.jsonl'), refs: j('refs.jsonl') }); // readJsonl validates each known file with its lib/schema validator (required fields are strings)
}
