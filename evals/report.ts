#!/usr/bin/env node
// Summary of an eval run: arm A (WITH the plugin) versus arm B (bare Claude, no plugin), from the direct runner's results
// (evals/run-p.ts: results/run-p.json) or else the native aggregate-result.json files.
//   node evals/report.ts --suite <dir> [--json <file>]
// <dir> is a suite built by evals/run-p.ts (cases.json, results/run-p.json, one block per prompt style: natural is the headline) or by
// evals/run.ts (cases.json, pass-*/, results/<pass>/.../aggregate-result.json). Plugin use: an arm-A run counts as using the plugin only
// when a plangraph call ran (not denied, not "command not found"; a skill that fired without a working plangraph does not count, it is shown
// apart); the table shows that share per family, and the
// score of A is split into runs that used it and runs that did not, so a plugin arm that never touched the plugin is never read as
// plugin evidence. A plangraph call that ran in arm B is reported as a leak. Per family: pass rate, mean
// score, delta, mean turns, mean cost, mean tokens (from the run traces when they were kept: --keep-temp), plus injection resistance,
// no-write integrity, post-checked moves (the model's proposed move applied to a copy of the plan and re-verified by lib/verify.ts),
// trigger recall and false-fire rate (single-arm pass), and ablation variants. Prints ids, families and numbers only: never prompts,
// answers or ticket text (a real-project suite holds real data). Reads are bounded; writes only the --json file if asked.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCapped } from '../lib/jsonl.ts';
import { parseAnswer } from './schema.ts';
import type { EvalCase } from './schema.ts';
import { parseTrace, pluginUsed } from './trace.ts';
import { modelFromFiles, withOverlay, newViolations } from './families.ts';
import { verifyPlan } from '../lib/verify.ts';
import { applyMoves } from '../lib/whatif.ts';

const MAX = 64 << 20;
/** One run as the report reads it (collectRuns builds it from run-p.json records or from native aggregate files). */
export interface Run {
  pass: string; style: string; id: string; family: string; kind: string; tags: string[]; arm: string; score: number; passed: boolean; turns: number | null; cost: number | null;
  tokens: number | null; error: boolean; graders: Record<string, boolean>; post: boolean | null; used: boolean | null; skill: boolean | null; cardOnly?: boolean | null; brainInB: boolean;
}
// a record of results/run-p.json or of a native aggregate-result.json; the file is unchecked, the reads below are as lenient as they were
interface RawRun {
  id: string; style?: string; arm: string; score: number; passed?: unknown; turns: number | null; cost: number | null; costUsd: number | null; tokens?: number | null; error?: unknown; message?: unknown;
  graders?: Array<{ name: string; passed: boolean }>; plugin?: { skills: string[]; card?: unknown; toolCalls: number; brainRan: number }; pluginUsed?: unknown; tracePath?: string;
}
export interface Stat { n: number; pass: number; score: number; turns: number; cost: number; tokens: number; errors: number; used: number }
export interface Rate { k: number; n: number; rate: number; ci: number[] }
const mean = (a: Array<number | null>) => (a.length ? a.reduce((s: number, x) => s + (x as number), 0) / a.length : Number.NaN); // a null counts as 0, as it always did
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
export function wilson(k: number, n: number, z = 1.96): number[] { if (!n) return [Number.NaN, Number.NaN]; const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n)); return [(c - h) / d, (c + h) / d]; }
// Cluster bootstrap of the mean paired difference over cases (deterministic seed).
export function bootstrapDelta(pairs: number[], B = 2000, seed = 7): number[] {
  if (!pairs.length) return [Number.NaN, Number.NaN];
  let a = seed >>> 0; const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ds: number[] = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < pairs.length; i++) s += pairs[Math.floor(r() * pairs.length)]; ds.push(s / pairs.length); }
  ds.sort((x, y) => x - y);
  return [ds[Math.floor(0.025 * B)], ds[Math.floor(0.975 * B)]];
}

function findAggregates(dir: string, depth = 0, out: string[] = []): string[] {
  let ents: fs.Dirent[] = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === 'aggregate-result.json') out.push(p);
    else if (e.isDirectory() && !e.isSymbolicLink() && depth < 3) findAggregates(p, depth + 1, out);
  }
  return out;
}
// From a kept trace (stream-json): token usage and the final assistant text. Absent or unreadable -> nulls.
export function readTrace(p: string | undefined | null): { tokens: number | null; message: string | null } {
  let text: string; try { if (!p || !fs.lstatSync(p).isFile()) return { tokens: null, message: null }; text = readCapped(p, MAX); } catch { return { tokens: null, message: null }; }
  let res = null;
  for (const l of text.split('\n')) { if (!l.includes('"type":"result"')) continue; try { const j = JSON.parse(l); if (j && j.type === 'result') res = j; } catch { /* not a JSON line */ } }
  if (!res) return { tokens: null, message: null };
  const u = res.usage || {};
  const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((s, k) => s + (Number.isFinite(u[k]) ? u[k] : 0), 0);
  return { tokens, message: typeof res.result === 'string' ? res.result : null };
}

// Whether a kept native trace shows the plugin used (null when the trace is absent or unreadable).
export function traceUse(p: string | undefined | null) {
  let text: string; try { if (!p || !fs.lstatSync(p).isFile()) return null; text = readCapped(p, MAX); } catch { return null; }
  const t = parseTrace(text);
  return t.result || t.calls.length ? { used: pluginUsed(t.plugin), skill: t.plugin.skills.length > 0, brainInB: t.plugin.brainRan > 0 } : null;
}

// Apply the moves the model proposed (parsed from its ANSWER line) to a copy of the plan and re-verify: no new violation, the request met.
export function postcheck(c: EvalCase, message: string, fixtureFiles: Record<string, string>): boolean | null {
  const pc = c.truth && c.truth.postcheck;
  if (!pc) return null;
  const ans = parseAnswer(message);
  if (!ans) return false;
  const { m } = modelFromFiles(withOverlay(fixtureFiles, c.fixture.overlay).files);
  const moves = Array.isArray(ans.moves) ? ans.moves : [{ key: ans.key, to: ans.to, sprint: ans.sprint }];
  if (!moves.length || moves.length > 50) return false;
  const mv = [];
  for (const x of moves) {
    if (!x || typeof x.key !== 'string' || !m.sched.has(x.key) || typeof x.to !== 'string' || !Number.isInteger(x.sprint)) return false;
    const cur = m.sched.get(x.key);
    mv.push({ key: x.key, from: { ...cur }, to: { owner: x.to, sprint: x.sprint } });
  }
  const owners = new Set([...m.sched.values()].map((s) => s.owner));
  if (mv.some((x) => !owners.has(x.to.owner))) return false;
  const first = m.config.first_sprint ?? 1, end = m.config.end_sprint ?? Infinity;
  if (mv.some((x) => x.to.sprint < first || x.to.sprint > end)) return false;
  const before = verifyPlan(m), after = verifyPlan(m, applyMoves(m.sched, mv));
  if (newViolations(before, after).length) return false;
  if (pc.key && !mv.some((x) => x.key === pc.key && x.to.owner !== (pc.require && pc.require.notOwner))) return false;
  if (pc.clears && after.some((v) => v.code === 'CAPACITY' && v.key === pc.clears)) return false;
  return true;
}

const STYLE_ORDER = ['natural', 'layout-told'];
function collectRuns(suite: string, byId: Map<string, EvalCase>, fixtureOf: (c: EvalCase) => Record<string, string>): Run[] {
  const pFile = path.join(suite, 'results', 'run-p.json');
  if (fs.existsSync(pFile)) {
    let j: { records?: RawRun[] }; try { j = JSON.parse(readCapped(pFile, MAX)); } catch { j = { records: [] }; }
    return (j.records || []).filter((r) => byId.has(r.id)).map((r): Run => {
      const c = byId.get(r.id) as EvalCase; // filtered on has() above
      return { pass: 'headline', style: r.style || 'natural', id: c.id, family: c.family, kind: c.kind, tags: c.tags, arm: r.arm, score: r.score, passed: !!r.passed, turns: r.turns, cost: r.cost, tokens: r.tokens ?? null, error: !!r.error,
        graders: Object.fromEntries((r.graders || []).map((x) => [x.name, x.passed])), post: typeof r.message === 'string' ? postcheck(c, r.message, fixtureOf(c)) : null,
        used: r.arm === 'with' && r.plugin ? !!r.pluginUsed : null, skill: r.arm === 'with' && r.plugin ? r.plugin.skills.length > 0 : null, cardOnly: r.arm === 'with' && r.plugin ? !!r.plugin.card && r.plugin.toolCalls === 0 : null, brainInB: r.arm === 'without' && !!(r.plugin && r.plugin.brainRan > 0) };
    });
  }
  const runs: Run[] = [];
  for (const agg of findAggregates(path.join(suite, 'results'))) {
    let j: { cases?: Array<{ name: string; arms?: Record<string, RawRun[]> }> }; try { j = JSON.parse(readCapped(agg, MAX)); } catch { continue; }
    const pass = path.relative(path.join(suite, 'results'), agg).split(path.sep)[0];
    for (const cr of j.cases || []) {
      const c = byId.get(cr.name); if (!c) continue;
      for (const arm of ['with', 'without']) for (const r of (cr.arms && cr.arms[arm]) || []) {
        const tr = readTrace(r.tracePath), u = traceUse(r.tracePath);
        const g = Object.fromEntries((r.graders || []).map((x) => [x.name, x.passed]));
        runs.push({ pass, style: 'layout-told', id: c.id, family: c.family, kind: c.kind, tags: c.tags, arm, score: r.score, passed: !!r.passed, turns: r.turns, cost: r.costUsd, tokens: tr.tokens, error: !!r.error, graders: g,
          post: tr.message === null ? null : postcheck(c, tr.message, fixtureOf(c)), used: arm === 'with' && u ? u.used : null, skill: arm === 'with' && u ? u.skill : null, brainInB: arm === 'without' && !!(u && u.brainInB) });
      }
    }
  }
  return runs;
}

export function summarize(suite: string) {
  const cases = JSON.parse(readCapped(path.join(suite, 'cases.json'), MAX));
  const byId = new Map<string, EvalCase>(cases.map((c: EvalCase) => [c.id, c]));
  const fixtureCache = new Map<string, Record<string, string>>();
  const fixtureOf = (c: EvalCase): Record<string, string> => {
    if (fixtureCache.has(c.fixture.size)) return fixtureCache.get(c.fixture.size) as Record<string, string>; // has() above
    const f: Record<string, string> = {};
    for (const d of [path.join(suite, 'fixtures', c.fixture.size), path.join(suite, 'pass-headline', 'evals', 'fixtures', c.fixture.size)]) {
      try { for (const n of fs.readdirSync(d)) if (/\.jsonl$|^config\.json$/.test(n)) f[n] = readCapped(path.join(d, n), MAX); break; } catch { /* no fixture here */ }
    }
    fixtureCache.set(c.fixture.size, f); return f;
  };
  const runs = collectRuns(suite, byId, fixtureOf); // {pass, style, id, family, kind, tags, arm, score, passed, turns, cost, tokens, graders:{name: passed}, post, used, brainInB}
  const roleOf = (id: string, name: string) => ((byId.get(id) as EvalCase).graders.find((g) => g.id === name) || {} as { role?: string }).role; // ids come from byId's own cases
  const safeOk = (r: Run) => Object.entries(r.graders).filter(([n]) => roleOf(r.id, n) === 'safety').every(([, p]) => p);
  const stat = (rs: Run[]): Stat => {
    const u = rs.filter((r) => r.used !== null && r.used !== undefined);
    return { n: rs.length, pass: mean(rs.map((r) => (r.passed ? 1 : 0))), score: mean(rs.map((r) => r.score)), turns: mean(rs.map((r) => r.turns)), cost: mean(rs.map((r) => r.cost)), tokens: mean(rs.filter((r) => r.tokens !== null).map((r) => r.tokens)), errors: rs.filter((r) => r.error).length,
      used: u.length ? u.filter((r) => r.used).length / u.length : Number.NaN };
  };
  const rate = (rs: Run[], f: (r: Run) => unknown): Rate => { const n = rs.length, k = rs.filter(f).length; return { k, n, rate: n ? k / n : Number.NaN, ci: wilson(k, n) }; };
  const block = (head: Run[]) => {
    const groups = new Map<string, Run[]>(); for (const r of head) { const k = r.family.replace(/-(?:yes|no)$/, ''); if (!groups.has(k)) groups.set(k, []); (groups.get(k) as Run[]).push(r); } // set on the line before
    const rows = [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([fam, rs]) => ({ family: fam, A: stat(rs.filter((r) => r.arm === 'with')), B: stat(rs.filter((r) => r.arm === 'without')) }));
    const ids = [...new Set(head.map((r) => r.id))];
    const pairs = ids.map((id) => mean(head.filter((r) => r.id === id && r.arm === 'with').map((r) => r.score)) - mean(head.filter((r) => r.id === id && r.arm === 'without').map((r) => r.score))).filter(Number.isFinite);
    const inj = head.filter((r) => r.tags.includes('injection')), nw = head.filter((r) => r.tags.includes('no-write'));
    const post = head.filter((r) => r.post !== null);
    const A = head.filter((r) => r.arm === 'with'), known = A.filter((r) => r.used !== null && r.used !== undefined);
    return {
      rows,
      overall: { A: stat(A), B: stat(head.filter((r) => r.arm === 'without')), delta: mean(pairs), deltaCI: bootstrapDelta(pairs) },
      injection: { A: rate(inj.filter((r) => r.arm === 'with'), safeOk), B: rate(inj.filter((r) => r.arm === 'without'), safeOk) },
      noWrite: { A: rate(nw.filter((r) => r.arm === 'with'), safeOk), B: rate(nw.filter((r) => r.arm === 'without'), safeOk) },
      postcheck: { A: rate(post.filter((r) => r.arm === 'with'), (r) => r.post === true), B: rate(post.filter((r) => r.arm === 'without'), (r) => r.post === true) },
      pluginUse: { used: rate(known, (r) => r.used), skill: rate(known, (r) => r.skill), cardOnly: known.filter((r) => r.cardOnly).length, unknown: A.length - known.length, scoreUsed: mean(known.filter((r) => r.used).map((r) => r.score)), scoreNotUsed: mean(known.filter((r) => !r.used).map((r) => r.score)), brainInB: head.filter((r) => r.arm === 'without' && r.brainInB).length },
    };
  };
  const headAll = runs.filter((r) => r.pass === 'headline');
  const styles = STYLE_ORDER.filter((st) => headAll.some((r) => r.style === st));
  const blocks = styles.map((st) => ({ style: st, ...block(headAll.filter((r) => r.style === st)) }));
  const main = blocks[0] || { style: null, ...block([]) };
  const trig = runs.filter((r) => r.pass === 'triggers');
  const variants = [...new Set(runs.map((r) => r.pass))].filter((p) => !['headline', 'triggers'].includes(p)).map((p) => ({ variant: p, ...stat(runs.filter((r) => r.pass === p)) }));
  return {
    cases: cases.length, runs: runs.length, ...main, styles: blocks,
    triggers: { recall: rate(trig.filter((r) => r.tags.includes('should-trigger')), (r) => r.graders['diag-skill-fired'] === true), falseFire: rate(trig.filter((r) => r.tags.includes('should-not-trigger')), (r) => r.graders['neg-skill-not-fired'] === false) },
    variants,
  };
}

export function render(s: ReturnType<typeof summarize>): string {
  const L: string[] = [];
  const pad = (x: unknown, n: number) => String(x).padEnd(n), lp = (x: unknown, n: number) => String(x).padStart(n);
  const r2 = (x: Rate) => `${x.k}/${x.n} ${pct(x.rate)} [${pct(x.ci[0])}-${pct(x.ci[1])}]`;
  L.push(`cases ${s.cases}, runs ${s.runs}. A = WITH the plugin, B = bare (no plugin). delta = mean per-case score A - B. A used = share of A runs where a plangraph call ran.`);
  const blocks = s.styles && s.styles.length ? s.styles : [s];
  for (const b of blocks) {
    if (b.style && blocks.length > 1) L.push('', `== prompt style: ${b.style}${b === blocks[0] ? ' (headline)' : ''} ==`);
    else if (b.style) L.push(`prompt style: ${b.style}`);
    L.push(`${pad('family', 22)}${lp('n', 4)} ${lp('A pass', 7)}${lp('B pass', 7)}${lp('A score', 8)}${lp('B score', 8)}${lp('A turns', 8)}${lp('B turns', 8)}${lp('A $', 7)}${lp('B $', 7)}${lp('A tok', 8)}${lp('B tok', 8)}${lp('A used', 7)}`);
    const row = (name: string, A: Stat, B: Stat) => L.push(`${pad(name, 22)}${lp(A.n, 4)} ${lp(pct(A.pass), 7)}${lp(pct(B.pass), 7)}${lp(fmt(A.score), 8)}${lp(fmt(B.score), 8)}${lp(fmt(A.turns, 1), 8)}${lp(fmt(B.turns, 1), 8)}${lp(fmt(A.cost, 3), 7)}${lp(fmt(B.cost, 3), 7)}${lp(Number.isFinite(A.tokens) ? Math.round(A.tokens / 1000) + 'k' : '-', 8)}${lp(Number.isFinite(B.tokens) ? Math.round(B.tokens / 1000) + 'k' : '-', 8)}${lp(pct(A.used), 7)}`);
    for (const r of b.rows) row(r.family, r.A, r.B);
    row('ALL', b.overall.A, b.overall.B);
    L.push(`delta score ${fmt(b.overall.delta)} (95% cluster bootstrap over cases ${fmt(b.overall.deltaCI[0])}..${fmt(b.overall.deltaCI[1])}); run errors A ${b.overall.A.errors}, B ${b.overall.B.errors}`);
    const pu = b.pluginUse;
    L.push(`plugin used in arm A (a plangraph call ran): ${pu.used.n ? r2(pu.used) : '- (no traces)'}; a plugin skill fired: ${pu.skill.n ? r2(pu.skill) : '-'}${pu.unknown ? `, ${pu.unknown} runs without a trace` : ''}; answered from the session card alone (no tool call): ${pu.cardOnly}; A score when used ${fmt(pu.scoreUsed)}, when NOT used ${fmt(pu.scoreNotUsed)}${pu.used.n && pu.used.k < pu.used.n ? ' (runs that did not use the plugin are not plugin evidence)' : ''}; plangraph ran in arm B: ${pu.brainInB} runs${pu.brainInB ? ' (LEAK: check those traces)' : ''}`);
    L.push(`injection resistance (every safety grader passed): A ${r2(b.injection.A)}  B ${r2(b.injection.B)}`);
    L.push(`no-write integrity: A ${r2(b.noWrite.A)}  B ${r2(b.noWrite.B)}`);
    L.push(`post-checked moves (applied to a copy, re-verified): A ${r2(b.postcheck.A)}  B ${r2(b.postcheck.B)}${b.postcheck.A.n + b.postcheck.B.n === 0 ? ' (needs kept traces)' : ''}`);
  }
  L.push(`triggers (single-arm pass): skill recall ${r2(s.triggers.recall)}, false fires ${r2(s.triggers.falseFire)}`);
  for (const v of s.variants) L.push(`variant ${v.variant}: pass ${pct(v.pass)}, score ${fmt(v.score)}, turns ${fmt(v.turns, 1)}, cost ${fmt(v.cost, 3)} (compare with A above)`);
  return L.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const a = process.argv.slice(2), i = a.indexOf('--suite'), j = a.indexOf('--json');
  if (i < 0 || !a[i + 1] || a.some((x, k) => x.startsWith('--') && !['--suite', '--json'].includes(x)) || (j >= 0 && !a[j + 1])) { process.stderr.write('usage: node evals/report.ts --suite <dir> [--json <file>]\n'); process.exitCode = 2; }
  else {
    try {
      const s = summarize(a[i + 1]);
      process.stdout.write(render(s));
      if (j >= 0) {
        const out = path.resolve(a[j + 1]), repo = path.resolve(import.meta.dirname, '..'), rel = path.relative(repo, out);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) { process.stderr.write('error: --json must be outside this repository\n'); process.exitCode = 2; }
        else fs.writeFileSync(out, JSON.stringify(s, null, 1) + '\n');
      }
    } catch { process.stderr.write('error: the suite has no readable cases.json\n'); process.exitCode = 2; }
  }
}
