// git merge driver entry: plangraph-merge %O %A %B %P. Plain JavaScript like entry.js: the floor check runs before any .ts or node:sqlite load.
// Too-old Node: exit 2 (the merge driver's "unreadable input" code, so git keeps the file unmerged) with the floor message and a try line.
// Exit codes otherwise come from runMerge in src/merge-main.ts: 0 clean, 1 conflicts, 2 unreadable input.
import { nodeSupported, floorMessage, floorTry } from './floor.js';

if (!nodeSupported(process.versions.node)) {
  process.stderr.write(`${floorMessage(process.version)}\n${floorTry}\n`);
  process.exitCode = 2;
} else {
  const { runMerge } = await import('./merge-main.ts');
  process.exitCode = runMerge(process.argv.slice(2), { err: (l) => process.stderr.write(`${l}\n`) });
}
