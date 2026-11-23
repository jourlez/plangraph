// Exhaustive enumerators for the small-scope suite. No randomness: every function walks a full Cartesian product in a fixed order.
// Level: 'full' (npm run assure) or 'quick' (the default node --test run). Each family states its bounds in BOUNDS so the report can
// print exactly what was enumerated.

export const level = () => (process.env.ASSURE_LEVEL === 'quick' ? 'quick' : 'full');
export const PEOPLE = ['Ana', 'Ben', 'Cleo'];
export const keysOf = (n) => Array.from({ length: n }, (_, i) => `T${i + 1}`);

// Call fn(choice) for every element of the product of the given arrays (a choice is a fresh array, index-aligned with `dims`).
export function product(dims, fn) {
  const n = dims.length, idx = new Array(n).fill(0);
  if (dims.some((d) => d.length === 0)) return;
  for (;;) {
    fn(idx.map((i, j) => dims[j][i]));
    let j = n - 1;
    while (j >= 0 && ++idx[j] === dims[j].length) { idx[j] = 0; j--; }
    if (j < 0) return;
  }
}
// Every subset of a list (as arrays, in binary-counter order).
export function subsets(list) {
  const out = [];
  for (let m = 0; m < 1 << list.length; m++) out.push(list.filter((_, i) => m & (1 << i)));
  return out;
}
// Every directed graph over `keys` with self-links (every subset of the n*n ordered pairs), as [[consumer, producer]].
export function allGraphs(keys) {
  const pairs = [];
  for (const c of keys) for (const p of keys) pairs.push([c, p]);
  return subsets(pairs);
}
// Every placement of one ticket: unplaced (null) or owner x sprint.
export function slots(people, sprints, unplaced = true) {
  const out = unplaced ? [null] : [];
  for (const o of people) for (const s of sprints) out.push({ owner: o, sprint: s });
  return out;
}
export const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// Multiset compare helper: sorted list of strings.
export const bag = (xs) => xs.slice().sort();
