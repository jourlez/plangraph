// JSON golden values for the mutation-kill tests: `golden(file, name, value)` compares a plain value (Maps, Sets, non-finite numbers and
// floats normalised: floats to 12 significant digits so a last-bit difference between platforms cannot fail a test) with
// test/golden/mutation-kills/<file>.json, as JSON text (object key order counts). UPDATE_GOLDEN=1 rewrites the entry instead; review the diff by eye before committing.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const DIR = path.join(import.meta.dirname, '..', 'golden', 'mutation-kills');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
/** @type {Map<string, Record<string, unknown>>} */ const cache = new Map();

/** @param {unknown} v @returns {unknown} */
export function normalise(v) {
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : !Number.isFinite(v) ? (v > 0 ? 'Infinity' : '-Infinity') : Object.is(v, -0) ? 0 : Number.isInteger(v) ? v : Number(v.toPrecision(12));
  if (typeof v === 'bigint') return `${v}n`;
  if (v === undefined) return '(undefined)';
  if (v instanceof Map) return { '(map)': [...v].map(([k, x]) => [normalise(k), normalise(x)]) };
  if (v instanceof Set) return { '(set)': [...v].map(normalise) };
  if (v instanceof Error) return { '(error)': v.constructor.name, message: v.message, ...('code' in v ? { code: normalise(v.code) } : {}) };
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).map((k) => [k, normalise(/** @type {Record<string, unknown>} */ (v)[k])]));
  return v;
}

/** The value or the thrown error of fn, normalised. @param {() => unknown} fn */
export const outcome = (fn) => { try { return normalise(fn()); } catch (e) { return normalise(e instanceof Error ? e : new Error(String(e))); } };

/** @param {string} file @param {string} name @param {unknown} value */
export function golden(file, name, value) {
  const p = path.join(DIR, `${file}.json`);
  let data = cache.get(p);
  if (!data) { data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}; cache.set(p, /** @type {Record<string, unknown>} */ (data)); }
  const d = /** @type {Record<string, unknown>} */ (data), got = normalise(value);
  if (UPDATE) {
    d[name] = got;
    fs.mkdirSync(DIR, { recursive: true });
    const sorted = Object.fromEntries(Object.keys(d).sort().map((k) => [k, d[k]]));
    fs.writeFileSync(p, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.ok(Object.hasOwn(d, name), `no golden value ${file}/${name}: run with UPDATE_GOLDEN=1 and review it`);
  // compared as JSON text, so the key order of objects counts too (canonical field order is part of several outputs)
  assert.equal(JSON.stringify(got), JSON.stringify(d[name]), `${file}/${name} changed`);
}
