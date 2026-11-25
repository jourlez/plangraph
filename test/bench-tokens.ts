#!/usr/bin/env node
// Reproducible token benchmark: brain CLI answers vs. what an agent would otherwise read from the raw files.
//   node test/bench-tokens.ts [--dir SCRATCH] [--no-write | --check]
// --check compares the block with docs/TOKENS.md and exits 1 on drift without writing (used by test/packaging.test.ts).
// Generates a synthetic plan (1400 tickets, 4 people, ~10k links, ~1.6 evidence rows per ticket, ~3k chars of plan text per ticket),
// runs `bin/brain build` on it, then for a FIXED list of questions records the CLI answer, a grep baseline (only the matching lines,
// with file:line: prefixes, the generous baseline) and a file baseline (cat of the whole files needed).
// Each CLI answer is checked against a ground truth computed straight from the JSONL with an independent JS implementation.
// Reported per answer: bytes (exact, the source of truth) and `est tok` = ceil(chars/4 x factor), factor from
// test/token-calibration.json (1.0, UNVERIFIED until the owner runs count_tokens against the current tokenizer). Exit code 1 if any
// answer is wrong. The result table is written into docs/TOKENS.md between markers. Importing this file runs nothing (reportBlock is
// exported for test/contract.test.ts).
// Limits: synthetic data; the CLI as it is at run time (whatever bin/brain prints now); no MCP or competitor measured.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { genPlan, rng } from './fixtures/gen.ts';
import { loadModel, capOf } from '../lib/model.ts';
import type { Ticket } from '../lib/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CALIBRATION = path.join(ROOT, 'test/token-calibration.json');
const SCRATCH = path.resolve(argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : path.join(os.tmpdir(), 'plangraph-bench'));
const BRAIN = path.join(SCRATCH, 'brain');
const lt = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- 1. generate ----------
const WORDS = 'the service must validate input before storing records and report failures to the caller while keeping an audit trail for every change made by an operator in the admin panel using the shared queue worker retry policy and idempotent handlers'.split(' ');
function sentence(r: () => number, chars: number): string { let s = ''; while (s.length < chars) s += WORDS[Math.floor(r() * WORDS.length)] + ' '; return s.slice(0, chars - 1).trimEnd() + '.'; }
function generate() {
  fs.rmSync(SCRATCH, { recursive: true, force: true }); fs.mkdirSync(path.join(BRAIN), { recursive: true }); fs.mkdirSync(path.join(SCRATCH, 'plan'), { recursive: true });
  const p = genPlan({ n: 1400, people: 4, density: 0.181, seed: 7, cap: 1000, maxSp: 5 });
  const r = rng(99); const last = Math.max(...p.schedule.map((s) => s.sprint));
  const load = new Map<string, number>(); for (const s of p.schedule) { const t = p.tickets.find((x) => x.key === s.key); load.set(s.owner + '|' + s.sprint, (load.get(s.owner + '|' + s.sprint) || 0) + (t as { sp: number }).sp); } // every scheduled key is a ticket of the plan
  const sorted = [...load.values()].sort((a, b) => a - b); p.config.caps.default = sorted[Math.floor(sorted.length * 0.9)]; // ~10% of person-sprints over cap
  const evidence: Array<{ key: string; source: string; [extra: string]: unknown }> = [], findings: Array<{ key: string; kind: string; text: string }> = [], plan: string[] = [];
  const kinds = ['missing_ac', 'owner_unclear', 'scope_gap', 'needs_design', 'stale_spec'];
  for (const t of p.tickets) {
    const bad = r() < 0.15; t.verdict = bad ? ['NEEDS_INFO', 'BLOCKED', 'NEEDS_DESIGN'][Math.floor(r() * 3)] : 'READY'; t.first_verdict = r() < 0.7 ? t.verdict : 'READY';
    t.jira_status = (t.v2_sprint as number /* generated rows carry v2_sprint */) <= Math.floor(last * 0.4) ? 'Done' : 'To Do';
    t.summary = `${['Add', 'Fix', 'Wire', 'Split', 'Document'][Math.floor(r() * 5)]} ${sentence(r, 40 + Math.floor(r() * 30)).replace(/\.$/, '')}`;
    for (let i = 0, c = r() < 0.6 ? 2 : 1; i < c; i++) evidence.push({ key: t.key, source: ['audit', 'reverify'][i], verdict: i === c - 1 ? t.verdict : t.first_verdict, resolution: sentence(r, 300), needs: bad ? sentence(r, 60) : '' });
    if (r() < 0.1) findings.push({ key: t.key, kind: kinds[Math.floor(r() * kinds.length)], text: sentence(r, 120) });
    plan.push(`## Task ${t.key}: ${t.summary}\n\n${sentence(r, 1000)}\n\n- ${sentence(r, 200)}\n- ${sentence(r, 200)}\n\n${sentence(r, 1500)}\n`);
  }
  const w = (n: string, rows: object[]) => fs.writeFileSync(path.join(BRAIN, n), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  w('tickets.jsonl', p.tickets.slice().sort((a, b) => lt(a.key, b.key))); w('edges.jsonl', p.edges.slice().sort((a, b) => lt(a.consumer, b.consumer) || lt(a.producer, b.producer)));
  w('schedule.jsonl', p.schedule.slice().sort((a, b) => lt(a.key, b.key))); w('evidence.jsonl', evidence.sort((a, b) => lt(a.key, b.key) || lt(a.source, b.source)));
  w('findings.jsonl', findings.sort((a, b) => lt(a.key, b.key) || lt(a.kind, b.kind) || lt(a.text, b.text)));
  fs.writeFileSync(path.join(BRAIN, 'config.json'), JSON.stringify(p.config) + '\n'); fs.writeFileSync(path.join(SCRATCH, 'plan', 'plan.md'), plan.join('\n'));
}
// a private plugin data directory in the scratch dir: bin/brain's compile cache never goes to the real HOME
const run = (args: string[]) => {
  const o = spawnSync(process.execPath, [path.join(ROOT, 'bin/brain'), ...args], { cwd: SCRATCH, env: { ...process.env, PLANGRAPH_DIR: path.relative(SCRATCH, BRAIN), CLAUDE_PLUGIN_DATA: path.join(SCRATCH, '.plugin-data') }, encoding: 'utf8', timeout: 120000 });
  return { out: ((o.stdout || '') + (o.stderr || '')).replace(/\n+$/, ''), code: o.status };
};
function main() {
  const calibration = loadCalibration();
  generate();
  const built = run(['build']); if (built.code !== 0) { console.error('build failed:\n' + built.out); process.exit(2); }

  // ---------- 2. ground truth (independent of the CLI and SQLite) ----------
  const m = loadModel(BRAIN);
  const sp = (k: string) => (m.tickets.get(k) as { sp: number }).sp, own = (k: string) => (m.sched.get(k) as { owner: string }).owner, spr = (k: string) => (m.sched.get(k) as { sprint: number }).sprint; // every key asked for is a ticket of the generated plan
  const LAST = Math.max(...[...m.sched.values()].map((s) => s.sprint as number)); // the generated schedule rows all carry a sprint
  const people = [...new Set([...m.sched.values()].map((s) => s.owner as string))].sort(lt);
  const sprintLoad = (n: number) => { const o: Record<string, number> = {}; for (const [k, s] of m.sched) if (s.sprint === n) o[s.owner as string] = (o[s.owner as string] || 0) + sp(k); return o; }; // owner is set on every generated row
  const personTotal = (p: string) => [...m.sched].filter(([, s]) => s.owner === p).reduce((a, [k]) => a + sp(k), 0);
  const overCap = () => { const l = new Map<string, number>(); for (const [k, s] of m.sched) l.set(s.owner + '|' + s.sprint, (l.get(s.owner + '|' + s.sprint) || 0) + sp(k)); return [...l].filter(([id, v]) => v > capOf(m.config, id.split('|')[0])).length; };
  const reach = (start: string, map: Map<string, string[]>, depth: number) => { const seen = new Set([start]); let f = [start]; for (let d = 0; d < depth; d++) { const nx: string[] = []; for (const k of f) for (const x of map.get(k) || []) if (!seen.has(x)) { seen.add(x); nx.push(x); } f = nx; } seen.delete(start); return seen; };
  const hopsMemo = new Map<string, number>(); const hops = (k: string): number => { if (hopsMemo.has(k)) return hopsMemo.get(k) as number; // has() was just tested
    let h = 0; for (const p of m.prods.get(k) || []) h = Math.max(h, hops(p) + 1); hopsMemo.set(k, h); return h; };

  // keys: K1 mid-plan with producers and consumers, K2 late (long chain), K3 early (many consumers)
  const K1 = 'T-700', K2 = 'T-1200', K3 = 'T-20';
  const S_MID = Math.floor(LAST / 2), S_ALT = Math.max(1, Math.floor(LAST * 0.8));
  const FILE = { t: 'tickets.jsonl', e: 'edges.jsonl', s: 'schedule.jsonl', v: 'evidence.jsonl', f: 'findings.jsonl', c: 'config.json' };
  const has = (...res: RegExp[]) => (out: string) => res.every((re) => re.test(out));
  const keysIn = (keys: string[]) => (out: string) => keys.every((k) => new RegExp(`\\b${k}\\b`).test(out));
  const q = (id: number, text: string, args: string[], check: (out: string) => boolean, files: string[], grep: string[][]) => ({ id, text, args, check, files, grep });
  const eq = (key: string) => `"key":"${key}"`, cons = (key: string) => `"consumer":"${key}"`, prod = (key: string) => `"producer":"${key}"`;
  const incoming = (k: string) => m.prods.get(k) || [], outgoing = (k: string) => m.cons.get(k) || [];
  const kindOf = 'missing_ac'; const fk = m.findings.filter((f) => f.kind === kindOf).map((f) => f.key as string); // findings rows carry a string key
  const kindCount: Record<string, number> = {}; for (const f of m.findings) kindCount[f.kind as string] = (kindCount[f.kind as string] || 0) + 1; // and a string kind
  const nonReady = [...m.tickets.values()].filter((t) => t.verdict && t.verdict !== 'READY').map((t) => t.key);
  const notReady = (k: string) => ((m.tickets.get(k) as Ticket).verdict !== 'READY') || m.findings.some((f) => f.key === k) || incoming(k).some((p) => (m.tickets.get(p) as Ticket).jira_status !== 'Done');
  const prodGrep = (k: string) => [[FILE.t, `"key":"(${[k, ...incoming(k)].join('|')})"`], [FILE.e, cons(k)], [FILE.f, eq(k)]];

  const Q = [
    q(1, `Who owns ${K1} and in which sprint?`, ['ticket', K1], has(new RegExp(own(K1)), new RegExp(`S${spr(K1)}\\b`, 'i')), [FILE.s], [[FILE.s, eq(K1)]]),
    q(2, `What does ${K1} directly need?`, ['neighbors', K1, '1'], keysIn(incoming(K1)), [FILE.e], [[FILE.e, cons(K1)]]),
    q(3, `What directly depends on ${K3}?`, ['neighbors', K3, '1', '-v'], keysIn(outgoing(K3)), [FILE.e], [[FILE.e, prod(K3)]]),
    q(4, `Is ${K1} ready to start?`, ['ready', K1], has(notReady(K1) ? /NOT READY/i : /READY TO START/i), [FILE.t, FILE.e, FILE.f], prodGrep(K1)),
    q(5, `What is in sprint ${S_MID} (load per person)?`, ['sprint', String(S_MID)], (out) => Object.entries(sprintLoad(S_MID)).every(([o, v]) => new RegExp(`${o}\\D{0,12}\\b${v}\\b`).test(out)), [FILE.s, FILE.t], [[FILE.s, `"sprint":${S_MID}}`], [FILE.t, `"key":"(${[...m.sched].filter(([, s]) => s.sprint === S_MID).map(([k]) => k).join('|')})"`]]),
    q(6, `How many person-sprints are over capacity?`, ['check'], has(new RegExp(`over cap\\D{0,6}\\b${overCap()}\\b`)), [FILE.s, FILE.t, FILE.c], [[FILE.s, '.'], [FILE.t, '.'], [FILE.c, '.']]),
    q(7, `How many points in total is ${people[0]} planned?`, ['person', people[0]], has(new RegExp(`total\\D{0,3}\\b${personTotal(people[0])}\\b`)), [FILE.s, FILE.t], [[FILE.s, `"owner":"${people[0]}"`], [FILE.t, `"v2_owner":"${people[0]}"`]]),
    q(8, `Critical chain behind ${K2}: how many hops?`, ['chain', K2], has(new RegExp(`\\b${hops(K2)} hops`)), [FILE.e], [[FILE.e, cons(K2)]]),
    q(9, `Everything ${K2} needs within 3 levels (how many)?`, ['neighbors', K2, '3'], has(new RegExp(`needs \\(${reach(K2, m.prods, 3).size}\\)`)), [FILE.e], [[FILE.e, cons(K2)]]),
    q(10, `What kinds of findings are open (counts)?`, ['findings'], (out) => Object.entries(kindCount).every(([k, c]) => new RegExp(`${k}\\D{0,3}\\b${c}\\b`).test(out)), [FILE.f], [[FILE.f, '.']]),
    q(11, `Which tickets have a '${kindOf}' finding?`, ['findings', kindOf], keysIn(fk), [FILE.f], [[FILE.f, `"kind":"${kindOf}"`]]),
    q(12, `Which tickets are not READY?`, ['blockers'], keysIn(nonReady), [FILE.t], [[FILE.t, '"verdict":"(?!READY")']]),
    q(13, `Is the plan valid (counts, violations)?`, ['check'], has(new RegExp(`tickets ${m.tickets.size}\\b`), new RegExp(`links ${m.edges.length}\\b`), /violations 0\b/), [FILE.t, FILE.e, FILE.s, FILE.c], [[FILE.t, '.'], [FILE.e, '.'], [FILE.s, '.'], [FILE.c, '.']]),
    q(14, `Session start: what is the plan (size, last sprint)?`, ['card'], has(new RegExp(`\\b${m.tickets.size} tickets`), new RegExp(`\\b${m.edges.length} links`), new RegExp(`(?:\\b|S)${LAST}\\b`)), [FILE.t, FILE.e, FILE.s], [[FILE.t, '.'], [FILE.e, '.'], [FILE.s, '.']]),
    q(15, `Full picture of ${K2} (status, size, needs, evidence)?`, ['ticket', K2], has(new RegExp(`${sp(K2)} SP`), new RegExp((m.tickets.get(K2) as { verdict: string }).verdict), new RegExp(`${(m.tickets.get(K2) as Ticket).jira_status}`)), [FILE.t, FILE.s, FILE.e, FILE.f, FILE.v], [[FILE.t, eq(K2)], [FILE.s, eq(K2)], [FILE.e, `"(consumer|producer)":"${K2}"`], [FILE.f, eq(K2)], [FILE.v, eq(K2)]]),
    q(16, `How many tickets does ${K3} unblock within 2 levels?`, ['neighbors', K3, '2'], has(new RegExp(`needed by \\(${reach(K3, m.cons, 2).size}\\)`)), [FILE.e], [[FILE.e, prod(K3)]]),
    q(17, `Which is the last planned sprint?`, ['check'], has(new RegExp(`last sprint\\D{0,3}\\b${LAST}\\b`)), [FILE.s], [[FILE.s, '.']]),
    q(18, `Load per person in the last sprint (${LAST})?`, ['sprint', String(LAST)], (out) => Object.entries(sprintLoad(LAST)).every(([o, v]) => new RegExp(`${o}\\D{0,12}\\b${v}\\b`).test(out)), [FILE.s, FILE.t], [[FILE.s, `"sprint":${LAST}}`], [FILE.t, `"key":"(${[...m.sched].filter(([, s]) => s.sprint === LAST).map(([k]) => k).join('|')})"`]]),
    q(19, `Who owns each producer of ${K2}, and when?`, ['neighbors', K2, '1'], (out) => incoming(K2).every((p) => new RegExp(`\\b${p}\\s+S${spr(p)}\\b`).test(out)), [FILE.e, FILE.s], [[FILE.e, cons(K2)], [FILE.s, `"key":"(${incoming(K2).join('|')})"`]]),
    q(20, `Critical chain behind ${K1}: how many hops?`, ['chain', K1], has(new RegExp(`\\b${hops(K1)} hops`)), [FILE.e], [[FILE.e, cons(K1)]]),
    q(21, `How many tickets need ${K3} (direct)?`, ['ticket', K3], has(new RegExp(`needed by\\D{0,3}\\b${outgoing(K3).length}\\b`)), [FILE.e, FILE.t, FILE.s], [[FILE.e, prod(K3)], [FILE.t, eq(K3)], [FILE.s, eq(K3)]]),
    q(22, `Is T-99999 in the plan?`, ['ticket', 'T-99999'], has(/not in the plan/i), [FILE.t], [[FILE.t, '"key":"T-99999"']]),
    q(23, `How many points in total is ${people[1]} planned?`, ['person', people[1]], has(new RegExp(`total\\D{0,3}\\b${personTotal(people[1])}\\b`)), [FILE.s, FILE.t], [[FILE.s, `"owner":"${people[1]}"`], [FILE.t, `"v2_owner":"${people[1]}"`]]),
    q(24, `Load per person in sprint ${S_ALT}?`, ['sprint', String(S_ALT)], (out) => Object.entries(sprintLoad(S_ALT)).every(([o, v]) => new RegExp(`${o}\\D{0,12}\\b${v}\\b`).test(out)), [FILE.s, FILE.t], [[FILE.s, `"sprint":${S_ALT}}`], [FILE.t, `"key":"(${[...m.sched].filter(([, s]) => s.sprint === S_ALT).map(([k]) => k).join('|')})"`]]),
  ];

  // ---------- 3. measure ----------
  const lines: Record<string, string[]> = {}; for (const f of Object.values(FILE)) lines[f] = fs.readFileSync(path.join(BRAIN, f), 'utf8').split('\n').filter(Boolean);
  const grepOut = (spec: string[][]) => spec.flatMap(([f, re]) => { const rx = new RegExp(re); return lines[f].map((l, i): [number, string] => [i, l]).filter(([, l]) => rx.test(l)).map(([i, l]) => `${f}:${i + 1}:${l}`); }).join('\n');
  const fileOut = (files: string[]) => [...new Set(files)].map((f) => lines[f].join('\n')).join('\n');
  const rows = Q.map((x) => { const r = run(x.args); return { ...x, out: r.out, grepOut: grepOut(x.grep), fileOut: fileOut(x.files), ok: !!x.check(r.out) }; });
  // Outputs with no ground-truth question: the per-session fixed overhead (the card the SessionStart hook prints) and self-description.
  const fixed = [['card (session start, printed once per session)', run(['card']).out], ['explain', run(['explain']).out], ['explain whatif', run(['explain', 'whatif']).out], [`ticket ${K2} -v`, run(['ticket', K2, '-v']).out]];
  const est = estimator(calibration);
  const shape = `plan: ${m.tickets.size} tickets, ${m.edges.length} links, ${m.evidence.length} evidence rows, ${m.findings.length} findings, last sprint ${LAST}, ${people.length} people; raw files: ${Object.values(FILE).map((f) => `${f} ${bytes(lines[f].join('\n'))} bytes ~${est(lines[f].join('\n'))} est tok`).join(', ')}; plan text ${bytes(fs.readFileSync(path.join(SCRATCH, 'plan/plan.md'), 'utf8'))} bytes (not used by any question: no CLI command answers from it)`;
  const block = reportBlock(rows, { calibration, shape, fixed });
  console.log(block);
  const wrong = rows.filter((r) => !r.ok);
  for (const r of wrong) console.error(`WRONG #${r.id} ${r.text}\n--- output (${r.args.join(' ')}):\n${r.out.slice(0, 600)}`);

  if (argv.includes('--check')) {
    const cur = fs.readFileSync(path.join(ROOT, 'docs/TOKENS.md'), 'utf8'), i = cur.indexOf('<!-- BENCH:START -->'), j = cur.indexOf('<!-- BENCH:END -->');
    const same = i >= 0 && j > i && cur.slice(i + '<!-- BENCH:START -->'.length, j) === '\n' + block + '\n';
    if (!same) console.error('docs/TOKENS.md is stale: run node test/bench-tokens.ts');
    process.exit(wrong.length || !same ? 1 : 0);
  }
  if (!argv.includes('--no-write')) {
    const doc = path.join(ROOT, 'docs/TOKENS.md'), A = '<!-- BENCH:START -->', B = '<!-- BENCH:END -->';
    const cur = fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : `# Token cost of planning answers\n\n${A}\n${B}\n`;
    const i = cur.indexOf(A), j = cur.indexOf(B);
    if (i < 0 || j < i) { console.error('docs/TOKENS.md has no BENCH markers'); process.exit(2); }
    fs.writeFileSync(doc, cur.slice(0, i + A.length) + '\n' + block + '\n' + cur.slice(j));
  }
  process.exit(wrong.length ? 1 : 0);
}

// ---------- report (pure) ----------
const bytes = (s: unknown) => Buffer.byteLength(String(s), 'utf8');
/** est tok = ceil(chars / 4 x factor). The factor must be a finite number in (0, 10]; anything else is refused. */
export interface Calibration { factor?: unknown; verified?: unknown }
export function estimator(calibration: Calibration | null | undefined): (s: unknown) => number {
  const f = calibration?.factor;
  if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0 || f > 10) throw new Error('token-calibration.json: factor must be a number in (0, 10]');
  return (s: unknown) => Math.ceil((String(s).length / 4) * f);
}
/** Read and check test/token-calibration.json. */
export function loadCalibration(file = CALIBRATION): Calibration {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  estimator(c);
  return c;
}
const ratio = (a: number, b: number) => (b ? (a / b >= 10 ? Math.round(a / b) : (a / b).toFixed(1)) + 'x' : 'n/a');
/** The markdown block of the benchmark. rows: { id, text, out, grepOut, fileOut, ok }; fixed: [[label, text]]. Deterministic. */
export interface BenchRow { id: number; text: string; out: string; grepOut: string; fileOut: string; ok: boolean }
export function reportBlock(rows: BenchRow[], { calibration, shape, fixed = [] }: { calibration: Calibration; shape: string; fixed?: string[][] }): string {
  const est = estimator(calibration);
  const m = rows.map((r) => ({ ...r, cb: bytes(r.out), ct: est(r.out), gb: bytes(r.grepOut), gt: est(r.grepOut), fb: bytes(r.fileOut), ft: est(r.fileOut) }));
  const sum = (k: 'cb' | 'ct' | 'gb' | 'gt' | 'fb' | 'ft') => m.reduce((a, r) => a + r[k], 0);
  const md = ['| # | question | cli bytes | cli est tok | grep bytes | grep est tok | file bytes | file est tok | reduction vs grep | vs files | correct |', '|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|:-:|',
    ...m.map((r) => `| ${r.id} | ${r.text.replace(/\|/g, '/')} | ${r.cb} | ${r.ct} | ${r.gb} | ${r.gt} | ${r.fb} | ${r.ft} | ${ratio(r.gb, r.cb)} | ${ratio(r.fb, r.cb)} | ${r.ok ? 'yes' : 'NO'} |`),
    `| | **total (${m.length} questions)** | **${sum('cb')}** | **${sum('ct')}** | **${sum('gb')}** | **${sum('gt')}** | **${sum('fb')}** | **${sum('ft')}** | **${ratio(sum('gb'), sum('cb'))}** | **${ratio(sum('fb'), sum('cb'))}** | **${m.filter((r) => r.ok).length}/${m.length}** |`];
  const fx = fixed.length ? ['', '| output (no ground-truth check) | bytes | est tok |', '|---|--:|--:|', ...fixed.map(([label, text]) => `| ${String(label).replace(/\|/g, '/')} | ${bytes(text)} | ${est(text)} |`)] : [];
  const tokenizer = `Tokenizer: est tok is an estimate, ceil(chars/4) x calibration factor ${calibration.factor} (test/token-calibration.json, ${calibration.verified ? 'verified' : 'unverified'}): no count_tokens run yet against the current Claude tokenizer, which may count more tokens for this output than chars/4 (docs/research/ai-engineering.md 5.2). Bytes are exact; reductions are computed on bytes.`;
  return [tokenizer, '', md.join('\n'), ...fx, '', `Plan shape: ${shape}.`].join('\n');
}

if (import.meta.main) main();
