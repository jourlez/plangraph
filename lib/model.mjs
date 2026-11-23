// In-memory plan model, loaded from the JSONL text (the source of truth). Pure data, no SQLite, so library modules and tests
// can work on plain objects. A model is: { tickets: Map<key,row>, edges: [{consumer,producer,kind,note}], prods: Map<consumer,[producer]>,
// cons: Map<producer,[consumer]>, sched: Map<key,{owner,sprint}>, config, findings, evidence, learnings, refs }.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, readCapped, IngestError } from './jsonl.mjs';

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

// config.json: THE one reader (loadModel, src/context.mjs ctx.config() and every command go through it). Small and repo-controlled: a
// symlink is refused (lstat), then one capped read of a regular file (readCapped: one fd, a FIFO, device or directory refused, at most
// CONFIG_MAX bytes), then a JSON object. Missing -> {}. Failures are an IngestError (exit 2 in the CLI) with a `code` and a fixed message
// naming the base file only (never a path or the content). Race left: a file swapped for a symlink between the lstat and the open is
// followed by the open; the cap and the regular-file check still hold on what is opened.
export const CONFIG_MAX = 64 * 1024;
/** @param {string} f @returns {Record<string, any>} */
export function readConfig(f) {
  const name = path.basename(f), fail = (/** @type {string} */ what, /** @type {string} */ code) => Object.assign(new IngestError(`${name}: ${what}`), { code });
  let st;
  try { st = fs.lstatSync(f); } catch (/** @type {any} */ e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return {}; throw e; }
  if (st.isSymbolicLink()) throw fail('is a symlink', 'SYMLINK');
  let text;
  try { text = readCapped(f, CONFIG_MAX); } catch (/** @type {any} */ e) {
    if (e.code === 'TOO_LARGE' || e.code === 'NOT_A_FILE') throw fail(e.message, e.code);
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let v;
  try { v = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw fail('not valid JSON', 'BAD_JSON'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw fail('must be a JSON object', 'NOT_OBJECT');
  return v;
}
/** @param {string} dir @param {{ config?: Record<string, any> }} [opts] config: an already-read config (the CLI passes ctx.config()). */
export function loadModel(dir, { config } = {}) {
  const j = (/** @type {string} */ n) => readJsonl(path.join(dir, n));
  return buildModel({ tickets: j('tickets.jsonl'), edges: j('edges.jsonl'), schedule: j('schedule.jsonl'), config: config ?? readConfig(path.join(dir, 'config.json')), findings: j('findings.jsonl'), evidence: j('evidence.jsonl'), learnings: j('learnings.jsonl'), refs: j('refs.jsonl') });
}
