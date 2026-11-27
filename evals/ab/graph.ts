// Workspaces for the two graph arms, built from the synthetic project. Local only: no model, no network.
// graph arm: a committed `.plangraph/` (owner, sprint and blocked-by edges as fields; stack, requirement and history facts in the ticket summary,
// the only free text `plangraph ticket -v` prints). baseline arm: only plan.md (planMarkdown()), so neither arm can read the other's source.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { adoptOldLayout } from '../../lib/store2/adopt.ts';
import { PROJECT, planMarkdown } from './project.ts';

const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const num = (s: string): number => Number(s.replace(/\D/g, ''));

/** The baseline-arm workspace: plan.md only. */
export function buildBaselineProject(ws: string): void {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'plan.md'), planMarkdown());
}

/** Write the graph-arm workspace into `ws`: a committed `.plangraph/` and a built index. `bin` is the plangraph executable (default: this repository's). */
export function buildGraphProject(ws: string, bin = path.resolve(import.meta.dirname, '..', '..', 'bin', 'plangraph')): void {
  const dir = path.join(ws, '.plangraph');
  fs.mkdirSync(dir, { recursive: true });
  const tickets = PROJECT.tickets.map((t) => {
    const owner = PROJECT.history.find((h) => h.ticket === t.key && h.field === 'owner'), done = PROJECT.history.find((h) => h.ticket === t.key && h.field === 'status');
    return { key: t.key, summary: [`stack=${PROJECT.stack[t.key]}`, `requirement=${PROJECT.requirement[t.key]}`, ...(owner ? [`previous_owner=${owner.from}`, `reassigned=${owner.at}`] : []), ...(done ? [`done=${done.at}`] : [])].join(' '), epic: t.epic, sp: 1, jira_status: done ? 'Done' : 'To Do', v2_owner: t.owner, v2_sprint: num(t.sprint), };
  });
  const edges = PROJECT.tickets.flatMap((t) => t.deps.map((d) => ({ consumer: t.key, producer: d, kind: 'plan_need', note: '' })));
  const schedule = PROJECT.tickets.map((t) => ({ version: 'current', key: t.key, owner: t.owner, sprint: num(t.sprint) }));
  fs.writeFileSync(path.join(dir, 'tickets.jsonl'), jsonl(tickets));
  fs.writeFileSync(path.join(dir, 'edges.jsonl'), jsonl(edges));
  fs.writeFileSync(path.join(dir, 'schedule.jsonl'), jsonl(schedule));
  fs.writeFileSync(path.join(dir, 'people.jsonl'), jsonl(PROJECT.people.map((p) => ({ id: p, name: p, active: true }))));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ first_sprint: 1, end_sprint: PROJECT.sprints.length, caps: { default: 1000 }, min_per_sprint: {}, ignore_link_kinds: [], weights: { shortfall: 10000, load: 2, owner_change: 1 } }) + '\n');
  fs.writeFileSync(path.join(dir, 'format.json'), '{"format_version":1,"min_reader":1}\n');
  adoptOldLayout(dir);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\nplangraph.sqlite*\n.txn/\n');
  const run = (cmd: string, args: string[]): void => { const p = spawnSync(cmd, args, { cwd: ws, encoding: 'utf8' }); if (p.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0]} failed: ${p.stderr.slice(0, 200)}`); };
  run('git', ['init', '-q']); run('git', ['add', '-A']);
  run('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'plan']);
  run(process.execPath, [bin, 'build']);
}
