// Topological list-scheduling heuristic with a critical-path bound (amendment 3.14 item 3). Pure, no I/O.
// The schedule is an UPPER bound on the best end sprint (any valid schedule is); lowerBound is a bound no schedule can beat.
// A consumer starts no earlier than its producer's sprint, plus one when the owners differ (the solver's link rule, test/fixtures/gen.ts).

/** One schedulable item: owner fixed, sp points, deps = producers. */
export interface HItem { key: string; owner: string; sp: number; deps: readonly string[] }
export interface HOpts { first?: number; cap: number | Record<string, number> }
export interface HResult {
  sprint: Map<string, number>; end: number; lowerBound: number; label: 'upper bound';
  /** keys not placed because they sit on a cycle or depend on an unknown key */
  unplaced: string[];
}

const capOf = (cap: HOpts['cap'], owner: string): number => (typeof cap === 'number' ? cap : cap[owner] ?? cap.default ?? Infinity);

/** Keys in a topological order (producers first), ties by key; items on a cycle or with an unknown dep are left out. */
function topoOrder(items: readonly HItem[]): { order: HItem[]; bad: string[] } {
  const by = new Map(items.map((i) => [i.key, i]));
  const left = new Map<string, number>(); const cons = new Map<string, string[]>();
  for (const i of items) {
    const ds = [...new Set(i.deps)];
    left.set(i.key, ds.length);
    for (const d of ds) { if (!by.has(d)) left.set(i.key, Infinity); else (cons.get(d) ?? cons.set(d, []).get(d) as string[]).push(i.key); }
  }
  const ready = items.filter((i) => left.get(i.key) === 0).map((i) => i.key).sort();
  const order: HItem[] = [];
  while (ready.length) {
    const k = ready.shift() as string; order.push(by.get(k) as HItem);
    for (const c of (cons.get(k) ?? []).sort()) { const n = (left.get(c) ?? 0) - 1; left.set(c, n); if (n === 0) ready.push(c); }
    ready.sort();
  }
  const placed = new Set(order.map((i) => i.key));
  return { order, bad: items.filter((i) => !placed.has(i.key)).map((i) => i.key).sort() };
}

/** List-schedules the items (critical-path first) and bounds the end sprint from below. */
export function listSchedule(items: readonly HItem[], opts: HOpts): HResult {
  const first = opts.first ?? 1;
  const { order, bad } = topoOrder(items);
  const by = new Map(order.map((i) => [i.key, i]));
  // tail[k] = longest chain of sprints from k to the end (counting owner hops), computed in reverse topological order
  const tail = new Map<string, number>(); const cons = new Map<string, HItem[]>();
  for (const i of order) for (const d of new Set(i.deps)) (cons.get(d) ?? cons.set(d, []).get(d) as HItem[]).push(i);
  for (let n = order.length - 1; n >= 0; n--) {
    const i = order[n] as HItem; let t = 0;
    for (const c of cons.get(i.key) ?? []) t = Math.max(t, (c.owner === i.owner ? 0 : 1) + (tail.get(c.key) ?? 0));
    tail.set(i.key, t);
  }
  // earliest start ignoring capacity (the critical-path bound), in topological order
  const early = new Map<string, number>(); let cp = first;
  for (const i of order) {
    let s = first; for (const d of i.deps) s = Math.max(s, (early.get(d) ?? first) + ((by.get(d) as HItem).owner === i.owner ? 0 : 1));
    early.set(i.key, s); cp = Math.max(cp, s);
  }
  const used = new Map<string, number>(); // "owner|sprint" -> points
  const sprint = new Map<string, number>(); const done = new Set<string>(); let end = first - 1;
  const pending = new Set(order.map((i) => i.key));
  while (pending.size) { // pick the available item with the longest tail (critical path first), ties by key
    let pick: HItem | null = null;
    for (const k of pending) {
      const i = by.get(k) as HItem; if (!i.deps.every((d) => done.has(d))) continue;
      if (!pick || ((tail.get(k) as number) > (tail.get(pick.key) as number)) || (tail.get(k) === tail.get(pick.key) && k < pick.key)) pick = i;
    }
    const i = pick!; let s = first;
    for (const d of i.deps) s = Math.max(s, sprint.get(d)! + (by.get(d)!.owner === i.owner ? 0 : 1));
    const c = capOf(opts.cap, i.owner);
    for (;; s++) { const u = used.get(`${i.owner}|${s}`) ?? 0; if (u === 0 ? true : u + i.sp <= c) break; }
    used.set(`${i.owner}|${s}`, (used.get(`${i.owner}|${s}`) ?? 0) + i.sp);
    sprint.set(i.key, s); done.add(i.key); pending.delete(i.key); end = Math.max(end, s);
  }
  // capacity bound per owner: its points need ceil(sum / cap) sprints
  let lb = cp; const pts = new Map<string, number>();
  for (const i of order) pts.set(i.owner, (pts.get(i.owner) ?? 0) + i.sp);
  for (const [o, p] of pts) { const c = capOf(opts.cap, o); if (c > 0 && Number.isFinite(c)) lb = Math.max(lb, first + Math.ceil(p / c) - 1); }
  return { sprint, end: Math.max(end, first), lowerBound: lb, label: 'upper bound', unplaced: bad };
}
