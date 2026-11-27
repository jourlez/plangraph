// plangraph flow-link TASK SYS XID: write the xref the agent got back from the vendor tool (the tracker ticket made for a plan task).
// One row through the store; the same call again changes nothing.
import { oneLine } from '../../lib/sanitize.ts';
import { openStore } from '../../lib/planstore.ts';
import { loadFlow, needTask } from './flow-util.ts';
import { usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const SYS = /^[a-z][a-z0-9-]{0,29}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,60}(?:\/[A-Za-z0-9._-]{1,60})?)?$/, XID = /^[A-Za-z0-9._:\/# @-]{1,200}$/;
function link(ctx: Ctx, args: Args): number {
  const [task, sys, xid] = args.positionals as [string, string, string];
  if (!SYS.test(sys)) throw usage('SYS must be <name> or <name>:<alias>, lower-case, no host and no URL');
  if (!XID.test(xid) || xid.includes('..')) throw usage('XID must be 1 to 200 characters of A-Z a-z 0-9 . _ : / # @ space -');
  const { model } = loadFlow(ctx);
  needTask(model, task);
  const store = openStore(ctx), rows = store.readKind('xref', { defaults: false });
  const shown = `${oneLine(task, 80)} ${oneLine(sys, 60)} ${oneLine(xid, 120)}`;
  if (rows.some((r) => r.type === 'ticket' && r.id === task && r.sys === sys && r.xid === xid)) {
    ctx.io.data?.({ task, sys, xid, written: false }, { next: [] });
    ctx.io.out(`unchanged ${shown}`);
    return 0;
  }
  store.writeKind('xref', [...rows, { type: 'ticket', id: task, sys, xid }], { precheck: true });
  ctx.io.data?.({ task, sys, xid, written: true }, { next: [] });
  ctx.io.out(`linked ${shown}`);
  return 0;
}
export const commands: CommandMap = {
  'flow-link': {
    run: link as never, positionals: [3, 3], writes: 'text', guard: 'strict',
    summary: 'TASK SYS XID: record the tracker ticket made for a plan task as one xref (idempotent)',
  },
};
