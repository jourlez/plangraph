// Integrity checks for the batch files (events, runs, schedules): UNSORTED_BATCH, MISSING_CURRENT, plus CONFLICT_MARKERS and BAD_LINE for
// the lines of those files. The controller merges this list into checkStore (lib/store2/check.ts); StoreViolation is structurally identical
// to the one there. `path` is relative to the plan directory.
import path from 'node:path';
import { readDataCapped } from '../jsonl.ts';
import { eventFiles, runFiles, runKinds, scheduleVersions, type BatchFile } from './batches.ts';

export interface StoreViolation { code: string; path: string; line: number | null; fix: string }

const MARK = /^(<<<<<<<|=======|>>>>>>>)/;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function lineProblems(f: BatchFile, root: string, out: StoreViolation[]): void {
  if (f.bad.length) {
    let text = ''; try { text = readDataCapped(path.join(root, f.rel), 64 << 20); } catch { /* reported below as unreadable */ }
    const src = text.split('\n');
    const marker = f.bad.find((n) => MARK.test(src[n - 1] ?? ''));
    if (marker !== undefined) out.push({ code: 'CONFLICT_MARKERS', path: f.rel, line: marker, fix: 'resolve the merge conflict by hand: keep every line of both sides, then run plangraph check' });
    const other = f.bad.find((n) => !MARK.test(src[n - 1] ?? ''));
    if (other !== undefined) out.push({ code: 'BAD_LINE', path: f.rel, line: other, fix: 'delete or repair the line: every line of a batch file is one JSON object of at most 1 MiB' });
  }
}

/** Violations of the batch files under `root` (the plan directory), sorted by path then code. Never throws on content. */
export function checkBatches(root: string): StoreViolation[] {
  const out: StoreViolation[] = [];
  for (const f of eventFiles(root)) {
    lineProblems(f, root, out);
    let prev: [string, number] | null = null;
    for (const { row, line } of f.rows) {
      if (typeof row.at !== 'string' || !Number.isInteger(row.seq)) continue;
      const cur: [string, number] = [row.at, row.seq as number];
      if (prev && (cmp(cur[0], prev[0]) || cur[1] - prev[1]) < 0) { out.push({ code: 'UNSORTED_BATCH', path: f.rel, line, fix: 'sort the lines by (at, seq) or delete the file and re-append the events' }); break; }
      prev = cur;
    }
  }
  for (const kind of runKinds(root)) for (const f of runFiles(root, kind)) {
    lineProblems(f, root, out);
    for (let i = 1; i < f.rows.length; i++) {
      if (cmp((f.rows[i - 1] as { raw: string }).raw, (f.rows[i] as { raw: string }).raw) > 0) { out.push({ code: 'UNSORTED_BATCH', path: f.rel, line: (f.rows[i] as { line: number }).line, fix: 'sort the lines (plangraph compact rewrites a sealed month in order)' }); break; }
    }
  }
  const versions = scheduleVersions(root);
  for (const v of versions) { // an immutable version file: every line one JSON object
    const rel = `schedules/${v}.jsonl`;
    let text = ''; try { text = readDataCapped(path.join(root, rel), 64 << 20); } catch { out.push({ code: 'BAD_LINE', path: rel, line: 1, fix: 'the file is not a readable regular file: replace it with the version from git' }); continue; }
    const src = text.split('\n'), mark = src.findIndex((l) => MARK.test(l));
    const bad = src.findIndex((l) => { if (l.trim() === '') return false; try { const o = JSON.parse(l); return o === null || typeof o !== 'object' || Array.isArray(o); } catch { return true; } });
    if (mark >= 0) out.push({ code: 'CONFLICT_MARKERS', path: rel, line: mark + 1, fix: 'resolve the merge conflict by hand: keep every line of both sides, then run plangraph check' });
    else if (bad >= 0) out.push({ code: 'BAD_LINE', path: rel, line: bad + 1, fix: 'delete or repair the line: every line of a schedule version is one JSON object' });
  }
  const cur = 'schedules/CURRENT';
  let text: string | null = null;
  try { text = readDataCapped(path.join(root, cur), 4096); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') text = ''; } // whatever was thrown: read its code
  if (text !== null && text.split('\n').some((l) => MARK.test(l))) {
    out.push({ code: 'CONFLICT_MARKERS', path: cur, line: text.split('\n').findIndex((l) => MARK.test(l)) + 1, fix: 'keep one version name in schedules/CURRENT and delete the conflict lines' });
  } else if (text === null ? versions.length > 0 : !versions.includes(text.trim())) {
    out.push({ code: 'MISSING_CURRENT', path: cur, line: null, fix: text === null ? 'run plangraph schedule use <version> (or write one version name into schedules/CURRENT)' : 'schedules/CURRENT must name an existing schedules/<version>.jsonl' });
  }
  return out.sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code));
}
