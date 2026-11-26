// Shared builders for generators: a generator is a pure `data` function (policy-filtered facts) plus a `view`; the fingerprint inputs
// are exactly the data, so a generator is stale exactly when a fact it prints changed.
import type { Model, PlanConfig, Ticket } from '../../model.ts';
import { cmp, hash8, short } from '../fence.ts';
import type { DataPolicy } from '../policy.ts';
import type { Ctx, Extras, Generator } from '../types.ts';

export const docsOut = (cfg: PlanConfig): string => {
  const d = (cfg.docs ?? {}) as { out?: unknown };
  return typeof d.out === 'string' && d.out !== '' ? d.out.replace(/\/+$/, '') : 'docs/plangraph';
};
export const docsOpt = (cfg: PlanConfig, k: string): unknown => ((cfg.docs ?? {}) as Record<string, unknown>)[k];

export const statusOf = (t: Ticket): string => t.impl_status ?? 'todo';
/** A person for print: the name only when the policy lists names, else a stable pseudonym. */
export const who = (name: unknown, policy: DataPolicy): string => {
  const s = String(name ?? '');
  if (s === '') return '';
  return policy.include.has('names') ? short(s, 40) : `p-${hash8(s)}`;
};
export const title = (t: Ticket, policy: DataPolicy): string => (policy.include.has('tracker_text') && t.summary ? short(t.summary) : '');

const cell = (s: unknown): string => String(s ?? '').replaceAll('|', '/');
export function mdTable(head: readonly string[], rows: readonly (readonly unknown[])[]): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
}
export const sorted = <T>(xs: Iterable<T>, key: (x: T) => string): T[] => [...xs].sort((a, b) => cmp(key(a), key(b)));
export const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

type Spec<D> = {
  id: string; title: (key?: string) => string; v: number; out: (cfg: PlanConfig, key?: string) => string;
  keys?: (model: Model, extras: Extras) => string[];
  data: (model: Model, policy: DataPolicy, c: Ctx) => D;
  view: (d: D, c: Ctx) => string[];
};
export function defineGenerator<D>(s: Spec<D>): Generator {
  const g: Generator = {
    id: s.id, title: s.title, v: s.v, out: s.out,
    inputs: (model, c) => [JSON.stringify(s.data(model, c.policy, c))],
    render: (model, policy, c) => s.view(s.data(model, policy, c), c).join('\n'),
  };
  if (s.keys) g.keys = s.keys;
  return g;
}
