// open-items: the open-items list derived from findings (plus registered items), compact view, close/reopen/register, findings from a
// file or stdin, and --suggest-from-status (prints suggested --register lines from .wolf/STATUS.md; registers nothing).
// `--close KEY KIND`, `--reopen KEY KIND` and `--register KEY KIND` take the two positionals; only one of them per run.
import path from 'node:path';
import { readJsonl, readCapped } from '../../lib/jsonl.ts';
import { oneLine, sanitizeText } from '../../lib/sanitize.ts';
import { verbose, usage, modelFromDb, readItems, precheckTargets, writeState, fenceBlock } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
/** The options of open-items (see `commands` below), as parse() gives them. */
type OpenItemsValues = { 'suggest-from-status'?: boolean; findings?: string; close?: boolean; reopen?: boolean; register?: boolean; by?: string; note?: string; at?: string;
  owner?: string; due?: number; text?: string; mine?: boolean; me?: string; sprint?: number; write?: boolean };

const ACTIONS = ['close', 'reopen', 'register'] as const;
const shq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const cap80 = (s: unknown) => { const t = oneLine(s, 4000); if (t.length <= 80) return t; let cut = 79; if (/[\uD800-\uDBFF]/.test(t[cut - 1] as string)) cut--; return `${t.slice(0, cut)}…`; }; // t[78] exists: t.length > 80 here

async function suggestFromStatus(ctx: Ctx, args: Args<OpenItemsValues>): Promise<number> {
  const v = args.values;
  if (v.write || v.register || v.close || v.reopen) throw usage('--suggest-from-status only prints; it cannot be combined with --write, --register, --close or --reopen');
  const W = await import('../../lib/integrations/openwolf.ts'), out = ctx.io.out, r = W.readWolfFile(ctx.root, 'STATUS.md');
  if (!r.ok) { out(r.missing ? 'no suggestions: .wolf/STATUS.md not found' : `warning: ${r.warning}`); return 0; }
  const known = new Set(readJsonl(path.join(ctx.dir, 'tickets.jsonl')).map((t) => t.key));
  const openPairs = new Set(readJsonl(path.join(ctx.dir, 'open-items.jsonl')).filter((x) => x && x.status !== 'done').map((x) => `${x.key}|${x.kind}`));
  const unknown = new Set<string>(), seen = new Set<string>(), lines: string[] = [];
  for (const b of W.parseStatus(r.text).bullets) {
    if (b.section === 'done') continue;
    const kind = b.section === 'decisions' ? 'decision' : b.section === 'blockers' ? 'blocker' : 'followup';
    for (const k of b.keys) {
      if (!known.has(k)) { unknown.add(k); continue; }
      if (openPairs.has(`${k}|${kind}`)) continue;
      const line = `brain open-items --register ${k} ${kind} --owner OWNER --due N --text ${shq(cap80(b.text))}`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
  }
  const lim = verbose(args) ? 200 : 20, shown = lines.slice(0, lim);
  if (!lines.length) out('no suggestions: no open STATUS bullet names a ticket in the plan');
  else { out('suggested open items from .wolf/STATUS.md (printed only, nothing registered; a person confirms each and fills in owner and due):'); ctx.io.outBlock(W.fenceWolf('wolf-status', shown.join('\n')).split('\n')); }
  if (lines.length > shown.length) out(`... ${lines.length - shown.length} more (-v for all)`);
  if (unknown.size) out(`skipped ${unknown.size} key${unknown.size === 1 ? '' : 's'} not in the plan`);
  return 0;
}

const FINDINGS_MISSING = '--findings needs a file path (or - for stdin)';
function readFindings(ctx: Ctx, OI: typeof import('../../lib/openitems.ts'), f: string) {
  if (!f) throw usage(FINDINGS_MISSING);
  const cap = OI.MAX_FINDINGS_BYTES, shown = sanitizeText(path.basename(f), { max: 80 });
  let raw: string;
  try {
    if (f === '-') {
      if (ctx.stdin.isTTY) throw usage('--findings - needs piped input, not a terminal');
      raw = ctx.stdin.read(cap);
    } else raw = readCapped(f, cap);
  } catch (e) { // a BrainError (code USAGE) or a coded read error
    if ((e as NodeJS.ErrnoException | undefined)?.code === 'USAGE') throw e; // fs and the readers throw errno-style errors with a code
    if ((e as NodeJS.ErrnoException).code === 'TOO_LARGE') throw usage(`findings ${f === '-' ? 'input' : 'file'} too large (limit ${cap / 1048576} MiB)`); // fs and the readers throw errno-style errors with a code
    if ((e as NodeJS.ErrnoException).code === 'NOT_A_FILE') throw usage('findings path is not a regular file'); // fs and the readers throw errno-style errors with a code
    if ((e as NodeJS.ErrnoException).code === 'TIMEOUT') throw usage('stdin timed out'); // fs and the readers throw errno-style errors with a code
    throw usage(f === '-' ? 'cannot read stdin' : `cannot read ${shown}`);
  }
  const r = OI.parseFindings(raw, f === '-' ? 'stdin' : shown);
  for (const e of r.errors) ctx.io.err(`findings error: ${e}`);
  return r.findings;
}

async function openItems(ctx: Ctx, args: Args<OpenItemsValues>): Promise<number> {
  const v = args.values;
  if (v['suggest-from-status']) return suggestFromStatus(ctx, args); // prints only; reads and writes no open-items file
  const acts = ACTIONS.filter((a) => v[a]);
  if (acts.length > 1) throw usage('give only one of --close, --reopen and --register');
  const [act] = acts;
  if (act && args.positionals.length !== 2) throw usage(`--${act} needs KEY KIND`);
  if (!act && args.positionals.length) throw usage('unexpected arguments (KEY KIND go with --close, --reopen or --register)');
  const R = await import('../../lib/render.ts'), { OI, items: existing } = await readItems(ctx), model = modelFromDb(ctx), cfg = ctx.config();
  const extra = v.findings !== undefined ? readFindings(ctx, OI, v.findings) : [];
  let items = OI.reconcileItems(existing, OI.openItemsFromFindings(model, cfg, { extraFindings: extra }));
  const [key, kind] = args.positionals;
  try {
    if (act === 'close') items = OI.closeItem(items, key as string, kind as string, { by: v.by ?? '', note: v.note ?? '', at: v.at, now: ctx.now } as NonNullable<Parameters<typeof OI.closeItem>[3]>); // an act needs exactly 2 positionals (checked above); closeItem destructures at without a default: undefined reads as absent
    if (act === 'reopen') items = OI.reopenItem(items, key as string, kind as string); // an act needs exactly 2 positionals (checked above)
    if (act === 'register') items = OI.registerItem(items, { key, kind, owner: v.owner, due_sprint: v.due ?? null, text: v.text ?? '' } as NonNullable<Parameters<typeof OI.registerItem>[1]>); // an act needs exactly 2 positionals (checked above); registerItem destructures owner without a default: undefined reads as absent
  } catch (e) { throw usage(oneLine((e as Error).message, 200)); } // lib/openitems.ts throws an Error with a fixed message
  if (v.write || act) {
    const files: [string, string] = [path.join(ctx.dir, 'open-items.jsonl'), path.join(ctx.dir, 'OPEN-ITEMS.md')];
    precheckTargets(ctx, files);
    writeState(ctx, files[0], OI.serializeItems(items)); writeState(ctx, files[1], OI.renderOpenItems(items));
    ctx.io.out(`open-items.jsonl and OPEN-ITEMS.md written (${items.filter((i) => i.status !== 'done').length} open)`);
    return 0;
  }
  const mine = v.mine ? items.filter((i) => i.owner === v.me) : items;
  // The compact view's item lines carry free text: they are printed inside one fence, one item per line; head and "... N more" outside.
  const [head, ...rest] = (OI.renderCompact(mine, { me: v.me, currentSprint: v.sprint, limit: verbose(args) ? 50 : 5 } as NonNullable<Parameters<typeof OI.renderCompact>[1]>) as string).split('\n'); // limit is 50 or 5, so a string comes back; renderCompact destructures me and currentSprint without defaults: undefined reads as absent
  const lines = rest.filter((l) => l.startsWith('- ')), tail = rest.filter((l) => !l.startsWith('- '));
  ctx.io.out(R.clean(head));
  if (lines.length) ctx.io.outBlock(fenceBlock('open-items', lines.map((l) => oneLine(l, 300))));
  for (const l of tail) ctx.io.out(R.clean(l));
  return 0;
}

const B = { type: 'boolean' }, S = { type: 'string' };
export const commands: CommandMap = {
  'open-items': {
    run: openItems, positionals: [0, 2], writes: 'text', guard: (v: Record<string, unknown>) => (v.write || v.close || v.reopen || v.register ? 'strict' : 'soft'), // strict whenever it writes
    options: { 'suggest-from-status': B, findings: { type: 'string', missing: FINDINGS_MISSING }, close: B, reopen: B, register: B, by: S, note: S, at: S, owner: S, due: { type: 'integer' }, text: S, mine: B, me: S, sprint: { type: 'integer' }, write: B },
    summary: 'open items from findings: compact view, --close/--reopen/--register KEY KIND, --findings FILE|-, --suggest-from-status',
  },
};
