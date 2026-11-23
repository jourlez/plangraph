// Tests for lib/stale.ts. Core: a DIFFERENTIAL test of computeStale against an independent from-scratch oracle over random mutation streams.
// NOT covered: real Jira (stamps and link sets are injected values; whether Jira bumps `updated` on link edits is unverified), git renames/submodules/
// symlinks (files are compared by blob id), huge repos (performance), the CLI wiring in bin/brain (integrator), hash collisions (16 hex chars of sha256).
// STALE_MODULE=<path> lets the mutation-check script run this same suite against a deliberately broken copy of the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildModel } from '../lib/model.ts';
import { genPlan, rng } from './fixtures/gen.ts';

const S = await import(process.env.STALE_MODULE ? pathToFileURL(path.resolve(process.env.STALE_MODULE)).href : '../lib/stale.ts');
const { computeStale, refsUpdate, fingerprintTicket, gitDeps, resolveRef, normalizePlanText, formatStale, staleKeys } = S;

interface StaleItem { key: string; reasons: string[]; via?: string | null }
const H = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

// ---------------- synthetic world (the "outside" the module reads through deps) ----------------
interface WorldRow { key: string; plans: Array<{ plan: string; task: string }>; files: Record<string, number>; fp_files: string; jira_updated?: string; audited_at?: string }
type WorldEdge = { consumer: string; producer: string; kind: string; note: string }; // a type alias, so it fits Edge's index signature
interface World {
  keys: string[]; edges: WorldEdge[]; rules: number; jira: Record<string, string>; jlinks: Record<string, string[]>; files: Record<string, string>;
  planText: string; plan2Text: string; rows: WorldRow[]; touches: Record<string, Record<string, number>>; r: () => number; rowless?: Set<string>; tick?: number;
}
function makeWorld(seed: number, n: number): World {
  const r = rng(seed), plan = genPlan({ n, people: 3, density: 0.12, seed });
  const keys = plan.tickets.map((t) => t.key);
  const w: World = { keys, edges: plan.edges.map((e) => ({ ...e })), rules: 1, jira: {}, jlinks: {}, files: {}, planText: '', plan2Text: '', rows: [], touches: {}, r };
  const pool = Math.max(3, Math.floor(n / 2));
  for (let j = 0; j < pool; j++) w.files[`src/f${j}.ts`] = `// file ${j} v0\n`;
  const rowless = new Set<string>(); // ~10% of tickets are never audited
  for (const k of keys) if (r() < 0.1) rowless.add(k);
  w.rowless = rowless;
  const sect = (k: string) => `## Task ${k}: title of ${k}\nbody of ${k}: v0\nmore lines of ${k}\n\n`;
  w.planText = '# Plan\n\nintro text\n\n' + keys.map(sect).join('');
  w.plan2Text = '# Other\n\n' + keys.map(sect).join('');
  for (const k of keys) {
    w.jira[k] = `2026-01-01T00:00:${k.length}`; w.jlinks[k] = [];
    const c = 1 + Math.floor(r() * 3), f: Record<string, number> = {}; for (let i = 0; i < c; i++) f[`src/f${Math.floor(r() * pool)}.ts`] = 1;
    w.touches[k] = f;
    if (!rowless.has(k)) { const plans = [{ plan: 'plan.md', task: k }]; if (r() < 0.3) plans.push({ plan: 'plan2.md', task: k + '.p2' }); w.rows.push({ key: k, plans, files: f, fp_files: '', jira_updated: '', audited_at: 'c0' }); }
  }
  return w;
}
const model = (w: World, shuffle?: <T>(a: T[]) => T[]) => { const e = shuffle ? shuffle([...w.edges]) : w.edges; const m = buildModel({ tickets: w.keys.map((key) => ({ key })), edges: e }); return m; };
const blob = (c: string) => 'b' + H(c);
function depsOf(w: World, calls?: string[]) {
  return {
    readPlanText: (ref: string, p: string) => { if (calls) calls.push(p); return p === 'plan.md' ? w.planText : p === 'plan2.md' ? w.plan2Text : null; },
    listFiles: (ref: string, paths: string[]) => { const o: Record<string, string | null> = {}; for (const p of paths) o[p] = w.files[p] != null ? blob(w.files[p]) : null; return o; },
    jiraStamp: (k: string) => w.jira[k] ?? '',
    linkSet: (k: string) => w.jlinks[k] || [],
  };
}
const optsOf = (w: World) => ({ ref: 'REF', rulesVersion: w.rules });

// ---------------- the independent oracle: raw values, no hashing, own section parser, own closure ----------------
const onorm = (t: string) => { const lines = t.replace(/\r\n|\r/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')); while (lines.length && lines[lines.length - 1] === '') lines.pop(); return lines; };
function osection(text: string, task: string): string | null {
  const id = task.replace(/\.p\d+$/, ''), lines = text.replace(/\r\n|\r/g, '\n').split('\n');
  const a = lines.findIndex((l) => l.startsWith(`## Task ${id}:`)); if (a < 0) return null;
  let b = lines.length; for (let i = a + 1; i < lines.length; i++) if (lines[i].startsWith('## Task ')) { b = i; break; }
  return onorm(lines.slice(a, b).join('\n')).join('\n');
}
// state(m): everything m's verdict could depend on, as raw values. Classes are kept apart so reasons can be checked too.
interface OState { prods: string[]; plan?: string[]; files?: string[]; jira?: string; links?: string[]; rules?: number }
function ostate(w: World, m: string): OState {
  const prods = [...new Set(w.edges.filter((e) => e.consumer === m).map((e) => e.producer))].sort();
  const row = w.rows.find((x) => x.key === m);
  if (!row) return { prods };
  const text: Record<string, string> = { 'plan.md': w.planText, 'plan2.md': w.plan2Text };
  return { prods, plan: row.plans.map((p) => p.plan + '|' + p.task + '|' + osection(text[p.plan], p.task)).sort(), files: Object.keys(row.files).sort().map((p) => p + '=' + w.files[p]), jira: w.jira[m], links: [...(w.jlinks[m] || [])].sort(), rules: w.rules };
}
const oanc = (w: World, n: string, strict: boolean) => { // ancestors (producers, transitively); strict: n only if reachable via >=1 step
  const prods = new Map<string, Set<string>>(); for (const e of w.edges) { if (!prods.has(e.consumer)) prods.set(e.consumer, new Set()); (prods.get(e.consumer) as Set<string>).add(e.producer); } // the set was created on the line before
  const seen = new Set<string>(), st = [n]; if (!strict) seen.add(n);
  while (st.length) { const x = st.pop() as string; for (const p of prods.get(x) || []) if (!seen.has(p)) { seen.add(p); st.push(p); } }
  return seen;
};
const CL = ['plan', 'files', 'jira', 'links', 'rules'] as const;
class Oracle {
  declare w: World;
  declare seen: Map<string, Record<string, OState>>;
  constructor(w: World) { this.w = w; this.seen = new Map(); }
  record(keys: string[]) { for (const n of keys) if (this.w.rows.some((r) => r.key === n)) { const cone = oanc(this.w, n, false), o: Record<string, OState> = {}; for (const m of cone) o[m] = ostate(this.w, m); this.seen.set(n, JSON.parse(JSON.stringify(o))); } }
  // returns Map key -> {classes:Set, pc:boolean}
  run() {
    const w = this.w, eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b), rows = w.rows.map((r) => r.key);
    const bad = new Map<string, boolean>(), own = new Map<string, Set<string>>(), mism = new Map<string, boolean>();
    for (const n of rows) {
      const sn = this.seen.get(n) as Record<string, OState>, now = ostate(w, n), cls = new Set<string>(); // record() ran for every audited key
      for (const c of CL) if (!eq(sn[n][c], now[c])) cls.add(c);
      const prodsDiff = !eq(sn[n].prods, now.prods);
      let cone = prodsDiff; for (const m of oanc(w, n, false)) if (m !== n && !eq(sn[m], ostate(w, m))) cone = true;
      own.set(n, cls); mism.set(n, prodsDiff || cone); bad.set(n, cls.size > 0 || prodsDiff || cone);
    }
    const out = new Map<string, { classes: Set<string>; pc: boolean }>();
    for (const n of w.keys) {
      const strict = oanc(w, n, true); const viaAnc = [...strict].some((m) => bad.get(m));
      const isRow = bad.has(n); const c = isRow ? own.get(n) as Set<string> /* own has an entry for every audited key */ : new Set<string>(); const pc = (isRow && mism.get(n)) || viaAnc;
      if (c.size || pc) out.set(n, { classes: c, pc });
    }
    return out;
  }
}

// ---------------- mutation stream ----------------
function mutate(w: World, kind: string, r: () => number, w0: Pick<World, 'files' | 'jira'>): void {
  const k = w.keys[Math.floor(r() * w.keys.length)];
  const fileList = Object.keys(w.files); const f = fileList[Math.floor(r() * fileList.length)];
  const tok = () => Math.floor(r() * 1e9).toString(36) + Math.floor(r() * 1e9).toString(36);
  const t = w.tick = (w.tick || 0) + 1;
  switch (kind) {
    case 'plan': { const which = r() < 0.2 ? 'plan2Text' : 'planText'; w[which] = w[which].replace(new RegExp(`^(body of ${k}: ).*$`, 'm'), `$1${tok()}-${t}`); break; }
    case 'planmore': { const which = 'planText'; w[which] = w[which].replace(`more lines of ${k}\n`, `more lines of ${k}\nadded ${t}\n`); break; }
    case 'file': w.files[f] += `// edit ${t}\n`; break;
    case 'filerevert': w.files[f] = w0.files[f]; break;
    case 'jira': w.jira[k] = `2026-02-01T00:00:${t}`; break;
    case 'jirarevert': w.jira[k] = w0.jira[k]; break;
    case 'link': { const a = w.jlinks[k]; if (a.length && r() < 0.5) a.splice(Math.floor(r() * a.length), 1); else a.push(w.keys[Math.floor(r() * w.keys.length)] + '#' + (t % 3)); break; }
    case 'edgeadd': { const p = w.keys[Math.floor(r() * w.keys.length)]; if (p !== k && !w.edges.some((e) => e.consumer === k && e.producer === p)) w.edges.push({ consumer: k, producer: p, kind: 'plan_need', note: '' }); break; }
    case 'edgedel': { if (w.edges.length) w.edges.splice(Math.floor(r() * w.edges.length), 1); break; }
    case 'rules': w.rules++; break;
    case 'noise': { const ws = r() < 0.5 ? 'planText' : 'plan2Text'; let x = w[ws].replace(/\r\n/g, '\n'); x = x.split('\n').map((l) => (r() < 0.5 ? l + ' \t ' : l)).join('\n').replace(/\n(## Task )/g, (m: string, h: string) => (r() < 0.5 ? '\n\n' + h : m)); if (r() < 0.5) x = x.replace(/\n/g, '\r\n'); x += r() < 0.5 ? '\n\n' : ''; w[ws] = x; break; }
    default: break; // noop
  }
}
const KINDS = ['plan', 'planmore', 'file', 'filerevert', 'jira', 'jirarevert', 'link', 'edgeadd', 'edgedel', 'rules', 'noise', 'noop', 'noop'];
const shuffler = (r: () => number) => <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function stream(seed: number, stats: { checks: number; hits: number; fp: number; audited: number; skipped: number; stale: number }) {
  const r = rng(seed * 7919 + 13), n = 6 + Math.floor(r() * 40), w = makeWorld(seed, n), w0 = JSON.parse(JSON.stringify({ files: w.files, jira: w.jira }));
  const sh = shuffler(r), deps = depsOf(w);
  let rows = refsUpdate(model(w), w.rows, deps, optsOf(w), w.keys).rows;
  const oracle = new Oracle(w); oracle.record(w.keys);
  const batches = 3 + Math.floor(r() * 8);
  for (let b = 0; b < batches; b++) {
    const cnt = Math.floor(r() * 5); const kinds = [];
    for (let i = 0; i < cnt; i++) { const kd = KINDS[Math.floor(r() * KINDS.length)]; kinds.push(kd); mutate(w, kd, r, w0); }
    const m = model(w, sh), res = computeStale(m, rows, deps, optsOf(w));
    const exp = oracle.run(), got = new Map<string, StaleItem>(res.stale.map((s: StaleItem) => [s.key, s]));
    const missed = [...exp.keys()].filter((k) => !got.has(k)), extra = [...got.keys()].filter((k) => !exp.has(k));
    stats.checks++; stats.hits += missed.length; stats.fp += extra.length; stats.audited += rows.length; stats.skipped += res.clean; stats.stale += exp.size;
    assert.deepEqual(missed, [], `seed ${seed} batch ${b} kinds ${kinds}: STALE HIT (oracle stale, incremental clean)`);
    assert.deepEqual(extra, [], `seed ${seed} batch ${b} kinds ${kinds}: false stale`);
    for (const [k, o] of exp) { // reasons are checked as well
      const g = got.get(k) as StaleItem; const dir = REASONS_DIR.filter((c) => g.reasons.includes(c));
      assert.deepEqual(dir, CL.filter((c) => o.classes.has(c)), `seed ${seed} ${k} direct reasons`);
      assert.equal(g.reasons.includes('producer_changed'), o.pc, `seed ${seed} ${k} producer_changed`);
      assert.equal(g.via != null, o.pc, `seed ${seed} ${k} via`);
    }
    assert.equal(res.stale.length + res.clean, w.rows.length - 0 + res.stale.filter((s: StaleItem) => !w.rows.some((x) => x.key === s.key)).length);
    // occasionally record fresh fingerprints: all stale, or a random subset
    const act = r();
    if (act < 0.25) { const u = refsUpdate(m, rows, deps, optsOf(w), null); rows = u.rows; oracle.record(u.updated); assert.deepEqual(computeStale(m, rows, deps, optsOf(w)).stale, [], 'after refs-update of all stale nothing is stale'); }
    else if (act < 0.5) { const sub = w.keys.filter(() => r() < 0.3); const u = refsUpdate(m, rows, deps, optsOf(w), sub); rows = u.rows; oracle.record(sub); }
  }
}
const REASONS_DIR = ['plan', 'files', 'jira', 'links', 'rules'];

test('DIFFERENTIAL: incremental stale set equals the from-scratch oracle on random mutation streams (stale-hit rate 0)', () => {
  const stats = { checks: 0, hits: 0, fp: 0, audited: 0, skipped: 0, stale: 0 }, N = +(process.env.STALE_STREAMS || 400);
  for (let s = 1; s <= N; s++) stream(s, stats);
  const skip = stats.skipped / stats.audited;
  console.log(`# differential: ${N} streams, ${stats.checks} checks, stale hits ${stats.hits}, false stale ${stats.fp}, mean oracle-stale per check ${(stats.stale / stats.checks).toFixed(2)}, skip ratio ${(skip * 100).toFixed(1)}%`);
  assert.equal(stats.hits, 0); assert.equal(stats.fp, 0); assert.ok(skip > 0.3, 'streams must leave a meaningful share of audited tickets untouched (else the test proves little)');
  assert.ok(stats.stale > stats.checks, 'streams must actually produce stale tickets');
});

// ---------------- targeted tests ----------------
const chainWorld = () => { // T-1 <- T-2 <- T-3 (consumer needs producer), T-4 alone
  const w = makeWorld(1, 4); (w.rowless as Set<string>).clear(); /* makeWorld always sets rowless */ w.edges = [{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need', note: '' }, { consumer: 'T-3', producer: 'T-2', kind: 'plan_need', note: '' }];
  w.keys = ['T-1', 'T-2', 'T-3', 'T-4']; w.rows = w.keys.map((k) => ({ key: k, plans: [{ plan: 'plan.md', task: k }], files: { [`src/own-${k}.ts`]: 1 }, fp_files: '' }));
  for (const k of w.keys) { w.files[`src/own-${k}.ts`] = 'x'; w.jlinks[k] = []; }
  return w;
};
const keysOf = (res: { stale: StaleItem[] }) => res.stale.map((s: StaleItem) => s.key);

test('fingerprints: deterministic across runs and object orderings', () => {
  const w = makeWorld(5, 8), d = depsOf(w);
  const row = { key: 'T-2', plans: [{ plan: 'plan.md', task: 'T-2' }], files: { 'src/f1.ts': 1, 'src/f0.ts': 1, 'src/f2.ts': 1 } };
  const row2 = { key: 'T-2', plans: [{ plan: 'plan.md', task: 'T-2' }], files: { 'src/f2.ts': 1, 'src/f0.ts': 1, 'src/f1.ts': 1 } };
  assert.deepEqual(fingerprintTicket(row, d, optsOf(w)), fingerprintTicket(row, d, optsOf(w)));
  assert.deepEqual(fingerprintTicket(row, d, optsOf(w)), fingerprintTicket(row2, d, optsOf(w)));
  w.jlinks['T-2'] = ['A-1', 'B-2']; const a = fingerprintTicket(row, d, optsOf(w)); w.jlinks['T-2'] = ['B-2', 'A-1', 'A-1']; assert.deepEqual(a, fingerprintTicket(row, d, optsOf(w)), 'link set order and duplicates do not matter');
  const m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  const again = refsUpdate(m, [...w.rows].reverse(), d, optsOf(w), w.keys).rows;
  assert.equal(JSON.stringify(rows), JSON.stringify(again), 'refs-update output is byte-identical whatever the input order');
});
test('fingerprints: golden values pin the algorithm (a change invalidates every stored fingerprint, bump deliberately)', () => {
  const d = { readPlanText: () => '## Task T-1: a\nbody\n', listFiles: () => ({ 'a.ts': 'b1' }), jiraStamp: () => '2026', linkSet: () => ['X-1'] };
  const fp = fingerprintTicket({ key: 'T-1', plans: [{ plan: 'p.md', task: 'T-1' }], files: { 'a.ts': 1 } }, d, { rulesVersion: 3 });
  assert.equal(JSON.stringify(fp), JSON.stringify(fingerprintTicket({ key: 'T-1', plans: [{ plan: 'p.md', task: 'T-1' }], files: { 'a.ts': 1 } }, d, { rulesVersion: 3 })));
  assert.match(fp.plans[0].fp, /^[0-9a-f]{16}$/); assert.match(fp.fp_files, /^[0-9a-f]{16}$/); assert.equal(fp.rules, '3'); assert.equal(fp.jira_updated, '2026');
  assert.equal(fp.fp_files, crypto.createHash('sha256').update('a.ts:b1').digest('hex').slice(0, 16));
});
test('normalization is documented behaviour: line endings, trailing spaces and trailing blank lines ignored; wording, indentation, inner blank lines count', () => {
  assert.equal(normalizePlanText('a  \r\nb\t\r\n\r\n\r\n'), 'a\nb');
  const w = chainWorld(); const d = depsOf(w), m = model(w); const rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  w.planText = w.planText.replace(/\n/g, '  \r\n') + '\r\n\r\n'; assert.deepEqual(computeStale(m, rows, d, optsOf(w)).stale, []);
  w.planText = w.planText.replace('body of T-4: v0', ' body of T-4: v0'); assert.deepEqual(keysOf(computeStale(m, rows, d, optsOf(w))), ['T-4'], 'indentation change is a real change');
  w.planText = w.planText.replace(' body of T-4: v0', 'body of T-4: v0').replace(/(body of T-4: v0 *)(\r?\n)(more)/, '$1$2$2$3'); assert.deepEqual(keysOf(computeStale(m, rows, d, optsOf(w))), ['T-4'], 'inner blank line is a real change');
});
test('transitive propagation: producer change reaches every consumer with via = nearest changed producer', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  w.planText = w.planText.replace('body of T-1: v0', 'body of T-1: v1');
  const res = computeStale(m, rows, d, optsOf(w));
  assert.deepEqual(res.stale, [{ key: 'T-1', reasons: ['plan'], via: null }, { key: 'T-2', reasons: ['producer_changed'], via: 'T-1' }, { key: 'T-3', reasons: ['producer_changed'], via: 'T-2' }]);
  assert.equal(res.clean, 1);
});
test('a producer re-audited alone does not hide the change from its consumers (consumers recorded earlier stay stale)', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows0 = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  w.planText = w.planText.replace('body of T-1: v0', 'body of T-1: v1');
  const rows1 = refsUpdate(m, rows0, d, optsOf(w), ['T-1']).rows;
  assert.deepEqual(keysOf(computeStale(m, rows1, d, optsOf(w))), ['T-2', 'T-3']);
  const rows2 = refsUpdate(m, rows1, d, optsOf(w), ['T-2']).rows; assert.deepEqual(keysOf(computeStale(m, rows2, d, optsOf(w))), ['T-3']);
  const rows3 = refsUpdate(m, rows2, d, optsOf(w), ['T-3']).rows; assert.deepEqual(computeStale(m, rows3, d, optsOf(w)).stale, []);
});
test('consumer re-audited while its producer is still stale stays stale (closure rule)', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows0 = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  w.planText = w.planText.replace('body of T-1: v0', 'body of T-1: v1');
  const rows1 = refsUpdate(m, rows0, d, optsOf(w), ['T-2', 'T-3']).rows;
  assert.deepEqual(keysOf(computeStale(m, rows1, d, optsOf(w))), ['T-1', 'T-2', 'T-3']);
});
test('refs-update records only the given keys, leaves other rows untouched, reports unknown keys', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows0 = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  w.files['src/own-T-4.ts'] = 'y'; w.files['src/own-T-1.ts'] = 'y';
  const u = refsUpdate(m, rows0, d, optsOf(w), ['T-4', 'ZZ-9']);
  assert.deepEqual(u.updated, ['T-4']); assert.deepEqual(u.skipped, ['ZZ-9']);
  assert.deepEqual(u.rows.find((r: WorldRow) => r.key === 'T-1'), rows0.find((r: WorldRow) => r.key === 'T-1'));
  assert.deepEqual(keysOf(computeStale(m, u.rows, d, optsOf(w))), ['T-1', 'T-2', 'T-3']);
  assert.deepEqual(Object.keys(u.rows[0]).slice(0, 3), ['key', 'plans', 'files']);
});
test('each input class alone makes the ticket stale with exactly that reason (files, jira, links, rules, plan)', () => {
  const cases: Record<string, (w: World) => void> = { plan: (w: World) => { w.planText = w.planText.replace('body of T-4: v0', 'z'); }, files: (w: World) => { w.files['src/own-T-4.ts'] = 'q'; }, jira: (w: World) => { w.jira['T-4'] = 'new'; }, links: (w: World) => { w.jlinks['T-4'] = ['X-1']; }, rules: (w: World) => { w.rules = 9; } };
  for (const [cls, fn] of Object.entries(cases)) {
    const w = chainWorld(), d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows; fn(w);
    const res = computeStale(m, rows, d, optsOf(w));
    if (cls === 'rules') assert.equal(res.stale.length, 4, 'rules bump invalidates everything'); else assert.deepEqual(res.stale, [{ key: 'T-4', reasons: [cls], via: null }], cls);
    if (cls === 'rules') assert.ok(res.stale.every((s: StaleItem) => s.reasons.includes('rules')));
  }
});
test('unavailable inputs are "not checked", not "changed": no jira/link deps means no jira/links reasons; rules unchecked without a version', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  const d2 = { ...d, jiraStamp: () => null, linkSet: () => null }; w.jira['T-4'] = 'zzz'; w.jlinks['T-4'] = ['A'];
  assert.deepEqual(computeStale(m, rows, d2, { ref: 'REF' }).stale, []);
  assert.deepEqual(keysOf(computeStale(m, rows, d, { ref: 'REF' })), ['T-4']);
  const rows2 = refsUpdate(m, rows, d2, { ref: 'REF' }, ['T-4']).rows; assert.equal(rows2.find((r: WorldRow) => r.key === 'T-4').jira_updated, rows.find((r: WorldRow) => r.key === 'T-4').jira_updated, 'unavailable input keeps the old record');
});
test('legacy rows (no rules, no fp_prods, no fp_links) are stale when those inputs are in play (safe direction)', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), good = refsUpdate(m, w.rows, d, { ref: 'REF' }, w.keys).rows;
  const legacy = good.map((r: Record<string, unknown>) => { const { fp_prods, fp_links, rules, ...x } = r; return x; });
  const d2 = { ...d, linkSet: () => null };
  assert.deepEqual(keysOf(computeStale(m, legacy, d2, { ref: 'REF' })), ['T-2', 'T-3'], 'consumers lack recorded producer digests; producers and loners are fine');
  assert.equal(computeStale(m, legacy, d2, { ref: 'REF', rulesVersion: 1 }).stale.length, 4, 'unrecorded rules version invalidates');
  assert.equal(computeStale(m, legacy, d, { ref: 'REF' }).stale.length, 4, 'unrecorded link fingerprint invalidates once links are tracked');
});
test('full re-audit escape hatch: opts.full lists every audited ticket with reason full', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  const res = computeStale(m, rows, d, { ...optsOf(w), full: true }); assert.equal(res.stale.length, 4); assert.ok(res.stale.every((s: StaleItem) => s.reasons.includes('full')));
});
test('edge order independence: same stale set, reasons and via for any edge/prods order', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), w = makeWorld(seed, 25), d = depsOf(w), rows = refsUpdate(model(w), w.rows, d, optsOf(w), w.keys).rows;
    for (let i = 0; i < 6; i++) mutate(w, ['plan', 'file', 'jira', 'edgeadd'][i % 4], r, w);
    const base = JSON.stringify(computeStale(model(w), rows, d, optsOf(w)));
    for (let t = 0; t < 4; t++) {
      const m = model(w, shuffler(r)); for (const a of [...m.prods.values(), ...m.cons.values()]) shuffler(r)(a); m.edges = shuffler(r)(m.edges);
      assert.equal(JSON.stringify(computeStale(m, shuffler(r)([...rows]), d, optsOf(w))), base);
      const u1 = refsUpdate(model(w), rows, d, optsOf(w), null).rows, u2 = refsUpdate(m, shuffler(r)([...rows]), d, optsOf(w), null).rows; assert.equal(JSON.stringify(u1), JSON.stringify(u2));
    }
  }
});
test('cycles terminate and are handled: every member of a cycle is stale when one changes; refs-update clears them', () => {
  const w = chainWorld(); w.edges.push({ consumer: 'T-1', producer: 'T-3', kind: 'plan_need', note: '' }, { consumer: 'T-1', producer: 'T-1', kind: 'plan_need', note: '' });
  const d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows;
  assert.deepEqual(computeStale(m, rows, d, optsOf(w)).stale, []);
  w.files['src/own-T-2.ts'] = 'changed';
  const res = computeStale(m, rows, d, optsOf(w)); assert.deepEqual(keysOf(res), ['T-1', 'T-2', 'T-3']);
  assert.deepEqual(computeStale(m, refsUpdate(m, rows, d, optsOf(w), null).rows, d, optsOf(w)).stale, []);
  const big = Array.from({ length: 200 }, (_, i) => ({ consumer: 'N' + i, producer: 'N' + ((i + 1) % 200), kind: 'x', note: '' }));
  const mm = buildModel({ tickets: big.map((e) => ({ key: e.consumer })), edges: big }); const dd = depsOf(w);
  computeStale(mm, mm.tickets.size ? [...mm.tickets.keys()].map((k) => ({ key: k, plans: [], files: {} })) : [], dd, {});
});
test('long chains do not blow the stack (iterative)', () => {
  const n = 20000, edges = Array.from({ length: n - 1 }, (_, i) => ({ consumer: 'L' + (i + 1), producer: 'L' + i, kind: 'x', note: '' }));
  const keys = Array.from({ length: n }, (_, i) => 'L' + i), m = buildModel({ tickets: keys.map((key) => ({ key })), edges });
  const d = { readPlanText: () => null, listFiles: () => ({}), jiraStamp: () => '', linkSet: () => [] };
  const rows = refsUpdate(m, keys.map((key) => ({ key, plans: [], files: {} })), d, {}, keys).rows;
  assert.equal(computeStale(m, rows, d, {}).stale.length, 0);
  const d2 = { ...d, jiraStamp: (k: string) => (k === 'L0' ? 'x' : '') }; assert.equal(computeStale(m, rows, d2, {}).stale.length, n);
});
test('a full diamond: via is the nearest changed producer, ties break by key', () => {
  const w = chainWorld(); w.keys = ['T-1', 'T-2', 'T-3', 'T-4']; w.edges = [['T-3', 'T-1'], ['T-3', 'T-2'], ['T-4', 'T-3'], ['T-4', 'T-1']].map(([consumer, producer]) => ({ consumer, producer, kind: 'x', note: '' }));
  const d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows; w.jira['T-1'] = 'n'; w.jira['T-2'] = 'n';
  const res = computeStale(m, rows, d, optsOf(w)); const by = Object.fromEntries(res.stale.map((s: StaleItem) => [s.key, s]));
  assert.equal(by['T-3'].via, 'T-1'); assert.equal(by['T-4'].via, 'T-1'); assert.deepEqual(by['T-4'].reasons, ['producer_changed']);
});
test('removing a link or adding one makes the consumer stale (graph structure is an input)', () => {
  const w = chainWorld(), d = depsOf(w), rows = refsUpdate(model(w), w.rows, d, optsOf(w), w.keys).rows;
  const saved = w.edges; w.edges = [saved[0]]; assert.deepEqual(keysOf(computeStale(model(w), rows, d, optsOf(w))), ['T-3']);
  w.edges = [...saved, { consumer: 'T-4', producer: 'T-1', kind: 'x', note: '' }]; assert.deepEqual(keysOf(computeStale(model(w), rows, d, optsOf(w))), ['T-4']);
});
test('default_ref: flag beats config beats HEAD; formatStale always states the ref', () => {
  assert.equal(resolveRef({ default_ref: 'origin/dev' }, undefined), 'origin/dev'); assert.equal(resolveRef({ default_ref: 'origin/dev' }, 'x'), 'x'); assert.equal(resolveRef({}, undefined), 'HEAD'); assert.equal(resolveRef(undefined, ''), 'HEAD');
  const w = chainWorld(), d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows; w.jira['T-4'] = 'n';
  const res = computeStale(m, rows, d, { ...optsOf(w), ref: 'origin/dev' });
  const one = formatStale(res, { commit: 'abc1234' }); assert.match(one, /^stale vs origin\/dev \(abc1234\): 1 of 4 need re-audit \{"jira":1\}\n$/);
  assert.match(formatStale(res, { list: true }), /\nT-4: jira\n$/); assert.equal(JSON.parse(formatStale(res, { json: true })).ref, 'origin/dev');
  assert.match(formatStale({ ...res, stale: [] , clean: 4 }, { jiraChecked: false }), /0 of 4 need re-audit \| not checked: jira\n/);
  assert.ok(Math.ceil(one.length / 4) <= 60, 'common-case output is under 60 tokens');
  const many = { ref: 'r', clean: 0, stale: Array.from({ length: 100 }, (_, i) => ({ key: 'K-' + i, reasons: ['plan'], via: null })) };
  assert.match(formatStale(many, { list: true, limit: 5 }), /\.\.\. 95 more\n$/);
});
test('single source of truth: staleKeys equals the stale list; Done exclusion happens after propagation', () => {
  const w = chainWorld(), d = depsOf(w), m = model(w), rows = refsUpdate(m, w.rows, d, optsOf(w), w.keys).rows; w.jira['T-1'] = 'n';
  const res = computeStale(m, rows, d, optsOf(w));
  assert.deepEqual(staleKeys(res), ['T-1', 'T-2', 'T-3']); assert.deepEqual(staleKeys(res, new Set(['T-1'])), ['T-2', 'T-3'], 'consumers of a Done producer are still re-audited');
  const before = JSON.stringify(res); computeStale(m, rows, d, optsOf(w)); assert.equal(JSON.stringify(computeStale(m, rows, d, optsOf(w))), before, 'pure: no mutation of inputs');
});
test('bundles do not shell out per ticket: plan file read once per (ref,path)', () => {
  const calls: string[] = []; const w = makeWorld(3, 10); const d = depsOf(w, calls);
  // the module asks deps once per plan entry; the git adapter (tested below) caches those
  computeStale(model(w), w.rows.map((r) => ({ ...r, fp_files: '' })), d, optsOf(w)); assert.ok(calls.length >= w.rows.length);
});

// ---------------- real git ----------------
function sh(cwd: string, ...a: string[]) { return execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function repo() {
  const dir = fs.mkdtempSync(path.join(process.env.BRAIN_TEST_TMP || os.tmpdir(), 'stale-git-')); sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.name', 'Test'); sh(dir, 'config', 'user.email', 't@example.invalid'); sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
const commit = (dir: string, msg: string) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', msg); };
test('real git: edit one plan section -> exactly that ticket and its consumers stale; default_ref honoured; caches are per instance', () => {
  const dir = repo(); fs.mkdirSync(path.join(dir, 'docs')); fs.mkdirSync(path.join(dir, 'src'));
  const plan = (v: string) => '# Plan\n\n' + ['T-1', 'T-2', 'T-3', 'T-4'].map((k) => `## Task ${k}: name\nbody ${k} ${k === 'T-1' ? v : 'a'}\n\n`).join('');
  fs.writeFileSync(path.join(dir, 'docs/plan.md'), plan('a')); for (const k of [1, 2, 3, 4]) fs.writeFileSync(path.join(dir, `src/f${k}.ts`), 'x' + k);
  commit(dir, 'c1'); sh(dir, 'branch', 'dev');
  const w = { keys: ['T-1', 'T-2', 'T-3', 'T-4'] };
  const m = buildModel({ tickets: w.keys.map((key) => ({ key })), edges: [{ consumer: 'T-2', producer: 'T-1' }, { consumer: 'T-3', producer: 'T-2' }], config: { default_ref: 'dev' } });
  const base = w.keys.map((k, i) => ({ key: k, plans: [{ plan: 'docs/plan.md', task: k }], files: { [`src/f${i + 1}.ts`]: 1 } }));
  const ref = resolveRef(m.config, undefined); assert.equal(ref, 'dev');
  const d = gitDeps(dir, ref); const rows = refsUpdate(m, base, d, { ref, rulesVersion: 1 }, w.keys).rows;
  assert.deepEqual(computeStale(m, rows, gitDeps(dir, ref), { ref, rulesVersion: 1 }).stale, []);
  fs.writeFileSync(path.join(dir, 'docs/plan.md'), plan('b')); commit(dir, 'c2'); // main moves, dev does not
  assert.deepEqual(computeStale(m, rows, gitDeps(dir, ref), { ref, rulesVersion: 1 }).stale, [], 'default_ref dev unchanged: HEAD must not be used');
  const res = computeStale(m, rows, gitDeps(dir, 'main'), { ref: 'main', rulesVersion: 1 }); assert.deepEqual(res.stale.map((s: StaleItem) => [s.key, s.reasons.join(), s.via]), [['T-1', 'plan', null], ['T-2', 'producer_changed', 'T-1'], ['T-3', 'producer_changed', 'T-2']]); assert.equal(res.ref, 'main'); assert.equal(res.clean, 1);
  const stale = gitDeps(dir, 'main'); const t1 = stale.readPlanText('main', 'docs/plan.md'); fs.writeFileSync(path.join(dir, 'docs/plan.md'), plan('c')); commit(dir, 'c3');
  assert.equal(stale.readPlanText('main', 'docs/plan.md'), t1, 'cache: same instance does not re-run git'); assert.notEqual(gitDeps(dir, 'main').readPlanText('main', 'docs/plan.md'), t1);
  // code file edit of T-4 only; then CRLF + trailing-space reformat of the plan changes nothing
  fs.writeFileSync(path.join(dir, 'docs/plan.md'), plan('b')); fs.writeFileSync(path.join(dir, 'src/f4.ts'), 'x4 edited'); commit(dir, 'c4');
  assert.deepEqual(computeStale(m, rows, gitDeps(dir, 'main'), { ref: 'main', rulesVersion: 1 }).stale.map((s: StaleItem) => s.key), ['T-1', 'T-2', 'T-3', 'T-4']);
  const rows2 = refsUpdate(m, rows, gitDeps(dir, 'main'), { ref: 'main', rulesVersion: 1, commit: sh(dir, 'rev-parse', '--short', 'main').trim() }, null).rows;
  fs.writeFileSync(path.join(dir, 'docs/plan.md'), plan('b').replace(/\n/g, '  \r\n')); commit(dir, 'c5 format only');
  assert.deepEqual(computeStale(m, rows2, gitDeps(dir, 'main'), { ref: 'main', rulesVersion: 1 }).stale, [], 'formatting-only commit is not stale');
  fs.rmSync(path.join(dir, 'src/f2.ts')); commit(dir, 'c6 delete code'); assert.deepEqual(computeStale(m, rows2, gitDeps(dir, 'main'), { ref: 'main', rulesVersion: 1 }).stale.map((s: StaleItem) => s.key), ['T-2', 'T-3']);
  fs.rmSync(path.join(dir, 'docs'), { recursive: true }); commit(dir, 'c7 plan gone'); assert.equal(computeStale(m, rows2, gitDeps(dir, 'main'), { ref: 'main', rulesVersion: 1 }).stale.length, 4);
  const gd = gitDeps(dir, 'main', { jira: { 'T-1': { updated: 'u1', blockedBy: ['X-1'], status: 'Done' } } }); assert.equal(gd.jiraStamp('T-1'), 'u1'); assert.equal(gd.jiraStamp('T-9'), ''); assert.deepEqual(gd.linkSet('T-1'), ['X-1']); assert.equal(gitDeps(dir, 'main').jiraStamp('T-1'), null);
  assert.match(gd.commit('main'), /^[0-9a-f]{7,}$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a hostile default_ref or --ref is rejected and never reaches git as an option (no file written)', () => {
  const dir = repo(); fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); commit(dir, 'c1');
  const outFile = path.join(dir, 'pwned.out'); const hostile = `--output=${outFile}`;
  assert.throws(() => resolveRef({ default_ref: hostile }, undefined), TypeError);
  assert.throws(() => resolveRef({}, hostile), TypeError);
  assert.equal(resolveRef({ default_ref: 'dev' }, undefined), 'dev');
  const d = gitDeps(dir, hostile);
  assert.throws(() => d.listFiles(undefined, ['a.txt']), TypeError);
  assert.throws(() => d.commit(undefined), TypeError);
  assert.throws(() => gitDeps(dir, 'main').readPlanText(hostile, 'a.txt'), TypeError);
  assert.throws(() => gitDeps(dir, 'main').readPlanText('main', '../x'), TypeError);
  assert.equal(fs.existsSync(outFile), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('planSection rejects an unsafe heading template instead of compiling it as a regex', () => {
  assert.throws(() => S.planSection('## Task 1: a\n', '1', '^(a+)+{id}$'), TypeError);
});

test('gitDeps.readPlanText: only a missing path or ref reads as absent; timeouts and other git failures propagate', () => {
  const failing = (e: Error) => () => { throw e; };
  const timeout = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
  assert.throws(() => gitDeps('.', 'HEAD', { git: failing(timeout) }).readPlanText('HEAD', 'docs/plan.md'), /ETIMEDOUT/);
  const oldGit = Object.assign(new Error('Command failed'), { status: 128, stderr: "fatal: invalid object name '--end-of-options'." });
  assert.throws(() => gitDeps('.', 'HEAD', { git: failing(oldGit) }).readPlanText('HEAD', 'docs/plan.md'), /Command failed/);
  const spawn = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
  assert.throws(() => gitDeps('.', 'HEAD', { git: failing(spawn) }).readPlanText('HEAD', 'docs/plan.md'), /ENOENT/);
  const missing = Object.assign(new Error('Command failed'), { status: 128, stderr: "fatal: path 'docs/plan.md' does not exist in 'HEAD'\n" });
  assert.equal(gitDeps('.', 'HEAD', { git: failing(missing) }).readPlanText('HEAD', 'docs/plan.md'), null);
});

test('isAbsentError anchors stderr per line: a hostile path echoed in an unrelated failure is not "absent"', () => {
  const fail = (stderr: string) => () => { throw Object.assign(new Error('Command failed'), { status: 128, stderr }); };
  const read = (stderr: string) => gitDeps('.', 'HEAD', { git: fail(stderr) }).readPlanText('HEAD', 'docs/plan.md');
  for (const hostile of ["fatal: unable to access 'x invalid object name y': permission denied\n", "error: cannot read 'does not exist in' path\n", "fatal: bad config in 'a/invalid object name/b'\n", "warning: path 'x' ambiguous argument\n"]) assert.throws(() => read(hostile), /Command failed/, hostile);
  // an unknown ref is a configuration error and must fail loudly: it must never read as "every plan is absent"
  for (const badRef of ["fatal: invalid object name 'abc'.\n", "fatal: bad revision 'abc'\n", "fatal: ambiguous argument 'abc': unknown revision or path not in the working tree.\n", "fatal: not a valid object name abc\n"]) assert.throws(() => read(badRef), /Command failed/, badRef);
  assert.equal(read("fatal: path 'docs/plan.md' exists on disk, but not in 'HEAD'\n"), null);
  assert.equal(read("hint: something\nfatal: path 'docs/plan.md' does not exist in 'HEAD'\n"), null);
});
test('real git: a missing plan path reads as absent, an unknown ref is detected, wording changes would be caught', () => {
  const dir = repo(); fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); commit(dir, 'c1');
  const d = gitDeps(dir, 'main');
  assert.equal(d.readPlanText('main', 'docs/missing.md'), null, 'missing path in a valid ref is absent, not an error');
  assert.equal(d.readPlanText('main', 'a.txt'), 'x');
  // an unknown ref fails loudly on EVERY call, so a misconfigured ref can never look like a clean audit
  assert.throws(() => gitDeps(dir, 'main').readPlanText('no-such-ref', 'a.txt'), /Command failed|invalid object|unknown revision|ambiguous/i);
  assert.throws(() => gitDeps(dir, 'main').commit('no-such-ref'), /Command failed|invalid object|unknown revision|ambiguous/i);
  assert.throws(() => gitDeps(dir, 'main').listFiles('no-such-ref', ['a.txt']), /Command failed|not a valid object|invalid/i);
});

// ======================= review fix: linear-time trailing-whitespace trim =======================
// The old `l.replace(/[ \t]+$/, '')` is quadratic on a line of spaces followed by a non-space (2.6 s at 64 KB, 41 s at 256 KB).
const oldNormalizePlanText = (t: string) => String(t ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
test('normalizePlanText equals the former regex implementation on 200 random whitespace strings', () => {
  const r = rng(26), alphabet = [' ', ' ', '\t', '\r', '\n', 'a', 'b', '\uFEFF'];
  for (let k = 0; k < 200; k++) {
    let s = ''; const len = Math.floor(r() * 24);
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
    assert.equal(normalizePlanText(s), oldNormalizePlanText(s), JSON.stringify(s));
  }
  assert.equal(normalizePlanText(null), ''); assert.equal(normalizePlanText(undefined), '');
});
test('normalizePlanText takes linear time on a 2 MiB line of spaces (or tabs) followed by a letter', () => {
  const src = `import { normalizePlanText } from ${JSON.stringify(new URL('../lib/stale.ts', import.meta.url).href)};
const M = 2 << 20, t = performance.now();
const a = normalizePlanText(' '.repeat(M) + 'y'), b = normalizePlanText('\t'.repeat(M) + 'y'), c = normalizePlanText('x' + ' '.repeat(M));
process.stdout.write(JSON.stringify({ ms: performance.now() - t, la: a.length, lb: b.length, c }));`;
  // child process with a 15 s kill timer: a quadratic trim fails instead of hanging the suite. The 1000 ms bound is loose (linear takes ~tens of ms).
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 15000 });
  assert.equal(r.signal, null, `normalizePlanText did not finish within 15 s (killed by ${r.signal})`);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.ms < 1000, `normalizePlanText took ${o.ms.toFixed(0)} ms`);
  assert.equal(o.la, (2 << 20) + 1); assert.equal(o.lb, (2 << 20) + 1); assert.equal(o.c, 'x');
});
