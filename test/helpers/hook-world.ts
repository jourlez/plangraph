// A real temp git repository with a small generated plan, and a runner that calls src/cli.ts main() with the not-yet-registered hook commands added to a copy of the default registry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../../src/cli.ts';
import { makeContext } from '../../src/context.ts';
import { registry, defineCommand } from '../../src/registry.ts';
import { commands as refreshCmds } from '../../src/commands/refresh.ts';
import { commands as promptCmds } from '../../src/commands/hook-prompt.ts';
import { commands as githookCmds } from '../../src/commands/githooks-install.ts';
import { genPlan } from '../fixtures/gen.ts';
import { writePlanDir } from './plan-dir.ts';
import { adoptPlanDir } from './plan-dir.ts';
import type { RefreshDeps } from '../../src/commands/refresh.ts';

export const made: string[] = [];
export const cleanup = (): void => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); };
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
export const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
export const tmp = (): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkw-'))); made.push(d); return d; };

export const reg = new Map(registry);
for (const group of [refreshCmds, promptCmds, githookCmds]) for (const [n, spec] of Object.entries(group)) defineCommand(reg, n, spec);

/** A repository with a committed plan (ABC-1 .. ABC-6, ABC-3 needs ABC-2), the plan's .gitignore, and docs/plangraph/ ignored; no index yet. */
export function world(config: Record<string, unknown> = {}): { root: string; dir: string } {
  const root = tmp(), dir = path.join(root, '.plangraph');
  git(root, 'init', '-q', '-b', 'main');
  const p = genPlan({ n: 6, people: 2, seed: 4, prefix: 'ABC', density: 0 });
  p.edges.push({ consumer: 'ABC-3', producer: 'ABC-2', kind: 'plan_need', note: '' });
  p.tickets[1]!.jira_status = 'In Progress';
  writePlanDir(dir, p);
  fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify({ ...p.config, ...config }, null, 2)}\n`);
  adoptPlanDir(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\nplangraph.sqlite*\n.txn/\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'docs/plangraph/\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'plan');
  return { root, dir };
}

export interface Run { code: number | string; out: string[]; err: string[] }
export async function run(cwd: string, argv: string[], opts: { stdin?: string; deps?: RefreshDeps; env?: Record<string, string> } = {}): Promise<Run> {
  const out: string[] = [], err: string[] = [];
  const io = { out: (s: string) => out.push(...String(s).split('\n')), err: (s: string) => err.push(s), raw: (s: string) => out.push(...String(s).split('\n')) };
  const env = { PATH: process.env.PATH, HOME: cwd, LC_ALL: 'C', TZ: 'UTC', SOURCE_DATE_EPOCH: '1795305600', ...GIT_ENV, ...(opts.env ?? {}) };
  const wrap = (o: Parameters<typeof makeContext>[0]) => {
    const c = makeContext({ ...o, ...(opts.stdin !== undefined ? { stdin: { isTTY: false, read: () => opts.stdin as string } } : {}) });
    return (opts.deps ? Object.assign(Object.create(Object.getPrototypeOf(c)), c, { refreshDeps: opts.deps }) : c) as typeof c;
  };
  let code: number | string;
  try { code = await main(argv, { io, env, cwd, registry: reg, makeContext: wrap as never }); } catch (e) { code = `threw ${(e as Error).message}`; }
  return { code, out, err };
}
