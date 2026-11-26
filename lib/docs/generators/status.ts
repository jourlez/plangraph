// status: the plan status report body (counts, ready line, load, critical chain) from lib/report.ts, with owners as pseudonyms
// unless docs.include lists names. No forecast, stale or tracker date: those come from files outside the graph.
import { buildReport } from '../../report.ts';
import { idText } from '../fence.ts';
import { defineGenerator, mdTable, who } from './common.ts';

const LIMIT = 20;
export const status = defineGenerator({
  id: 'status', title: () => '# Status', v: 1, out: () => 'status.md',
  data: (model, policy) => {
    const d = buildReport(model).data;
    return {
      tickets: d.tickets, placed: d.placed, last: d.last_sprint, over: d.over_cap,
      ready: { n: d.ready.count, keys: d.ready.keys.slice(0, LIMIT).map(idText), more: Math.max(0, d.ready.keys.length - LIMIT) },
      blocked: d.blocked_by_open_item.count,
      chain: { hops: d.critical_chain.hops, keys: d.critical_chain.keys.slice(0, LIMIT).map(idText), loop: d.critical_chain.loop },
      load: d.sprint_load.map((l) => [l.sprint, who(l.owner, policy), l.sp, l.cap, l.n, l.over ? 'over' : 'ok']),
      people: d.people.map((p) => [who(p.owner, policy), p.tickets, p.sp, p.ready, p.first, p.last]),
    };
  },
  view: (d) => {
    const out = [`Tickets ${d.tickets}, placed ${d.placed}, last sprint ${d.last}, person-sprints over capacity ${d.over}.`, ''];
    out.push('## Ready', '', `${d.ready.n} ready: ${d.ready.keys.join(', ') || 'none'}${d.ready.more ? `, ... ${d.ready.more} more` : ''}.`, '');
    out.push(`Blocked by an open item: ${d.blocked}.`, '', '## Critical chain', '', `${d.chain.hops} hops${d.chain.loop ? ' (loop)' : ''}: ${d.chain.keys.join(' > ') || 'none'}.`, '');
    out.push('## Sprint load', '', ...mdTable(['Sprint', 'Owner', 'Points', 'Cap', 'Tickets', 'Load'], d.load), '');
    out.push('## People', '', ...mdTable(['Owner', 'Tickets', 'Points', 'Ready', 'First', 'Last'], d.people));
    return out;
  },
});
