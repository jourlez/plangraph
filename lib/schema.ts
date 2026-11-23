// Record validators for the brain's JSONL files. Each takes a parsed record and returns an error message or null.
// Unknown extra fields are always allowed (forward compatibility). Messages name the field, never the value.
export type Rec = Record<string, unknown>;
type FieldCheck = (r: Rec, k: string) => string | null;
const has = (r: Rec, k: string): boolean => r[k] !== undefined && r[k] !== null;
const str: FieldCheck = (r, k) => (!has(r, k) ? `missing "${k}"` : typeof r[k] !== 'string' ? `"${k}" must be a string` : null);
const optStr: FieldCheck = (r, k) => (has(r, k) && typeof r[k] !== 'string' ? `"${k}" must be a string` : null);
const optNum: FieldCheck = (r, k) => (has(r, k) && !(typeof r[k] === 'number' && Number.isFinite(r[k])) ? `"${k}" must be a number` : null);
const optInt: FieldCheck = (r, k) => optNum(r, k) ?? (has(r, k) && !Number.isSafeInteger(r[k]) ? `"${k}" must be a whole number` : null);
const optNonNeg: FieldCheck = (r, k) => optNum(r, k) ?? (has(r, k) && (r[k] as number) < 0 /* optNum returned null, so the value is absent or a finite number */ ? `"${k}" must not be negative` : null);
const first = (r: Rec, checks: Array<(r: Rec) => string | null>): string | null => { for (const c of checks) { const m = c(r); if (m) return m; } return null; };
// impl_status: implementation progress taken from a superpowers ledger (optional, additive; see docs/FORMAT.md section 6).
export const IMPL_STATUSES: string[] = ['todo', 'in_progress', 'done', 'blocked'];
const need = (...ks: string[]) => (r: Rec): string | null => first(r, ks.map((k) => (x: Rec) => str(x, k)));

export const validators: Record<string, (r: Rec) => string | null> = {
  'tickets.jsonl': (r: Rec) => first(r, [need('key'), (x: Rec) => optNonNeg(x, 'sp'), (x: Rec) => optNum(x, 'v2_sprint'), (x: Rec) => optStr(x, 'v2_owner'), (x: Rec) => (has(x, 'impl_status') && !(IMPL_STATUSES as readonly unknown[]).includes(x.impl_status) /* includes accepts any value; the cast only widens the list type */ ? '"impl_status" must be one of todo, in_progress, done, blocked' : null)]),
  'edges.jsonl': need('consumer', 'producer'),
  'schedule.jsonl': (r: Rec) => first(r, [need('key'), (x: Rec) => optStr(x, 'owner'), (x: Rec) => optInt(x, 'sprint'), (x: Rec) => optStr(x, 'version')]),
  'findings.jsonl': need('key', 'kind', 'text'),
  'refs.jsonl': (r: Rec) => first(r, [need('key'), (x: Rec) => (has(x, 'plans') && !Array.isArray(x.plans) ? '"plans" must be an array' : null), (x: Rec) => (has(x, 'files') && (typeof x.files !== 'object' || Array.isArray(x.files)) ? '"files" must be an object' : null)]),
  'open-items.jsonl': (r: Rec) => first(r, [need('key', 'kind'), (x: Rec) => (has(x, 'status') && (typeof x.status !== 'string' || !x.status) ? '"status" must be a non-empty string' : null)]),
};
