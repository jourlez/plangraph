// Per-file coverage floor over the lcov report the coverage run writes (coverage/lcov.info).
import path from 'node:path';

export const FLOOR = { lines: 90, branches: 85 };

export interface FileCoverage { file: string; lines: number; branches: number }

/** Percentage of `hit` in `found`; a file with nothing to count is fully covered. */
const pct = (hit: number, found: number): number => (found === 0 ? 100 : (hit / found) * 100);

/**
 * Files of `files` whose line or branch coverage in `lcov` is under the floor. A file absent from the report counts as 0 and 0, because Node's
 * report leaves out every file no test loads. Report paths may be absolute; they match on the path relative to the repo, as given in `files`.
 */
export function belowFloor(lcov: string, floor: { lines: number; branches: number }, files: readonly string[], root: string = process.cwd()): FileCoverage[] {
  const seen = new Map<string, FileCoverage>();
  for (const rec of lcov.split('end_of_record')) {
    const sf = /^SF:(.+)$/m.exec(rec)?.[1]?.trim();
    if (!sf) continue;
    const num = (key: string): number => Number(new RegExp(`^${key}:(\\d+)$`, 'm').exec(rec)?.[1] ?? 0);
    const rel = (path.isAbsolute(sf) ? path.relative(root, sf) : sf).split(path.sep).join('/');
    seen.set(rel, { file: rel, lines: pct(num('LH'), num('LF')), branches: pct(num('BRH'), num('BRF')) });
  }
  const out: FileCoverage[] = [];
  for (const file of files) {
    const c = seen.get(file) ?? { file, lines: 0, branches: 0 };
    if (c.lines < floor.lines || c.branches < floor.branches) out.push(c);
  }
  return out;
}

/** One printable line per failing file. */
export function formatBelowFloor(rows: readonly FileCoverage[], floor: { lines: number; branches: number }): string {
  const head = `per-file coverage floor (${floor.lines}% lines, ${floor.branches}% branches) failed for ${rows.length} file(s):`;
  return [head, ...rows.map((r) => `  ${r.file}  lines ${r.lines.toFixed(2)}  branches ${r.branches.toFixed(2)}`)].join('\n');
}
