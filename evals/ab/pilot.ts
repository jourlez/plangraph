// Pilot driver (LIVE; refuses without EVAL_LIVE=1). One run of each selected graph question in both arms and of two coding tasks in both arms.
//   EVAL_LIVE=1 node evals/ab/pilot.ts select                  print the selected questions
//   EVAL_LIVE=1 node evals/ab/pilot.ts probe OUT ID...         clone and set up each coding task once and print the setup seconds
//   EVAL_LIVE=1 node evals/ab/pilot.ts graph OUT [MODEL]       24 runs; appends one JSON line per run to OUT/graph.jsonl (reply scrubbed to a hash-free 80 characters)
//   EVAL_LIVE=1 ANTHROPIC_API_KEY=... node evals/ab/pilot.ts tokens FILE...   measured characters per token of the files (countTokens)
//   EVAL_LIVE=1 node evals/ab/pilot.ts coding OUT ID ID        2 tasks x 2 arms; appends to OUT/coding.jsonl
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graphQuestions } from './questions.ts';
import type { GraphQuestion, Kind, Topic } from './questions.ts';
import { buildBaselineProject, buildGraphProject } from './graph.ts';
import { loadCodingTasks, prepareWorkspace, runClaude, runCodingCell, countTokens, requireLive, grade } from './run.ts';

const TOPICS: Topic[] = ['owner', 'blocker', 'stack', 'requirement', 'history'];
/** Two questions per topic (different kinds, the one at position 5 of each kind), plus two multi-hop or list questions: 12. */
export function pilotQuestions(): GraphQuestion[] {
  const all = graphQuestions(), pick = (k: Kind): GraphQuestion => { const of = all.filter((q) => q.kind === k); return of[5 % of.length] as GraphQuestion; };
  const kinds = (t: Topic): Kind[] => [...new Set(all.filter((q) => q.topic === t).map((q) => q.kind))].slice(0, 2);
  return [...TOPICS.flatMap((t) => kinds(t).map(pick)), ...(['downstream', 'implements'] as Kind[]).map((k) => { const of = all.filter((q) => q.kind === k); return of[7 % of.length] as GraphQuestion; })];
}

const scrub = (s: string): string => s.replaceAll(os.homedir(), '~').replace(/\s+/g, ' ').slice(0, 80);
const [cmd, out, ...rest] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'select') for (const q of pilotQuestions()) console.log(q.topic, q.kind, q.id, '|', q.text, '|', q.answer);
  else if (cmd === 'tokens') console.log(await countTokens([out, ...rest].map((f) => fs.readFileSync(f as string, 'utf8'))));
  else {
    requireLive();
    const o = out as string;
    fs.mkdirSync(o, { recursive: true });
    const log = (f: string, row: object): void => { fs.appendFileSync(path.join(o, f), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-'));
    if (cmd === 'graph') {
      const model = rest[0] ?? 'sonnet', base = path.join(ws, 'baseline'), graph = path.join(ws, 'graph');
      buildBaselineProject(base); buildGraphProject(graph);
      for (const q of pilotQuestions()) for (const arm of ['baseline', 'graph']) {
        const d = runClaude({ arm, model, repeat: 0 }, `${q.text} Answer with the value only, lists comma separated.`, arm === 'baseline' ? base : graph);
        log('graph.jsonl', { arm, model, id: q.id, topic: q.topic, correct: d.error === null && grade(q, d.reply), firstIn: d.firstIn, tokensIn: d.tokensIn, tokensOut: d.tokensOut, cost: d.cost, toolCalls: d.toolCalls, turns: d.calls, ms: d.ms, error: d.error, reply: scrub(d.reply), want: q.answer });
      }
    } else if (cmd === 'probe') {
      for (const id of rest) { const t = loadCodingTasks().find((x) => x.id === id); if (!t) throw new Error(id); const dir = path.join(ws, id), t0 = Date.now(); try { prepareWorkspace(t, dir); console.log(id, 'setup s', ((Date.now() - t0) / 1000).toFixed(1)); } catch (e) { console.log(id, 'FAILED', scrub(String((e as Error).message))); } }
    } else if (cmd === 'coding') {
      for (const id of rest) for (const arm of ['plugin-off', 'plugin-default']) {
        const t = loadCodingTasks().find((x) => x.id === id); if (!t) throw new Error(id);
        const dir = path.join(ws, `${id}-${arm}`), t0 = Date.now();
        try { prepareWorkspace(t, dir); } catch (e) { log('coding.jsonl', { arm, id, error: `setup: ${scrub(String((e as Error).message))}` }); continue; }
        const setupMs = Date.now() - t0;
        try { const d = runCodingCell({ arm, model: 'sonnet', repeat: 0 }, t, dir); log('coding.jsonl', { arm, model: 'sonnet', id, correct: d.correct, firstIn: d.firstIn, tokensIn: d.tokensIn, tokensOut: d.tokensOut, cost: d.cost, toolCalls: d.toolCalls, turns: d.calls, ms: d.ms, setupMs, error: d.error }); } catch (e) { log('coding.jsonl', { arm, id, error: scrub(String((e as Error).message)) }); }
      }
    }
    if (process.env.PILOT_KEEP !== '1') fs.rmSync(ws, { recursive: true, force: true });
  }
}
