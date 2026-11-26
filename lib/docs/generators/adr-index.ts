// adr-index: decision records by id with status, date and what they affect.
import { idText, short } from '../fence.ts';
import { defineGenerator, mdTable, sorted } from './common.ts';

export const adrIndex = defineGenerator({
  id: 'adr-index', title: () => '# Decision index', v: 1, out: () => 'decisions.md',
  data: (_model, _policy, c) => sorted(c.extras.decisions ?? [], (d) => d.id).map((d) => ({
    id: idText(d.id), title: short(d.title ?? ''), status: d.status ?? 'proposed', date: idText(d.date ?? ''), by: d.derivation ?? '',
    affects: [...(d.affects ?? [])].map((a) => idText(a)).sort(), supersedes: [...(d.supersedes ?? [])].map((a) => idText(a)).sort(),
  })),
  view: (ds) => {
    if (ds.length === 0) return ['No decisions recorded.'];
    const out = mdTable(['Decision', 'Title', 'Status', 'Date', 'Basis', 'Supersedes', 'Affects'], ds.map((d) => [d.id, d.title, d.status, d.date, d.by, d.supersedes.join(', '), d.affects.join(', ')]));
    const by = new Map<string, number>();
    for (const d of ds) by.set(d.status, (by.get(d.status) ?? 0) + 1);
    return [...out, '', `Counts: ${[...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ')}.`];
  },
});
