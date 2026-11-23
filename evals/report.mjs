#!/usr/bin/env node
// Summary of an eval run: arm A (WITH the plugin) versus arm B (bare Claude, no plugin), from the native aggregate-result.json files.
//   node evals/report.mjs --suite <dir> [--json <file>]
// <dir> is a suite built by evals/run.mjs (cases.json, pass-*/, results/<pass>/.../aggregate-result.json). Per family: pass rate, mean
// score, delta, mean turns, mean cost, mean tokens (from the run traces when they were kept: --keep-temp), plus injection resistance,
// no-write integrity, post-checked moves (the model's proposed move applied to a copy of the plan and re-verified by lib/verify.mjs),
// trigger recall and false-fire rate (single-arm pass), and ablation variants. Prints ids, families and numbers only: never prompts,
// answers or ticket text (a real-project suite holds real data). Reads are bounded; writes only the --json file if asked.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCapped } from '../lib/jsonl.mjs';
import { parseAnswer } from './schema.mjs';
import { modelFromFiles, withOverlay, newViolations } from './families.mjs';
import { verifyPlan } from '../lib/verify.mjs';
import { applyMoves } from '../lib/whatif.mjs';

const MAX = 64 << 20;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : Number.NaN);
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
export function wilson(k, n, z = 1.96) { if (!n) return [Number.NaN, Number.NaN]; const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n)); return [(c - h) / d, (c + h) / d]; }
// Cluster bootstrap of the mean paired difference over cases (deterministic seed).
export function bootstrapDelta(pairs, B = 2000, seed = 7) {
  if (!pairs.length) return [Number.NaN, Number.NaN];
  let a = seed >>> 0; const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ds = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < pairs.length; i++) s += pairs[Math.floor(r() * pairs.length)]; ds.push(s / pairs.length); }
  ds.sort((x, y) => x - y);
  return [ds[Math.floor(0.025 * B)], ds[Math.floor(0.975 * B)]];
}

function findAggregates(dir, depth = 0, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === 'aggregate-result.json') out.push(p);
    else if (e.isDirectory() && !e.isSymbolicLink() && depth < 3) findAggregates(p, depth + 1, out);
  }
  return out;
}
// From a kept trace (stream-json): token usage and the final assistant text. Absent or unreadable -> nulls.
export function readTrace(p) {
  let text; try { if (!p || !fs.lstatSync(p).isFile()) return { tokens: null, message: null }; text = readCapped(p, MAX); } catch { return { tokens: null, message: null }; }
  let res = null;
  for (const l of text.split('\n')) { if (!l.includes('"type":"result"')) continue; try { const j = JSON.parse(l); if (j && j.type === 'result') res = j; } catch { /* not a JSON line */ } }
  if (!res) return { tokens: null, message: null };
  const u = res.usage || {};
  const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((s, k) => s + (Number.isFinite(u[k]) ? u[k] : 0), 0);
  return { tokens, message: typeof res.result === 'string' ? res.result : null };
}

// Apply the moves the model proposed (parsed from its ANSWER line) to a copy of the plan and re-verify: no new violation, the request met.
export function postcheck(c, message, fixtureFiles) {
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

export function summarize(suite) {
  const cases = JSON.parse(readCapped(path.join(suite, 'cases.json'), MAX));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const fixtureCache = new Map();
  const fixtureOf = (c) => {
    if (fixtureCache.has(c.fixture.size)) return fixtureCache.get(c.fixture.size);
    const d = path.join(suite, 'pass-headline', 'evals', 'fixtures', c.fixture.size), f = {};
    try { for (const n of fs.readdirSync(d)) if (/\.jsonl$|^config\.json$/.test(n)) f[n] = readCapped(path.join(d, n), MAX); } catch { /* no fixture */ }
    fixtureCache.set(c.fixture.size, f); return f;
  };
  const runs = []; // {pass, id, family, kind, tags, arm, score, passed, turns, cost, tokens, graders:{name: passed}, post}
  for (const agg of findAggregates(path.join(suite, 'results'))) {
    let j; try { j = JSON.parse(readCapped(agg, MAX)); } catch { continue; }
    const pass = path.relative(path.join(suite, 'results'), agg).split(path.sep)[0];
    for (const cr of j.cases || []) {
      const c = byId.get(cr.name); if (!c) continue;
      for (const arm of ['with', 'without']) for (const r of (cr.arms && cr.arms[arm]) || []) {
        const tr = readTrace(r.tracePath);
        const g = Object.fromEntries((r.graders || []).map((x) => [x.name, x.passed]));
        runs.push({ pass, id: c.id, family: c.family, kind: c.kind, tags: c.tags, arm, score: r.score, passed: !!r.passed, turns: r.turns, cost: r.costUsd, tokens: tr.tokens, error: !!r.error, graders: g,
          post: tr.message === null ? null : postcheck(c, tr.message, fixtureOf(c)) });
      }
    }
  }
  const roleOf = (id, name) => (byId.get(id).graders.find((g) => g.id === name) || {}).role;
  const safeOk = (r) => Object.entries(r.graders).filter(([n]) => roleOf(r.id, n) === 'safety').every(([, p]) => p);
  const head = runs.filter((r) => r.pass === 'headline');
  const stat = (rs) => ({ n: rs.length, pass: mean(rs.map((r) => (r.passed ? 1 : 0))), score: mean(rs.map((r) => r.score)), turns: mean(rs.map((r) => r.turns)), cost: mean(rs.map((r) => r.cost)), tokens: mean(rs.filter((r) => r.tokens !== null).map((r) => r.tokens)), errors: rs.filter((r) => r.error).length });
  const groups = new Map(); for (const r of head) { const k = r.family.replace(/-(?:yes|no)$/, ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const rows = [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([fam, rs]) => ({ family: fam, A: stat(rs.filter((r) => r.arm === 'with')), B: stat(rs.filter((r) => r.arm === 'without')) }));
  const ids = [...new Set(head.map((r) => r.id))];
  const pairs = ids.map((id) => mean(head.filter((r) => r.id === id && r.arm === 'with').map((r) => r.score)) - mean(head.filter((r) => r.id === id && r.arm === 'without').map((r) => r.score))).filter(Number.isFinite);
  const rate = (rs, f) => { const n = rs.length, k = rs.filter(f).length; return { k, n, rate: n ? k / n : Number.NaN, ci: wilson(k, n) }; };
  const inj = head.filter((r) => r.tags.includes('injection')), nw = head.filter((r) => r.tags.includes('no-write'));
  const post = head.filter((r) => r.post !== null);
  const trig = runs.filter((r) => r.pass === 'triggers');
  const variants = [...new Set(runs.map((r) => r.pass))].filter((p) => !['headline', 'triggers'].includes(p)).map((p) => ({ variant: p, ...stat(runs.filter((r) => r.pass === p)) }));
  return {
    cases: cases.length, runs: runs.length, rows,
    overall: { A: stat(head.filter((r) => r.arm === 'with')), B: stat(head.filter((r) => r.arm === 'without')), delta: mean(pairs), deltaCI: bootstrapDelta(pairs) },
    injection: { A: rate(inj.filter((r) => r.arm === 'with'), safeOk), B: rate(inj.filter((r) => r.arm === 'without'), safeOk) },
    noWrite: { A: rate(nw.filter((r) => r.arm === 'with'), safeOk), B: rate(nw.filter((r) => r.arm === 'without'), safeOk) },
    postcheck: { A: rate(post.filter((r) => r.arm === 'with'), (r) => r.post === true), B: rate(post.filter((r) => r.arm === 'without'), (r) => r.post === true) },
    triggers: { recall: rate(trig.filter((r) => r.tags.includes('should-trigger')), (r) => r.graders['diag-skill-fired'] === true), falseFire: rate(trig.filter((r) => r.tags.includes('should-not-trigger')), (r) => r.graders['neg-skill-not-fired'] === false) },
    variants,
  };
}

export function render(s) {
  const L = [];
  const pad = (x, n) => String(x).padEnd(n), lp = (x, n) => String(x).padStart(n);
  L.push(`cases ${s.cases}, runs ${s.runs}. A = WITH the plugin, B = bare (no plugin). delta = mean per-case score A - B.`);
  L.push(`${pad('family', 22)}${lp('n', 4)} ${lp('A pass', 7)}${lp('B pass', 7)}${lp('A score', 8)}${lp('B score', 8)}${lp('A turns', 8)}${lp('B turns', 8)}${lp('A $', 7)}${lp('B $', 7)}${lp('A tok', 8)}${lp('B tok', 8)}`);
  const row = (name, A, B) => L.push(`${pad(name, 22)}${lp(A.n, 4)} ${lp(pct(A.pass), 7)}${lp(pct(B.pass), 7)}${lp(fmt(A.score), 8)}${lp(fmt(B.score), 8)}${lp(fmt(A.turns, 1), 8)}${lp(fmt(B.turns, 1), 8)}${lp(fmt(A.cost, 3), 7)}${lp(fmt(B.cost, 3), 7)}${lp(Number.isFinite(A.tokens) ? Math.round(A.tokens / 1000) + 'k' : '-', 8)}${lp(Number.isFinite(B.tokens) ? Math.round(B.tokens / 1000) + 'k' : '-', 8)}`);
  for (const r of s.rows) row(r.family, r.A, r.B);
  row('ALL', s.overall.A, s.overall.B);
  L.push(`delta score ${fmt(s.overall.delta)} (95% cluster bootstrap over cases ${fmt(s.overall.deltaCI[0])}..${fmt(s.overall.deltaCI[1])}); run errors A ${s.overall.A.errors}, B ${s.overall.B.errors}`);
  const r2 = (x) => `${x.k}/${x.n} ${pct(x.rate)} [${pct(x.ci[0])}-${pct(x.ci[1])}]`;
  L.push(`injection resistance (every safety grader passed): A ${r2(s.injection.A)}  B ${r2(s.injection.B)}`);
  L.push(`no-write integrity: A ${r2(s.noWrite.A)}  B ${r2(s.noWrite.B)}`);
  L.push(`post-checked moves (applied to a copy, re-verified): A ${r2(s.postcheck.A)}  B ${r2(s.postcheck.B)}${s.postcheck.A.n + s.postcheck.B.n === 0 ? ' (needs --keep-temp traces)' : ''}`);
  L.push(`triggers (single-arm pass): skill recall ${r2(s.triggers.recall)}, false fires ${r2(s.triggers.falseFire)}`);
  for (const v of s.variants) L.push(`variant ${v.variant}: pass ${pct(v.pass)}, score ${fmt(v.score)}, turns ${fmt(v.turns, 1)}, cost ${fmt(v.cost, 3)} (compare with A above)`);
  return L.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const a = process.argv.slice(2), i = a.indexOf('--suite'), j = a.indexOf('--json');
  if (i < 0 || !a[i + 1] || a.some((x, k) => x.startsWith('--') && !['--suite', '--json'].includes(x)) || (j >= 0 && !a[j + 1])) { process.stderr.write('usage: node evals/report.mjs --suite <dir> [--json <file>]\n'); process.exitCode = 2; }
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
