// Shared by the flow commands: the model and extras loaded once, the actor id, and the dry replay of one event before it is appended.
// The replay puts the candidate event after every stored one and reads the findings lib/flow/state.ts raises for it, so a writer refuses
// exactly what deriveState would reject (BAD_TRANSITION, DOUBLE_CLAIM) and never a rule of its own.
import crypto from 'node:crypto';
import { oneLine } from '../../lib/sanitize.ts';
import { loadExtras } from '../../lib/extras.ts';
import type { Extras } from '../../lib/extras.ts';
import { appendEvent, nextPosition } from '../../lib/store2/batches.ts';
import { deriveState } from '../../lib/flow/state.ts';
import type { FlowFinding } from '../../lib/flow/state.ts';
import { depsFromModel } from '../../lib/flow/deps.ts';
import { PlangraphError } from '../errors.ts';
import { modelFromDb, needBrain, usage } from './shared.ts';
import type { Model } from '../../lib/model.ts';
import type { Ctx } from '../context.ts';

export interface Loaded { model: Model; extras: Extras }
export function loadFlow(ctx: Ctx): Loaded {
  needBrain(ctx);
  const model = modelFromDb(ctx);
  return { model, extras: loadExtras(ctx, { model }) };
}

/** `--by`, else the git user name hashed to `u` + 8 hex. Never an email, never the name itself. */
function actorOf(ctx: Ctx, by: unknown): string {
  if (typeof by === 'string' && by.trim()) {
    const a = by.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(a)) throw usage('--by must be 1 to 40 characters of a-z 0-9 _ - (a person id, not a name or an email)');
    return a;
  }
  let name = '';
  try { name = String(ctx.git('config', 'user.name')).trim(); } catch { /* no git or no name */ }
  return `u${crypto.createHash('sha256').update(name || 'unknown').digest('hex').slice(0, 8)}`;
}

const EVIDENCE = /^[a-z][a-z0-9_-]{0,19}:\S[^\n]{0,198}$/;
export function evidenceOf(v: unknown): string[] {
  const list = (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);
  for (const e of list) if (!EVIDENCE.test(e)) throw usage(`--evidence must be KIND:VALUE such as pr:org/repo#12 or test:suite, got ${oneLine(e, 60)}`);
  return list;
}

export function needTask(model: Model, key: string): void {
  if (!model.tickets.has(key)) throw new PlangraphError('DATA', `unknown task ${oneLine(key, 80)}`, { hint: 'plangraph flow next lists the tasks' });
}

/** Throws exit 2 when the event would be an illegal transition or a double claim; returns the state before it. The probe sits where appendEvent would put the event (`now` is the clock it will use). */
function checkEvent(model: Model, extras: Extras, key: string, e: { to: string; by: string; evidence: string[]; force?: boolean }, now: Date): string {
  const deps = depsFromModel(model);
  const before = deriveState(key, extras.events, deps).state;
  const pos = nextPosition(extras.events, now), where = `${pos.at}#${pos.seq}`;
  const probe = { at: pos.at, seq: pos.seq, actor: 'zzz', task: key, to: e.to, by: e.by, evidence: e.evidence, ...(e.force ? { force: true } : {}) };
  const mine = (f: FlowFinding): boolean => f.key === key && new RegExp(` at ${where}(?!\\d)`).test(f.detail); // `where` holds only digits and - : T Z #
  const bad = deriveState(key, [...extras.events, probe], deps).findings.find((f) => mine(f) && (f.code === 'BAD_TRANSITION' || f.code === 'DOUBLE_CLAIM'));
  if (bad) {
    const held = /\(held by ([a-z0-9_-]{1,40});/.exec(bad.detail);
    const detail = bad.code === 'DOUBLE_CLAIM' ? oneLine(bad.detail.replace(where, 'now'), 160) : `${before} -> ${oneLine(e.to, 20)} is not allowed${held ? ` (held by ${oneLine(held[1] as string, 40)}; pass --force to take it over)` : ''}`;
    throw new PlangraphError('DATA', `${bad.code} ${oneLine(key, 80)}: ${detail}`);
  }
  return before;
}

export function writeEvent(ctx: Ctx, args: { key: string; to: string; by: unknown; evidence?: string[]; note?: unknown; force?: unknown }): number {
  const { model, extras } = loadFlow(ctx);
  needTask(model, args.key);
  const actor = actorOf(ctx, args.by), evidence = args.evidence ?? [], force = args.force === true;
  const now = ctx.now();
  let before = checkEvent(model, extras, args.key, { to: args.to, by: actor, evidence, force }, now);
  const note = typeof args.note === 'string' && args.note ? oneLine(args.note, 200) : undefined;
  // the same rule again under the store lock, over the events on disk at that moment: two agents claiming one task cannot both pass it
  const guard = (seen: readonly { evidence?: unknown }[]): void => { before = checkEvent(model, { ...extras, events: seen.map((e) => ({ ...e, evidence: Array.isArray(e.evidence) ? e.evidence.map(String) : [] })) as Extras['events'] }, args.key, { to: args.to, by: actor, evidence, force }, now); };
  appendEvent(ctx.dir, actor, { task: args.key, to: args.to, by: actor, ...(evidence.length ? { evidence } : {}), ...(note ? { note } : {}), ...(force ? { force: true } : {}) }, { now, guard });
  ctx.io.data?.({ task: args.key, from: before, to: args.to, by: actor }, { next: [] });
  ctx.io.out(`${oneLine(args.key, 80)} ${before} -> ${args.to} by ${actor}`);
  return 0;
}
