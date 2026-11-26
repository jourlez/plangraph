// Adapter from the loaded model to the Deps that lib/flow/state.ts asks for. The one blocker definition stays in lib/graph/blockers.ts.
import type { Model, PlanRecord } from '../model.ts';
import { blockersOf, modelSource } from '../graph/blockers.ts';
import { closedStatuses } from '../frozen.ts';
import type { Deps } from './state.ts';

/** openDeps: producers still waiting (WAITS); gated: a verdict other than READY or an open item or finding. A ticket the model does not know has neither. */
export function depsFromModel(model: Model, o: { items?: readonly PlanRecord[] } = {}): Deps {
  const src = modelSource(model, o.items ? { items: o.items } : {}), closed = closedStatuses(model.config);
  const why = (key: string) => blockersOf(src, key, { closed }).reasons;
  return {
    openDeps: (key) => why(key).flatMap((r) => (r.code === 'WAITS' ? [r.key] : [])),
    gated: (key) => why(key).some((r) => r.code !== 'WAITS'),
  };
}
