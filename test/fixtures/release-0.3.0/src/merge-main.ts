// git merge driver for the plangraph JSONL files: plangraph-merge %O %A %B %P  (base, ours = result, theirs, repo path).
// Writes the merged text to %A. Exit 0 = clean; 1 = conflicts (markers left in the file, keys listed on stderr); 2 = unreadable input.
import path from 'node:path';
import { mergeJsonl } from '../lib/merge.ts';
import { schemaFor, writeAtomic } from '../lib/store.ts';
import { oneLine } from '../lib/sanitize.ts';
import { readCapped } from '../lib/jsonl.ts';

/** Run the merge driver on the arguments after the script name; returns the exit code (0 clean, 1 conflicts, 2 unreadable input). */
export function runMerge(argv: readonly string[], io: { err(line: string): void }): number {
  const [O, A, B, P] = argv;
  if (!O || !A || !B) { io.err('usage: plangraph-merge BASE OURS THEIRS [PATH]'); return 2; }
  // capped (64 MiB, plangraph's data cap) and regular files only: a FIFO or device cannot block or flood the merge
  const rd = (f: string) => readCapped(f, 64 * 1024 * 1024);
  try {
    const name = P || A;
    const { text, conflicts } = mergeJsonl({ base: rd(O), ours: rd(A), theirs: rd(B) }, schemaFor(name), { name: path.basename(name) });
    writeAtomic(A, text);
    if (conflicts.length) {
      // keys, the path and details come from the merged data and git: one sanitized line each (no escape sequence, no forged line)
      io.err(`plangraph-merge: ${conflicts.length} conflict(s) in ${oneLine(name, 200)}; resolve the marked lines, then git add:\n` + conflicts.slice(0, 20).map((c) => `  ${oneLine(c.key, 200)}: ${oneLine(c.detail, 200)}`).join('\n') + (conflicts.length > 20 ? `\n  ... ${conflicts.length - 20} more` : ''));
      return 1;
    }
    // a clean text merge of the plan's placement or links can still break a rule (a handoff, a capacity): say so, by fixed name only
    const plan = ['schedule.jsonl', 'edges.jsonl'].find((f) => path.basename(name) === f);
    if (plan) io.err(`plangraph-merge: ${plan} merged cleanly, but a text merge can still break a handoff or capacity rule: run \`plangraph build\` then \`plangraph check\``);
    return 0;
  } catch (e) {
    // anything thrown (an Error, or a value that is not one): the message is read defensively and sanitized
    io.err(`plangraph-merge: ${oneLine((e as Error)?.message, 300)}`);
    return 2;
  }
}
