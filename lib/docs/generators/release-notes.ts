// release-notes: done tickets for a sprint range (docs.release_from and docs.release_to, default every scheduled sprint), by epic.
import { idText } from '../fence.ts';
import { defineGenerator, docsOpt, mdTable, num, sorted, statusOf, title } from './common.ts';

export const releaseNotes = defineGenerator({
  id: 'release-notes', title: () => '# Release notes', v: 1, out: () => 'release-notes.md',
  data: (model, policy, c) => {
    const sprints = [...model.sched.values()].map((p) => p.sprint).filter((s): s is number => Number.isInteger(s));
    const lo = Number.isInteger(docsOpt(c.cfg, 'release_from')) ? (docsOpt(c.cfg, 'release_from') as number) : Math.min(...sprints);
    const hi = Number.isInteger(docsOpt(c.cfg, 'release_to')) ? (docsOpt(c.cfg, 'release_to') as number) : Math.max(...sprints);
    const done = sorted(model.tickets.values(), (t) => t.key).filter((t) => {
      const s = model.sched.get(t.key)?.sprint;
      return statusOf(t) === 'done' && Number.isInteger(s) && (s as number) >= lo && (s as number) <= hi;
    });
    const epics = [...new Set(done.map((t) => t.epic ?? ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0));
    return {
      range: sprints.length ? [lo, hi] : null,
      epics: epics.map((e) => ({ e: e === '' ? '' : idText(e), ts: done.filter((t) => (t.epic ?? '') === e).map((t) => [idText(t.key), num(t.sp), model.sched.get(t.key)?.sprint, title(t, policy)]) })),
    };
  },
  view: (d) => {
    if (!d.range) return ['Unknown: sprint range (no scheduled tickets)'];
    const out = [`Sprints ${d.range[0]} to ${d.range[1]}. Done tickets only.`, ''];
    if (d.epics.length === 0) out.push('No done tickets in this range.');
    for (const g of d.epics) out.push(`## ${g.e === '' ? 'No epic' : g.e}`, '', ...mdTable(['Ticket', 'Points', 'Sprint', 'Title'], g.ts), '');
    return d.epics.length ? out.slice(0, -1) : out;
  },
});
