// Property (j): lib/whatif.ts findSlots (`brain whatif KEY --find`) against a clean-room brute force, on EVERY instance of the family.
//
// The specified rule (docs/CONTRACT.md "Find"), stated here once, written from the contract and not from the library:
//   slot space of KEY (current owner O, sprint C): O in every sprint C+1..end; with allowEarlier O in first..C-1; with allowOwnerChange every
//   other person (an owner in the schedule or a caps key other than default) in C..end (first..end with allowEarlier). first = first_sprint
//   ?? 1, end = end_sprint ?? the last sprint used. A slot is VALID when the clean-room whatif oracle (whatif.assure.ts oracleMove) says YES
//   for {key, to, sprint} (a STARTED warning alone keeps it valid; strict makes it a stop) AND, applied to a copy, the multiset of oracle
//   violations after is contained in the one before. Ranking: |to sprint - C|, then the same owner first, then the load of the target cell
//   (before the move), then owner name, then sprint. The library's ordered list of valid slots equals the brute force's, its counts
//   (tried = size of the slot space, valid) match, and every reason count is a count of non-valid slots. A KEY whatif stops with STARTED
//   (closed; under strict also In Progress or a listed frozen status) has no slot: status 'frozen' after one try ('none' when its slot space is empty).
// Family (BOUNDS): T1..T3, every graph without self-links on them x every placement of the three on {Ana S1, Ana S2, Ben S2, Ben S3} x two
// story-point vectors x T1 To Do / Done / In Progress x four flag combinations x strict or not x KEY each ticket; caps 2, end_sprint 3.
// NOT covered: instances beyond BOUNDS; FIND_MAX (the family is far below it; test/whatif-find.test.ts hits it on purpose); the CLI text.
import assert from 'node:assert/strict';
import { buildModel } from '../../lib/model.ts';
import { findSlots } from '../../lib/whatif.ts';
import type { FindResult } from '../../lib/whatif.ts';
import { oracleViolations, capFor, validPlacement, personsOf, isClosedTicket } from './oracle.ts';
import type { Instance, OTicket, Placement } from './oracle.ts';
import { product, bag } from './enum.ts';
import type { Level } from './enum.ts';
import { oracleMove } from './whatif.assure.ts';

export interface FindFlags { allowEarlier?: boolean; allowOwnerChange?: boolean }
export interface FoundSlot { owner: string; sprint: number; slip: number; same: boolean; load: number; cap: number }
interface FindBound { sts: string[]; sps: number[][]; flags: FindFlags[]; strict: boolean[]; keys: string[] }
export const BOUNDS: Record<Level, FindBound> = {
  full: { sts: ['To Do', 'Done', 'In Progress'], sps: [[1, 1, 1], [2, 1, 1]], flags: [{}, { allowEarlier: true }, { allowOwnerChange: true }, { allowEarlier: true, allowOwnerChange: true }], strict: [false, true], keys: ['T1', 'T2', 'T3'] },
  quick: { sts: ['To Do', 'Done'], sps: [[2, 1, 1]], flags: [{}, { allowEarlier: true, allowOwnerChange: true }], strict: [false], keys: ['T1'] },
};
const SLOTS: Placement[] = [{ owner: 'Ana', sprint: 1 }, { owner: 'Ana', sprint: 2 }, { owner: 'Ben', sprint: 2 }, { owner: 'Ben', sprint: 3 }];
const vsig = (v: { code: string; key: string; producer?: string }): string => (v.code === 'HANDOFF' ? `HANDOFF|${v.key}|${v.producer}` : `${v.code}|${v.key}`);
const spOf = (t: OTicket | undefined): number => (t && typeof t.sp === 'number' && Number.isFinite(t.sp) ? t.sp : 0);

/** The brute force: ordered valid slots and the size of the slot space. */
export function oracleFind(inst: Instance, key: string, flags: FindFlags, strict: boolean): { tried: number; valid: FoundSlot[] } {
  const cur = inst.sched.get(key) as Placement, cfg = inst.config || {};
  let used = 0; for (const p of inst.sched.values()) if (p.sprint > used) used = p.sprint;
  const first = cfg.first_sprint ?? 1, end = cfg.end_sprint ?? used;
  const space: Placement[] = [];
  for (let s = cur.sprint + 1; s <= end; s++) space.push({ owner: cur.owner, sprint: s });
  if (flags.allowEarlier) for (let s = first; s < cur.sprint; s++) space.push({ owner: cur.owner, sprint: s });
  if (flags.allowOwnerChange) for (const q of [...personsOf(inst)].filter((x) => x !== cur.owner)) for (let s = flags.allowEarlier ? first : cur.sprint; s <= end; s++) space.push({ owner: q, sprint: s });
  const before = bag(oracleViolations(inst).map(vsig)), valid: FoundSlot[] = [];
  for (const x of space) {
    if (!oracleMove(inst, { key, to: x.owner, sprint: x.sprint }, strict ? { strict: true } : {}).yes) continue;
    const after = new Map(inst.sched); after.set(key, x);
    const left = [...before];
    if (!oracleViolations({ ...inst, sched: after }, after).map(vsig).every((v) => { const i = left.indexOf(v); if (i < 0) return false; left.splice(i, 1); return true; })) continue;
    let load = 0; for (const [k, p] of inst.sched) if (validPlacement(p) && p.owner === x.owner && p.sprint === x.sprint) load += spOf(inst.tickets.find((t) => t.key === k));
    valid.push({ ...x, slip: Math.abs(x.sprint - cur.sprint), same: x.owner === cur.owner, load, cap: capFor(cfg, x.owner) });
  }
  valid.sort((a, b) => a.slip - b.slip || Number(b.same) - Number(a.same) || a.load - b.load || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || a.sprint - b.sprint);
  return { tried: space.length, valid };
}

export function assureFind(lvl: Level): { instances: number; found: number; none: number; frozen: number; slots: number } {
  const B = BOUNDS[lvl], keys = ['T1', 'T2', 'T3'], pairs: Array<[string, string]> = [];
  for (const c of keys) for (const p of keys) if (c !== p) pairs.push([c, p]);
  const counts = { instances: 0, found: 0, none: 0, frozen: 0, slots: 0 };
  for (let mask = 0; mask < 1 << pairs.length; mask++) {
    const edges = pairs.filter((_, i) => (mask >> i) & 1).map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' }));
    product([...keys.map(() => SLOTS), B.sps, B.sts], (ch) => {
      const [p1, p2, p3, sps, st] = ch as [Placement, Placement, Placement, number[], string]; // the dims are three slot lists, then sps, then sts
      const tickets = keys.map((key, i) => ({ key, sp: sps[i], jira_status: i === 0 ? st : 'To Do' }));
      const sched = new Map([['T1', p1], ['T2', p2], ['T3', p3]]), config = { first_sprint: 1, end_sprint: 3, caps: { default: 2 } };
      const inst = { tickets, edges, sched, config }, model = buildModel({ tickets, edges, config });
      model.sched = sched;
      for (const key of B.keys) for (const flags of B.flags) for (const strict of B.strict) {
        counts.instances++;
        const got: FindResult = findSlots(model, key, { ...flags, strict }), want = oracleFind(inst, key, flags, strict);
        const st = tickets.find((t) => t.key === key)?.jira_status, stops = isClosedTicket(inst, key) || (strict && st === 'In Progress');
        if (stops) {
          if (got.status !== (want.tried ? 'frozen' : 'none') || got.valid || got.tried > 1 || (want.tried && got.tried !== 1) || want.valid.length) assert.fail(`find on a stopped key\n${JSON.stringify({ key, st, strict, got })}`);
          counts.frozen++; continue;
        }
        const g = got.slots.map((x) => `${x.owner} S${x.sprint} ${x.slip} ${x.load}/${x.cap}`), w = want.valid.map((x) => `${x.owner} S${x.sprint} ${x.slip} ${x.load}/${x.cap}`);
        if (got.tried !== want.tried || g.join('|') !== w.join('|') || got.valid !== want.valid.length || got.status !== (want.valid.length ? 'found' : 'none') || !got.searchComplete
          || Object.values(got.reasons).some((n) => n > got.tried - got.valid)) {
          assert.fail(`find differs\n${JSON.stringify({ edges, sched: [...sched], tickets, key, flags, strict, got: { tried: got.tried, slots: g, reasons: got.reasons }, want: { tried: want.tried, slots: w } })}`);
        }
        counts[want.valid.length ? 'found' : 'none']++; counts.slots += want.valid.length;
      }
    });
  }
  return counts;
}
