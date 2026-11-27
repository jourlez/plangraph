// The requirements traceability matrix (spec 5.2 step 5): requirement -> satisfying tasks -> state. Pure.
// A task that is skipped or removed no longer counts toward a requirement. A requirement with no satisfying link is an orphan.
import type { Model } from '../model.ts';
import type { FlowLink } from './brief.ts';
import { deriveAll } from './state.ts';
import type { EventIn, TaskState } from './state.ts';
import { depsFromModel } from './deps.ts';

type RtmStatus = 'proposed' | 'implemented' | 'verified' | 'orphan';
export interface RtmRow { requirement: string; tasks: { key: string; state: TaskState }[]; status: RtmStatus }
export interface RtmExtras { requirements?: readonly { id: string }[]; links?: readonly FlowLink[]; merged?: (ref: string) => boolean }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const proof = (ref: string): boolean => ref.startsWith('pr:') || ref.startsWith('test:');

/** implemented: every live satisfying task is done. verified: implemented and each of those tasks has `pr:` or `test:` evidence. */
export function rtm(model: Model, events: readonly EventIn[], extras: RtmExtras = {}): RtmRow[] {
  const by = new Map<string, Set<string>>();
  for (const l of extras.links ?? []) if (l.rel === 'satisfies' && l.to_type === 'requirement') { const s = by.get(l.to); if (s) s.add(l.from); else by.set(l.to, new Set([l.from])); }
  const reqs = [...new Set([...(extras.requirements ?? []).map((r) => r.id), ...by.keys()])].sort(cmp);
  const keys = [...new Set([...by.values()].flatMap((s) => [...s]))].sort(cmp);
  const derived = deriveAll(keys, events, depsFromModel(model), extras.merged ? { merged: extras.merged } : {});
  return reqs.map((requirement): RtmRow => {
    const all = [...(by.get(requirement) ?? [])].sort(cmp);
    if (!all.length) return { requirement, tasks: [], status: 'orphan' };
    const tasks = all.map((key) => ({ key, state: (derived.get(key) as { state: TaskState }).state })); // every linked key was passed to deriveAll
    const live = tasks.filter((t) => t.state !== 'skipped' && t.state !== 'removed');
    const done = live.length > 0 && live.every((t) => t.state === 'done');
    const verified = done && live.every((t) => (derived.get(t.key) as { evidence: string[] }).evidence.some(proof));
    return { requirement, tasks, status: verified ? 'verified' : done ? 'implemented' : 'proposed' };
  });
}
