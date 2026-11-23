// Honest schedule-risk forecaster. Pure ES module, no I/O, no dependencies. See docs/FORECAST.md for formulas and limits.
// Every output carries a state tag (REFUSED | PRIOR-ONLY | PROVISIONAL | CALIBRATED) and is "model-conditional, not a prediction".
import { capOf } from './model.mjs';

// ---------- RNG (same generator as test/fixtures/gen.mjs) ----------
export function rng(seed = 1) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Box-Muller: Z = sqrt(-2 ln(1-U1)) cos(2 pi U2); two uniforms per draw, deterministic.
export const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// ---------- parsing ----------
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
/** @returns {Array<[string, number]>} */
function lines(text) { return String(text || '').split('\n').map((l, i) => /** @type {[string, number]} */ ([l.trim(), i + 1])).filter(([l]) => l); }
// Per-line errors are bounded: the first 10 messages are kept and the rest only counted (`... and N more` as a last message); parsing goes on.
const cappedErrors = () => { const a = []; let total = 0; return { push(m) { total++; if (a.length < 10) a.push(m); }, list: () => (total > 10 ? [...a, `... and ${total - 10} more`] : a) }; };
// history.jsonl: one record per COMPLETED sprint {sprint, planned, done, added, carried, team?, length?}. done=null means "no actuals".
export function parseHistory(text) {
  const records = [], errors = cappedErrors(), warnings = [], seen = new Set();
  for (const [l, no] of lines(text)) {
    let r; try { r = JSON.parse(l); } catch { errors.push(`line ${no}: invalid JSON`); continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`line ${no}: not an object`); continue; }
    if (!Number.isInteger(r.sprint)) { errors.push(`line ${no}: sprint must be an integer`); continue; }
    if (seen.has(r.sprint)) { errors.push(`line ${no}: duplicate sprint ${r.sprint}`); continue; }
    if (!isNum(r.planned) || r.planned <= 0) { errors.push(`line ${no}: planned must be a number > 0`); continue; }
    if (r.done !== null && r.done !== undefined && (!isNum(r.done) || r.done < 0)) { errors.push(`line ${no}: done must be a number >= 0 or null`); continue; }
    if (r.added !== undefined && (!isNum(r.added) || r.added < 0)) { errors.push(`line ${no}: added must be a number >= 0`); continue; }
    if (r.carried !== undefined && (!isNum(r.carried) || r.carried < 0)) { errors.push(`line ${no}: carried must be a number >= 0`); continue; }
    if (r.added === undefined) warnings.push(`sprint ${r.sprint}: no "added", scope creep treated as 0`);
    const done = r.done ?? null, added = r.added ?? 0;
    const rec = { sprint: r.sprint, planned: r.planned, done, added, carried: r.carried ?? (done === null ? null : Math.max(0, r.planned + added - done)) };
    if (isNum(r.team)) rec.team = r.team; if (isNum(r.length)) rec.length = r.length;
    seen.add(r.sprint); records.push(rec);
  }
  records.sort((a, b) => a.sprint - b.sprint);
  return { records, errors: errors.list(), warnings };
}
// actuals.jsonl: per completed ticket {key, sp, actual, owner, sprint}.
export function parseActuals(text) {
  const rows = [], errors = cappedErrors();
  for (const [l, no] of lines(text)) {
    let r; try { r = JSON.parse(l); } catch { errors.push(`line ${no}: invalid JSON`); continue; }
    if (!r || typeof r.key !== 'string' || !isNum(r.sp) || r.sp <= 0 || !isNum(r.actual) || r.actual <= 0 || typeof r.owner !== 'string' || !Number.isInteger(r.sprint)) { errors.push(`line ${no}: need key, sp>0, actual>0, owner, integer sprint`); continue; }
    rows.push({ key: r.key, sp: r.sp, actual: r.actual, owner: r.owner, sprint: r.sprint });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { rows, errors: errors.list() };
}

// ---------- special functions: regularized incomplete beta, beta quantile, Clopper-Pearson, normal cdf ----------
const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) { // Lanczos (g=7, n=9)
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1; let a = LG[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LG[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(x, a, b) { // modified Lentz continued fraction
  const TINY = 1e-300; let c = 1, d = 1 - ((a + b) * x) / (a + 1); if (Math.abs(d) < TINY) d = TINY; d = 1 / d; let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m; let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY; c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY; c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
// I_x(a,b) = x^a (1-x)^b / (a B(a,b)) * cf for x < (a+1)/(a+b+2), else 1 - I_{1-x}(b,a).
export function regIncBeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}
export function betaQuantile(p, a, b) { // bisection on the monotone cdf, 200 halvings
  if (p <= 0) return 0; if (p >= 1) return 1;
  let lo = 0, hi = 1; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (regIncBeta(m, a, b) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
// Exact two-sided interval for a binomial proportion: lower = Beta^-1(alpha/2; k, n-k+1), upper = Beta^-1(1-alpha/2; k+1, n-k).
export function clopperPearson(k, n, alpha = 0.05) {
  if (!(n > 0)) return [0, 1];
  return [k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1), k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k)];
}
export function normCdf(x) { // Abramowitz-Stegun 7.1.26 erf, abs error < 1.5e-7
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

// ---------- scoring ----------
// Empirical quantile of an ASCENDING array: sorted[ceil(p*N)-1] (type 1: smallest x with F(x) >= p).
export function quantile(sorted, p) { const N = sorted.length; return sorted[Math.min(N - 1, Math.max(0, Math.ceil(p * N) - 1))]; }
// rho_tau(q, y) = tau (y-q) if y >= q else (1-tau)(q-y)
export const pinball = (q, tau, y) => (y >= q ? tau * (y - q) : (1 - tau) * (q - y));
// CRPS from samples: E|X-y| - 0.5 E|X-X'|, with E|X-X'| = (2/m^2) sum_i (2i-m-1) x_(i) (all ordered pairs incl. i=j).
export function crps(samples, y) {
  const s = [...samples].sort((a, b) => a - b), m = s.length; let e1 = 0, e2 = 0;
  for (let i = 0; i < m; i++) { e1 += Math.abs(s[i] - y); e2 += (2 * (i + 1) - m - 1) * s[i]; }
  return e1 / m - 0.5 * ((2 * e2) / (m * m));
}
// PIT with deterministic mid-rank for ties: (#below + 0.5 #equal) / m.
export function pit(samples, y) { let lo = 0, eq = 0; for (const x of samples) { if (x < y) lo++; else if (x === y) eq++; } return (lo + 0.5 * eq) / samples.length; }
// Split conformal (CQR-style scores): index = ceil((n+1)(1-alpha)) (1-based). index > n means no finite guarantee.
export function conformalQuantile(scores, alpha) {
  const n = scores.length, idx = Math.ceil((n + 1) * (1 - alpha)), s = [...scores].sort((a, b) => a - b);
  return { n, index: idx, q: idx > n ? Infinity : s[idx - 1], infinite: idx > n };
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

// ---------- capacity process: circular block bootstrap of whole sprints ----------
// Deviation from the plain moving-block bootstrap: blocks start anywhere and wrap around the end, so every sprint has the same
// marginal selection probability (non-wrapping blocks under-sample the last sprint in the first slot of a one-step forecast).
export function makeSeq(n, L, rnd) { L = Math.max(1, Math.min(L, n)); let start = 0, off = L; return () => { if (off >= L) { start = Math.floor(rnd() * n); off = 0; } return (start + off++) % n; }; }
export function lag1(x) { const m = mean(x); let num = 0, den = 0; for (let i = 0; i < x.length; i++) { den += (x[i] - m) ** 2; if (i + 1 < x.length) num += (x[i] - m) * (x[i + 1] - m); } return den > 0 ? num / den : 0; }
// Block length: default 2; with n >= 20, 1 when |r1| < 1.96/sqrt(n) (white-noise 95% band), else 2.
export function chooseBlock(done, opts = {}) {
  if (opts.block) return { L: opts.block, r1: null, why: 'configured' };
  if (done.length >= 20) { const r1 = lag1(done); return Math.abs(r1) < 1.96 / Math.sqrt(done.length) ? { L: 1, r1, why: 'lag-1 negligible' } : { L: 2, r1, why: 'lag-1 significant' }; }
  return { L: 2, r1: null, why: 'default (n<20, lag-1 not estimable)' };
}
const usable = (records) => records.filter((r) => isNum(r.done));
// Samples of cumulative done over h sprints.
export function predictDone(records, h, runs, rnd, L = 2) {
  const n = records.length, out = new Array(runs);
  for (let r = 0; r < runs; r++) { const next = makeSeq(n, L, rnd); let s = 0; for (let k = 0; k < h; k++) s += records[next()].done; out[r] = s; }
  return out;
}
// Sprints until remaining work R is finished: R_{t+1} = max(0, R_t - D_t + A_t). Infinity when not done within H sprints.
export function simulateFinish(records, R, runs, rnd, L = 2, H = 60) {
  const n = records.length, out = new Array(runs);
  for (let r = 0; r < runs; r++) {
    const next = makeSeq(n, L, rnd); let cur = R, t = 0;
    while (cur > 0 && t < H) { const p = records[next()]; cur = Math.max(0, cur - p.done + p.added); t++; }
    out[r] = cur > 0 ? Infinity : t;
  }
  return out;
}

// ---------- ticket-level noise ----------
export const sizeClass = (sp) => (sp <= 2 ? 'S' : sp <= 5 ? 'M' : 'L');
export const PRIOR = { mu: 0.1, sigma: 0.4, sp: 0.1, ss: 0.1, k: 5 }; // labelled assumptions: planning fallacy mean +10%, total sd 0.4 on the log scale
// Pair-moment variance components for residuals r_i with person and sprint labels (cov = s_p^2 same person, s_s^2 same sprint, both add):
// s_p^2 = mean r_a r_b over pairs sharing person only; s_s^2 = same for sprint only; total = mean r^2; s_e^2 = total - s_p^2 - s_s^2. Floors at 0.
// Bias from centring r by the estimated grand mean is about -(s_p^2/G + s_s^2/S) for G persons and S sprints (measured in the tests: it does not vanish with N, only with G and S). Raw (unshrunk): fitTicketModel applies priors.
export function varianceComponents(r, person, sprint) {
  const N = r.length; let tot = 0, cp = 0, np = 0, cs = 0, ns = 0;
  for (let i = 0; i < N; i++) { tot += r[i] * r[i]; for (let j = i + 1; j < N; j++) { const sp = person[i] === person[j], ss = sprint[i] === sprint[j]; if (sp && !ss) { cp += r[i] * r[j]; np++; } else if (ss && !sp) { cs += r[i] * r[j]; ns++; } } }
  const total = tot / N, vp = np ? Math.max(0, cp / np) : 0, vs = ns ? Math.max(0, cs / ns) : 0;
  return { total, vp, vs, ve: Math.max(1e-6, total - vp - vs), nPersonPairs: np, nSprintPairs: ns };
}
// Fit y = ln(actual/sp). Level 'class' (>=15 pooled pairs, >=3 per present class), 'pooled' (>=5), else labelled 'prior'.
// Partial pooling: mu_c = (n_c ybar_c + k mu_pool)/(n_c + k), k = 5. Below 15 pairs mu_pool is itself shrunk to the prior mean 0.1 with weight k.
export function fitTicketModel(rows) {
  const N = rows.length, y = rows.map((r) => Math.log(r.actual / r.sp)), cls = rows.map((r) => sizeClass(r.sp));
  if (N < 5) return { source: 'prior', n: N, mu: { S: PRIOR.mu, M: PRIOR.mu, L: PRIOR.mu }, sp: PRIOR.sp, ss: PRIOR.ss, se: Math.sqrt(PRIOR.sigma ** 2 - PRIOR.sp ** 2 - PRIOR.ss ** 2), label: 'PRIOR (assumption: mu +0.1, sigma 0.4)' };
  const yb = mean(y), counts = { S: 0, M: 0, L: 0 }, sums = { S: 0, M: 0, L: 0 }; y.forEach((v, i) => { counts[cls[i]]++; sums[cls[i]] += v; });
  const present = Object.keys(counts).filter((c) => counts[c] > 0), classOk = N >= 15 && present.every((c) => counts[c] >= 3);
  const muPool = N >= 15 ? yb : (N * yb + PRIOR.k * PRIOR.mu) / (N + PRIOR.k), mu = {};
  for (const c of ['S', 'M', 'L']) mu[c] = classOk ? (sums[c] + PRIOR.k * muPool) / (counts[c] + PRIOR.k) : muPool;
  const res = y.map((v, i) => v - (classOk ? sums[cls[i]] / counts[cls[i]] : yb)), persons = new Set(rows.map((r) => r.owner)), sprints = new Set(rows.map((r) => r.sprint));
  let sigma = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / Math.max(1, N - 1)); if (N < 15) sigma = Math.max(0.25, sigma);
  let vp = PRIOR.sp ** 2, vs = PRIOR.ss ** 2, ve;
  if (N >= 15) { // informative capped priors: weight w = G/(G+4) on the data, rest on the prior; each sd capped at 0.5
    const vc = varianceComponents(res, rows.map((r) => r.owner), rows.map((r) => r.sprint)), wp = persons.size / (persons.size + 4), wsp = sprints.size / (sprints.size + 4);
    vp = Math.min(0.25, wp * vc.vp + (1 - wp) * PRIOR.sp ** 2); vs = Math.min(0.25, wsp * vc.vs + (1 - wsp) * PRIOR.ss ** 2);
  }
  ve = Math.max(1e-4, sigma * sigma - vp - vs); if (N < 15) ve = Math.max(ve, 0.25 ** 2 - vp - vs);
  return { source: classOk ? 'class' : 'pooled', n: N, mu, sp: Math.sqrt(vp), ss: Math.sqrt(vs), se: Math.sqrt(ve), sigma, label: classOk ? `ticket-level n=${N}` : `pooled n=${N}` };
}
// Lazy correlated factors: b per person, g per sprint. y = mu_c + b + g + e (no -sigma^2/2 shift: draw exp(y)).
export function makeFactors(par, rnd) {
  const b = new Map(), g = new Map();
  return { person: (o) => { if (!b.has(o)) b.set(o, par.sp * normal(rnd)); return b.get(o); }, sprint: (s) => { if (!g.has(s)) g.set(s, par.ss * normal(rnd)); return g.get(s); } };
}
// Log-ratio draws for tickets [{sp, owner, sprint}]. independent=true matches the marginal variance but drops the correlation.
export function drawLogRatios(par, tickets, rnd, { independent = false } = {}) {
  const f = makeFactors(par, rnd), tot = Math.sqrt(par.sp ** 2 + par.ss ** 2 + par.se ** 2);
  return tickets.map((t) => { const mu = typeof par.mu === 'number' ? par.mu : par.mu[sizeClass(t.sp)]; return independent ? mu + tot * normal(rnd) : mu + f.person(t.owner) + f.sprint(t.sprint) + par.se * normal(rnd); });
}

// ---------- plan-graph simulation ----------
class LoopError extends Error {}
function planGraph(model, opts) {
  const doneSet = new Set(opts.doneKeys || []), keys = [...model.sched.keys()].filter((k) => { const t = model.tickets.get(k); return !(t && t.jira_status === 'Done') && !doneSet.has(k); }).sort();
  const open = new Set(keys), prod = new Map(keys.map((k) => [k, (model.prods.get(k) || []).filter((p) => open.has(p))]));
  const cons = new Map(keys.map((k) => [k, []])); for (const [c, ps] of prod) for (const p of ps) cons.get(p).push(c);
  const left = new Map(keys.map((k) => [k, prod.get(k).length])), by = (a, b) => model.sched.get(a).sprint - model.sched.get(b).sprint || (a < b ? -1 : 1);
  const ready = keys.filter((k) => left.get(k) === 0).sort(by), order = [];
  while (ready.length) { const k = ready.shift(); order.push(k); for (const c of cons.get(k)) { left.set(c, left.get(c) - 1); if (!left.get(c)) { ready.push(c); ready.sort(by); } } }
  if (order.length !== keys.length) throw new LoopError('links contain a loop');
  const known = keys.map((k) => model.tickets.get(k)?.sp).filter((x) => isNum(x) && x > 0).sort((a, b) => a - b), med = known.length ? known[Math.floor(known.length / 2)] : 1;
  const sp = new Map(keys.map((k) => { const v = model.tickets.get(k)?.sp; return [k, isNum(v) && v > 0 ? v : med]; }));
  return { keys, order, prod, sp, missingSp: keys.filter((k) => !(model.tickets.get(k)?.sp > 0)).length, points: keys.reduce((s, k) => s + sp.get(k), 0) };
}
// mode 'capacity' (default): sprint delivery ratio m_t = max(0, D_t - A_t)/P_t resampled as whole sprints; ticket size sp/max(m,0.1) in the sprint it lands in.
// mode 'ticket': m_t = max(0.1, 1 - A_t/P_t) (scope creep only) and correlated ticket noise exp(mu_c + b_person + g_sprint + e). Never both (would double count).
export function simulatePlan(model, records, opts = {}) {
  const g = planGraph(model, opts), cfg = model.config || {}, runs = Math.max(opts.runs || 4000, 2000), mode = opts.mode || 'capacity', H = opts.horizon || 60, rnd = rng(opts.seed ?? 1);
  const recs = usable(records), L = opts.L ?? chooseBlock(recs.map((r) => r.done), opts).L, par = opts.noise || fitTicketModel([]);
  const planned = Math.max(0, ...g.keys.map((k) => model.sched.get(k).sprint)), start = opts.start ?? (recs.length ? recs[recs.length - 1].sprint + 1 : 1);
  const ratio = recs.map((r) => (mode === 'ticket' ? Math.max(0.1, 1 - r.added / r.planned) : Math.max(0.1, Math.max(0, r.done - r.added) / r.planned)));
  const ends = new Array(runs);
  for (let r = 0; r < runs; r++) {
    const next = makeSeq(recs.length, L, rnd), ms = [], fac = makeFactors(par, rnd), used = new Map(), at = new Map(); let last = 0, dead = false;
    const m = (s) => { const j = s - start; while (ms.length <= j) ms.push(ratio[next()]); return ms[j]; };
    for (const k of g.order) {
      const o = model.sched.get(k).owner; let s = Math.max(model.sched.get(k).sprint, start);
      for (const p of g.prod.get(k)) { const q = at.get(p); s = Math.max(s, model.sched.get(p).owner === o ? q : q + 1); }
      const e = mode === 'ticket' ? par.se * normal(rnd) : 0, mu = mode === 'ticket' ? par.mu[sizeClass(g.sp.get(k))] : 0, cap = capOf(cfg, o);
      const size = (sp) => (mode === 'ticket' ? g.sp.get(k) * Math.exp(mu + fac.person(o) + fac.sprint(sp) + e) : g.sp.get(k)) / m(sp);
      while (s < start + H) { const u = used.get(o + '|' + s) || 0, z = size(s); if (u === 0 || u + z <= cap) { used.set(o + '|' + s, u + z); break; } s++; }
      if (s >= start + H) { dead = true; break; }
      at.set(k, s); if (s > last) last = s;
    }
    ends[r] = dead ? Infinity : last;
  }
  return { ends, planned, start, points: g.points, tickets: g.keys.length, missingSp: g.missingSp, L, mode };
}

// ---------- backtest ----------
// Rolling origin, expanding window: at origin t train on records[0..t-1] only, predict cumulative done over sprints t..t+h-1.
export function backtest(history, opts = {}) {
  const recs = usable(history), h = opts.horizon || 1, minTrain = opts.minTrain ?? 3, runs = opts.runs || 1000, taus = [0.1, 0.5, 0.8, 0.9], N6 = opts.lastN || 6;
  const names = ['model', 'iid', 'gauss', 'naive'], acc = Object.fromEntries(names.map((n) => [n, { crps: [], pin: [], inside: 0, pit: [] }])), origins = [], commit = { p: [], y: [] };
  for (let t = minTrain; t + h <= recs.length; t++) {
    const train = recs.slice(0, t), y = recs.slice(t, t + h).reduce((s, r) => s + r.done, 0), rnd = rng((opts.seed ?? 1) * 1009 + t), done = train.map((r) => r.done);
    const L = chooseBlock(done, opts).L, tail = done.slice(-N6), mu = mean(tail), s = sd(tail);
    const planned = recs.slice(t, t + h).reduce((a, r) => a + r.planned, 0);
    const S = {
      model: predictDone(train, h, runs, rnd, L), iid: predictDone(train, h, runs, rnd, 1),
      gauss: Array.from({ length: runs }, () => Math.max(0, mu * h + s * Math.sqrt(h) * normal(rnd))), naive: new Array(runs).fill(planned),
    };
    origins.push({ t, trainN: train.length, y });
    for (const nme of names) {
      const sm = [...S[nme]].sort((a, b) => a - b), q = (p) => quantile(sm, p);
      acc[nme].crps.push(crps(sm, y)); acc[nme].pin.push(mean(taus.map((tau) => pinball(q(tau), tau, y)))); acc[nme].pit.push(pit(sm, y));
      if (y >= q(0.1) && y <= q(0.9)) acc[nme].inside++;
    }
    if (h === 1) { const nn = train.length; commit.p.push(train.filter((r) => Math.max(0, r.done - r.added) / r.planned >= 1).length / nn); commit.y.push(recs[t].carried === 0 ? 1 : 0); }
  }
  const n = origins.length, res = {};
  for (const nme of names) res[nme] = { crps: n ? mean(acc[nme].crps) : NaN, pinball: n ? mean(acc[nme].pin) : NaN, pit: acc[nme].pit, cover: { k: acc[nme].inside, n, nominal: 0.8, ci: clopperPearson(acc[nme].inside, n) } };
  const base = ['iid', 'gauss', 'naive'], bestC = Math.min(...base.map((b) => res[b].crps)), bestP = Math.min(...base.map((b) => res[b].pinball));
  const beats = n > 0 && (res.model.crps < bestC || res.model.pinball < bestP), ci = res.model.cover.ci, consistent = n > 0 && ci[0] <= 0.8 && 0.8 <= ci[1];
  const brier = (p, y) => mean(p.map((x, i) => (x - y[i]) ** 2));
  const commitOut = commit.y.length ? { n: commit.y.length, brier: brier(commit.p, commit.y), brierNaive: brier(commit.y.map(() => 1), commit.y), brierClimatology: brier(commit.y.map((_, i) => (commit.y.slice(0, i).reduce((a, b) => a + b, 0) + 1) / (i + 2)), commit.y) } : null;
  return { h, n, origins, methods: res, beats, consistent, passed: n >= 10 && consistent && beats, commit: commitOut };
}

// ---------- gate ----------
export const STATES = ['REFUSED', 'PRIOR-ONLY', 'PROVISIONAL', 'CALIBRATED'];
// Regimes: truncate history at the latest change (team size, sprint length, config regime_changes); flag a large shift in mean done
// (Welch t on last 3 vs earlier, |t| > 3 and relative shift > 30%) which cannot be located, so it downgrades instead.
export function assessHistory(history, config = {}) {
  const reasons = [], all = [...history].sort((a, b) => a.sprint - b.sprint), withDone = usable(all), lacking = all.length - withDone.length;
  let recs = withDone; const cuts = new Set((config.regime_changes || []).map((c) => (typeof c === 'number' ? c : c.sprint)).filter(Number.isInteger));
  for (let i = 1; i < recs.length; i++) { const a = recs[i - 1], b = recs[i]; if (isNum(a.team) && isNum(b.team) && a.team !== b.team) cuts.add(b.sprint); if (isNum(a.length) && isNum(b.length) && a.length !== b.length) cuts.add(b.sprint); }
  const cut = [...cuts].filter((s) => recs.some((r) => r.sprint >= s)).sort((a, b) => a - b).pop();
  if (cut !== undefined) { const lastSprint = recs[recs.length - 1].sprint; recs = recs.filter((r) => r.sprint >= cut); reasons.push(`regime change at S${cut}${cut >= lastSprint - 2 ? ' (within last 3 sprints)' : ''}: only ${recs.length} sprint(s) since`); }
  let shift = false;
  if (recs.length >= 8) {
    const a = recs.slice(0, -3).map((r) => r.done), b = recs.slice(-3).map((r) => r.done), se = Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length), d = mean(b) - mean(a);
    if (mean(a) > 0 && Math.abs(d) / mean(a) > 0.3 && (se === 0 ? d !== 0 : Math.abs(d) / se > 3)) { shift = true; reasons.push(`mean done shifted ${Math.round((100 * d) / mean(a))}% in the last 3 sprints`); }
  }
  const lackFrac = all.length ? lacking / all.length : 0; if (lackFrac > 0.3) reasons.push(`${Math.round(lackFrac * 100)}% of sprints lack actuals`);
  return { records: recs, n: recs.length, lackFrac, shift, reasons };
}
export function decideState(a, bt) {
  let lvl = a.n < 5 ? 0 : a.n < 10 ? 1 : a.n < 20 ? 2 : (bt && bt.passed ? 3 : 2);
  if (lvl > 0 && (a.lackFrac > 0.3 || a.shift)) lvl--;
  return STATES[lvl];
}

// ---------- top-level forecast ----------
const round = (p, step) => Math.round((p * 100) / step) * step;
/** @param {Record<string, any>} [inp] @returns {Record<string, any>} */
export function forecast(inp = {}) {
  const { history = [], actuals = [], model = null, config = (model && model.config) || {} } = inp, tag = 'model-conditional, not a prediction';
  const a = assessHistory(history, config), runs = Math.max(inp.runs || 4000, 2000), seed = inp.seed ?? 1;
  const refuse = (/** @type {number | null} */ planPoints, /** @type {string[]} */ reasons) => { const out = { state: 'REFUSED', n: a.n, tag, planPoints, reasons, runs: 0 }; out.text = renderForecast(out); out.tokens = Math.ceil(out.text.length / 4); return out; };
  let g = null;
  if (model) {
    try { g = planGraph(model, inp); } catch (e) { if (e instanceof LoopError) return refuse(null, ['the links contain a loop (run `brain check`)']); throw e; }
    if (!g.keys.length) return refuse(0, ['nothing left to forecast: every planned ticket is done']);
  }
  const R = g ? g.points : inp.remaining, planPoints = R ?? null;
  if (a.n < 5) return refuse(planPoints, ['insufficient history', ...a.reasons]);
  const bt = backtest(a.records, { runs: Math.min(runs, 1000), seed, block: inp.block }), state = decideState(a, bt), n = a.n, step = n < 20 ? 10 : 5;
  const L = chooseBlock(a.records.map((r) => r.done), inp).L, rnd = rng(seed);
  const noise = fitTicketModel(actuals), useTicket = (inp.mode || (actuals.length >= 15 ? 'ticket' : 'capacity')) === 'ticket';
  const sim = (recs) => (model ? simulatePlan(model, recs, { ...inp, runs, seed, L, mode: useTicket ? 'ticket' : 'capacity', noise }) : { ends: simulateFinish(recs, R, runs, rnd, L).map((k) => a.records[a.records.length - 1].sprint + k), start: a.records[a.records.length - 1].sprint + 1 });
  const main = sim(a.records), ends = main.ends.slice().sort((x, y) => x - y);
  const cdf = (s) => { let c = 0; for (const e of ends) if (e <= s) c++; return c / ends.length; };
  const lastDone = a.records[a.records.length - 1].sprint, med = quantile(ends, 0.5), pl = model ? main.planned : med;
  const targets = inp.targets || (Number.isFinite(pl) ? [pl, pl + 1] : []);
  const probs = targets.map((s) => ({ sprint: s, p: cdf(s), se: Math.sqrt((cdf(s) * (1 - cdf(s))) / ends.length) }));
  if (n < 10) for (const x of probs) { // leave-one-sprint-out range, widened by 10 points: data-derived "wide band"
    let lo = 1, hi = 0; for (let i = 0; i < n; i++) { const e = sim(a.records.filter((_, j) => j !== i)).ends, p = e.filter((v) => v <= x.sprint).length / e.length; lo = Math.min(lo, p); hi = Math.max(hi, p); }
    x.lo = Math.max(0, Math.min(lo, x.p) - 0.1); x.hi = Math.min(1, Math.max(hi, x.p) + 0.1);
  }
  const pct = { P50: quantile(ends, 0.5), P80: quantile(ends, 0.8) }; if (n >= 10) pct.P90 = quantile(ends, 0.9); if (n >= 30) pct.P95 = quantile(ends, 0.95);
  const res = { state, n, tag, planPoints, lastDone, probs, percentiles: pct, runs: ends.length, step, block: L, mode: model ? (useTicket ? `plan-graph, ticket-level noise (${noise.label})` : 'plan-graph, capacity process') : 'flat backlog, capacity process', backtest: { k: bt.methods.model.cover.k, n: bt.n, ci: bt.methods.model.cover.ci, beats: bt.beats, passed: bt.passed }, reasons: a.reasons };
  res.text = renderForecast(res); res.tokens = Math.ceil(res.text.length / 4); return res;
}

export function renderForecast(r) {
  const head = `FORECAST [${r.state} n=${r.n}${r.state === 'REFUSED' ? '' : ', model-conditional, not a prediction'}]`;
  if (r.state === 'REFUSED') return `${head} plan ${r.planPoints ?? '?'} pts: no probability: ${(r.reasons || ['insufficient history']).join('; ')}`;
  const step = r.n < 20 ? 10 : 5, lo = step, hi = 100 - step;
  const fmt = (p) => (p * 100 < lo ? `<${lo}%` : p * 100 > hi ? `>${hi}%` : `~${round(p, step)}%`);
  const rng_ = (x) => { const a = Math.floor((x.lo * 100) / 10) * 10, b = Math.ceil((x.hi * 100) / 10) * 10; return `${a}-${b}%`; };
  const parts = r.probs.map((x) => `by S${x.sprint}: ${r.state === 'PRIOR-ONLY' ? rng_(x) : fmt(x.p)}`);
  const bt = r.backtest.n ? ` (backtest ${r.backtest.k}/${r.backtest.n} inside, CI ${Math.round(r.backtest.ci[0] * 100)}-${Math.round(r.backtest.ci[1] * 100)}%${r.backtest.beats ? '' : ', no baseline beaten'})` : '';
  const pc = Object.entries(r.percentiles).map(([k, v]) => `${k} ${Number.isFinite(v) ? 'S' + v : '>S' + (r.lastDone + 60)}`).join(' ');
  return `${head} done ${parts.join(' | ')} | ${pc}${bt}${r.reasons.length ? ' [' + r.reasons.join('; ') + ']' : ''}`;
}
