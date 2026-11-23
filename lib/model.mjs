// In-memory plan model, loaded from the JSONL text (the source of truth). Pure data, no SQLite, so library modules and tests
// can work on plain objects. A model is: { tickets: Map<key,row>, edges: [{consumer,producer,kind,note}], prods: Map<consumer,[producer]>,
// cons: Map<producer,[consumer]>, sched: Map<key,{owner,sprint}>, config, findings, evidence, learnings, refs }.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, readCapped } from './jsonl.mjs';

// A per-person number from a config map (caps, min_per_sprint): an OWN property holding a finite number, else the map's `default`
// (same rule), else `fallback`. A person named `constructor`, `toString` or `__proto__` never reads a prototype member.
export const ownNumber = (map, person, fallback) => {
  const m = map !== null && typeof map === 'object' ? map : {};
  const get = (k) => (Object.hasOwn(m, k) && typeof m[k] === 'number' && Number.isFinite(m[k]) ? m[k] : undefined);
  return get(person) ?? get('default') ?? fallback;
};
export const capOf = (cfg, person) => ownNumber((cfg || {}).caps, person, 140);

// Build a model from already-parsed records (used by tests and by loadModel).
/** @param {{ tickets?: any[], edges?: any[], schedule?: any[], config?: Record<string, any>, findings?: any[], evidence?: any[], learnings?: any[], refs?: any[] }} [records] */
export function buildModel({ tickets = [], edges = [], schedule = [], config = {}, findings = [], evidence = [], learnings = [], refs = [] } = {}) {
  const skip = new Set(config.ignore_link_kinds || []);
  const prods = new Map(), cons = new Map();
  for (const e of edges) {
    if (skip.has(e.kind)) continue;
    if (!prods.has(e.consumer)) prods.set(e.consumer, []);
    if (!cons.has(e.producer)) cons.set(e.producer, []);
    prods.get(e.consumer).push(e.producer); cons.get(e.producer).push(e.consumer);
  }
  for (const m of [prods, cons]) for (const a of m.values()) a.sort();
  const sched = new Map(schedule.filter((r) => (r.version ?? 'current') === 'current').map((r) => [r.key, { owner: r.owner, sprint: r.sprint }]));
  return { tickets: new Map(tickets.map((t) => [t.key, t])), edges, prods, cons, sched, config, findings, evidence, learnings, refs };
}

const CONFIG_MAX = 64 * 1024;
export function loadModel(dir) {
  // config.json is small and repo-controlled: one capped read of a regular file, a symlink refused; messages name the base file only.
  const rj = (f) => {
    const name = path.basename(f); let st;
    try { st = fs.lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    if (st.isSymbolicLink()) throw Object.assign(new Error(`${name}: is a symlink`), { code: 'SYMLINK' });
    let text;
    try { text = readCapped(f, CONFIG_MAX); } catch (e) {
      if (e.code === 'TOO_LARGE') throw Object.assign(new Error(`${name}: too large (over ${CONFIG_MAX} bytes)`), { code: 'TOO_LARGE' });
      if (e.code === 'NOT_A_FILE') throw Object.assign(new Error(`${name}: not a regular file`), { code: 'NOT_A_FILE' });
      throw e;
    }
    try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Object.assign(new Error(`${name}: not valid JSON`), { code: 'BAD_JSON' }); }
  };
  const j = (n) => readJsonl(path.join(dir, n));
  return buildModel({ tickets: j('tickets.jsonl'), edges: j('edges.jsonl'), schedule: j('schedule.jsonl'), config: rj(path.join(dir, 'config.json')), findings: j('findings.jsonl'), evidence: j('evidence.jsonl'), learnings: j('learnings.jsonl'), refs: j('refs.jsonl') });
}
