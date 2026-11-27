// A fake ctx over a real plan directory for the flow, map and context command tests: db().all answers the index queries from the store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../lib/planstore.ts';
import type { Kind, Row } from '../../lib/planstore.ts';
import { genPlan } from '../fixtures/gen.ts';
import type { GenPlan } from '../fixtures/gen.ts';
import { writePlanDir, adoptPlanDir } from './plan-dir.ts';
import { exitCodeOf } from '../../src/errors.ts';

export const tmps: string[] = [];
export const cleanup = (): void => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); };
const TABLE: Record<string, Kind> = { ticket: 'ticket', edge: 'edge', schedule: 'schedule', finding: 'finding', evidence: 'evidence', learning: 'learning', capacity: 'capacity', sprint: 'sprint' };

export function flowFixture(opts: { plan?: GenPlan; n?: number; extras?: Partial<Record<Kind, readonly Row[]>>; git?: (...a: string[]) => string; obs?: object[] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-flow-'))); tmps.push(root);
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  const plan = opts.plan ?? genPlan({ n: opts.n ?? 4, people: 2, density: 0, seed: 3 });
  writePlanDir(dir, plan, opts.extras ?? {});
  adoptPlanDir(dir);
  const store = openStore({ dir, root });
  const out: string[] = [], err: string[] = [];
  const clock = { t: Date.parse('2026-11-26T10:00:00Z') };
  const ctx = { root, dir, flags: {}, env: {}, now: () => new Date(clock.t += 1000), config: () => plan.config, git: opts.git ?? ((): string => { throw new Error('no git'); }),
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(s), outBlock: (l: string[]) => out.push(...l), data: undefined },
    db: () => ({ older: false, stale: false, fingerprint: 'abcdef0123456789', all: (sql: string) => {
      const m = /FROM (\w+)/.exec(sql)?.[1] ?? '';
      if (m === 'obs') return opts.obs ?? [];
      return TABLE[m] ? store.readKind(TABLE[m] as Kind) : [];
    } }) } as never;
  return { ctx, root, dir, out, err, store, plan };
}
type Cmd = { run: (c: never, a: never) => unknown };
/** Runs a command; a thrown PlangraphError becomes its exit code, the message goes to err. */
export async function run(f: { ctx: never; err: string[] }, cmds: unknown, name: string, positionals: string[] = [], values: object = {}): Promise<number> {
  try { return ((await (cmds as Record<string, Cmd>)[name]!.run(f.ctx, { values, positionals } as never)) as number | undefined) ?? 0; }
  catch (e) { f.err.push(String((e as Error).message)); return exitCodeOf(e); }
}
