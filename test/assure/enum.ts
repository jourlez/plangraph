// Exhaustive enumerators for the small-scope suite. No randomness: every function walks a full Cartesian product in a fixed order.
// Level: 'full' (npm run assure) or 'quick' (the default node --test run). Each family states its bounds in BOUNDS so the report can
// print exactly what was enumerated.

export type Level = 'quick' | 'full';
export const level = (): Level => (process.env.ASSURE_LEVEL === 'quick' ? 'quick' : 'full');
export const PEOPLE = ['Ana', 'Ben', 'Cleo'];
export const keysOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `T${i + 1}`);

// Call fn(choice) for every element of the product of the given arrays (a choice is a fresh array, index-aligned with `dims`).
// tuple-preserving: product([[1, 2], ['a']], ([n, s]) => ...) types n as number and s as string
export type Choice<D> = { [K in keyof D]: D[K] extends Array<infer E> ? E : never };
export function product<D extends unknown[][] | [unknown[]]>(dims: D, fn: (choice: Choice<D>) => void): void {
  const n = dims.length, idx = new Array(n).fill(0);
  if (dims.some((d) => d.length === 0)) return;
  for (;;) {
    fn(idx.map((i, j) => dims[j][i]) as Choice<D>); // one element per dimension, in order
    let j = n - 1;
    while (j >= 0 && ++idx[j] === dims[j].length) { idx[j] = 0; j--; }
    if (j < 0) return;
  }
}
// Every subset of a list (as arrays, in binary-counter order).
export function subsets<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let m = 0; m < 1 << list.length; m++) out.push(list.filter((_, i) => m & (1 << i)));
  return out;
}
// Every directed graph over `keys` with self-links (every subset of the n*n ordered pairs), as [[consumer, producer]].
export function allGraphs(keys: string[]): Array<Array<[string, string]>> {
  const pairs: Array<[string, string]> = [];
  for (const c of keys) for (const p of keys) pairs.push([c, p]);
  return subsets(pairs);
}
// Every placement of one ticket: unplaced (null) or owner x sprint.
export interface Slot { owner: string; sprint: number }
export function slots(people: string[], sprints: number[], unplaced: false): Slot[];
export function slots(people: string[], sprints: number[], unplaced?: boolean): Array<Slot | null>;
export function slots(people: string[], sprints: number[], unplaced = true): Array<Slot | null> {
  const out: Array<Slot | null> = unplaced ? [null] : [];
  for (const o of people) for (const s of sprints) out.push({ owner: o, sprint: s });
  return out;
}
export const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// Multiset compare helper: sorted list of strings.
export const bag = (xs: string[]): string[] => xs.slice().sort();
