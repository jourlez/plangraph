// Type check (dev only; needs the devDependency `typescript`, installed with `npm ci`). Runs tsc twice:
//   tsconfig.json       every .ts file (strict, noImplicitAny, exactOptionalPropertyTypes)
//   tsconfig.prod.json  lib, src and mcp, adding noUncheckedIndexedAccess
// and prints every error. Exit 1 when either run reports an error, 2 when tsc cannot run or was killed, else 0.
// Usage: npm run typecheck   (node scripts/typecheck.ts)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_OUTPUT = 1 << 26; // 64 MiB of tsc output is far beyond any real run
const LINE = /^([^\s(][^(]*)\(\d+,\d+\): error TS\d+:/;
const GLOBAL = /^error TS\d+:/; // a config or option error has no file position
const CONFIGS = ['tsconfig.json', 'tsconfig.prod.json'];

/** Errors per file from tsc's plain-text output; an error without a file position counts under '(tsc)'. */
export function parseTsc(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of String(text).split('\n')) {
    const m = LINE.exec(line), key = m ? m[1].split(path.sep).join('/') : GLOBAL.test(line) ? '(tsc)' : null;
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** What spawnSync reported for one tsc run (the fields this script reads). */
export interface SpawnOutcome { status: number | null; signal: string | null; error?: (Error & { code?: string }) | undefined; stdout: string | null; stderr: string | null }
/** Result of one tsc run: its exit status and output, `killed` (a signal or the timeout ended it: rerun), or `missing` (it could not start). */
export type TscRun = { kind: 'ran'; status: number; out: string } | { kind: 'killed'; why: string } | { kind: 'missing' };

/** Decide what a finished spawn means; pure, so the killed case is testable without running tsc. */
export function classifySpawn(r: SpawnOutcome): TscRun {
  if (r.error?.code === 'ETIMEDOUT') return { kind: 'killed', why: 'timeout' };
  if (r.error) return { kind: 'missing' };
  if (r.status === null) return r.signal ? { kind: 'killed', why: `signal ${r.signal}` } : { kind: 'missing' };
  if (r.status !== 0 && r.status !== 1 && r.status !== 2) return { kind: 'missing' };
  return { kind: 'ran', status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function runTsc(config: string): TscRun {
  const tsc = path.join(ROOT, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(tsc)) return { kind: 'missing' };
  return classifySpawn(spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', config], { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: 600000 }));
}

function main(): number {
  let failed = false;
  for (const config of CONFIGS) {
    const r = runTsc(config);
    if (r.kind === 'killed') { console.error(`typecheck: tsc was killed (${r.why}): rerun it`); return 2; }
    if (r.kind === 'missing') { console.error('typecheck: tsc did not run (install the dev dependencies with `npm ci`)'); return 2; }
    const total = [...parseTsc(r.out).values()].reduce((a, b) => a + b, 0);
    if (total > 0 || r.status !== 0) { console.error(r.out.trim()); failed = true; } // a non-zero exit fails even when no line parsed
    console.log(`typecheck: ${config}: ${total} error(s)`);
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
