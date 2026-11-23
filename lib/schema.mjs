// Record validators for the brain's JSONL files. Each takes a parsed record and returns an error message or null.
// Unknown extra fields are always allowed (forward compatibility). Messages name the field, never the value.
/** @typedef {Record<string, any>} Rec */
/** @typedef {(r: Rec, k: string) => string | null} FieldCheck */
/** @type {(r: Rec, k: string) => boolean} */
const has = (r, k) => r[k] !== undefined && r[k] !== null;
/** @type {FieldCheck} */
const str = (r, k) => (!has(r, k) ? `missing "${k}"` : typeof r[k] !== 'string' ? `"${k}" must be a string` : null);
/** @type {FieldCheck} */
const optStr = (r, k) => (has(r, k) && typeof r[k] !== 'string' ? `"${k}" must be a string` : null);
/** @type {FieldCheck} */
const optNum = (r, k) => (has(r, k) && !(typeof r[k] === 'number' && Number.isFinite(r[k])) ? `"${k}" must be a number` : null);
/** @type {FieldCheck} */
const optInt = (r, k) => optNum(r, k) ?? (has(r, k) && !Number.isSafeInteger(r[k]) ? `"${k}" must be a whole number` : null);
/** @type {FieldCheck} */
const optNonNeg = (r, k) => optNum(r, k) ?? (has(r, k) && r[k] < 0 ? `"${k}" must not be negative` : null);
/** @type {(r: Rec, checks: Array<(r: Rec) => string | null>) => string | null} */
const first = (r, checks) => { for (const c of checks) { const m = c(r); if (m) return m; } return null; };
// impl_status: implementation progress taken from a superpowers ledger (optional, additive; see docs/FORMAT.md section 6).
export const IMPL_STATUSES = ['todo', 'in_progress', 'done', 'blocked'];
/** @type {(...ks: string[]) => (r: Rec) => string | null} */
const need = (...ks) => (r) => first(r, ks.map((k) => (x) => str(x, k)));

/** @type {Record<string, (r: Rec) => string | null>} */
export const validators = {
  'tickets.jsonl': (r) => first(r, [need('key'), (x) => optNonNeg(x, 'sp'), (x) => optNum(x, 'v2_sprint'), (x) => optStr(x, 'v2_owner'), (x) => (has(x, 'impl_status') && !IMPL_STATUSES.includes(x.impl_status) ? '"impl_status" must be one of todo, in_progress, done, blocked' : null)]),
  'edges.jsonl': need('consumer', 'producer'),
  'schedule.jsonl': (r) => first(r, [need('key'), (x) => optStr(x, 'owner'), (x) => optInt(x, 'sprint'), (x) => optStr(x, 'version')]),
  'findings.jsonl': need('key', 'kind', 'text'),
  'refs.jsonl': (r) => first(r, [need('key'), (x) => (has(x, 'plans') && !Array.isArray(x.plans) ? '"plans" must be an array' : null), (x) => (has(x, 'files') && (typeof x.files !== 'object' || Array.isArray(x.files)) ? '"files" must be an object' : null)]),
  'open-items.jsonl': (r) => first(r, [need('key', 'kind'), (x) => (has(x, 'status') && (typeof x.status !== 'string' || !x.status) ? '"status" must be a non-empty string' : null)]),
};
