// roadmap: tickets by sprint with status, points and owner. Owners are pseudonyms unless docs.include lists names; ticket titles are
// tracker text and print only when docs.include lists tracker_text.
import { idText } from '../fence.ts';
import { defineGenerator, mdTable, num, sorted, statusOf, title, who } from './common.ts';

type Row = { k: string; s: string; sp: number; e: string; sprint: number | null; o: string; t: string };

export const roadmap = defineGenerator({
  id: 'roadmap', title: () => '# Roadmap', v: 1, out: () => 'roadmap.md',
  data: (model, policy) => {
    const rows: Row[] = sorted(model.tickets.values(), (t) => t.key).map((t) => {
      const p = model.sched.get(t.key);
      return { k: idText(t.key), s: statusOf(t), sp: num(t.sp), e: t.epic ? idText(t.epic) : '', sprint: p && Number.isInteger(p.sprint) ? (p.sprint as number) : null, o: who(p?.owner ?? t.v2_owner ?? '', policy), t: title(t, policy) };
    });
    return rows;
  },
  view: (rows) => {
    const sprints = [...new Set(rows.map((r) => r.sprint))].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
    const out = [`Tickets: ${rows.length}. Facts from the plan graph; no dates.`, ''];
    for (const sp of sprints) {
      const rs = rows.filter((r) => r.sprint === sp);
      out.push(`## ${sp === null ? 'Unscheduled' : `Sprint ${sp}`}`, '', `${rs.length} tickets, ${rs.reduce((a, r) => a + r.sp, 0)} points.`, '');
      out.push(...mdTable(['Ticket', 'Status', 'Points', 'Epic', 'Owner', 'Title'], rs.map((r) => [r.k, r.s, r.sp, r.e, r.o, r.t])), '');
    }
    return out.slice(0, -1);
  },
});
