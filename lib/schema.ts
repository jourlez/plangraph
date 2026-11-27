// Record validators for plangraph's JSONL files. Each takes a parsed record and returns an error message or null.
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

// ---- graph files (docs/FORMAT.md section 6): field shapes only; the grammar of types, relations and ids and the cross-row checks are in lib/graph/files.ts ----
const nonEmpty: FieldCheck = (r, k) => str(r, k) ?? (r[k] === '' ? `"${k}" must not be empty` : null);
const optBool: FieldCheck = (r, k) => (has(r, k) && typeof r[k] !== 'boolean' ? `"${k}" must be true or false` : null);
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
const optObject: FieldCheck = (r, k) => (has(r, k) && !isObject(r[k]) ? `"${k}" must be an object` : null);
const optStrings: FieldCheck = (r, k) => (has(r, k) && !(Array.isArray(r[k]) && (r[k] as unknown[]).every((x) => typeof x === 'string')) ? `"${k}" must be an array of strings` : null);
const reqInt: FieldCheck = (r, k) => (has(r, k) ? optInt(r, k) : `missing "${k}"`);
const reqNonNeg: FieldCheck = (r, k) => (has(r, k) ? optNonNeg(r, k) : `missing "${k}"`);
const optEnum = (...vs: string[]): FieldCheck => (r, k) => (has(r, k) && !vs.includes(r[k] as string) ? `"${k}" must be one of ${vs.join(', ')}` : null); // includes accepts any value; the cast only widens the list type
/** A calendar date YYYY-MM-DD (2026-02-30 is not one). */
const isDate = (v: unknown): boolean => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v; // 2026-13-01 is invalid, 2026-02-30 rolls over: parsed and compared back
};
const optDate: FieldCheck = (r, k) => (has(r, k) && !isDate(r[k]) ? `"${k}" must be a date (YYYY-MM-DD)` : null);
// schema_version: the version of the row's own shape; a row of a newer shape is read, never refused (unknown fields are kept)
const optSchemaVersion: FieldCheck = (r, k) => optInt(r, k) ?? (has(r, k) && (r[k] as number) < 1 ? `"${k}" must be at least 1` : null); // optInt returned null: absent or a whole number
const optCmds: FieldCheck = (r, k) => optObject(r, k) ?? (has(r, k) && !Object.values(r[k] as object).every((x) => typeof x === 'string') ? `"${k}" values must be strings` : null); // optObject returned null: absent or an object
const optPaths: FieldCheck = (r, k) => (has(r, k) && !(Array.isArray(r[k]) && (r[k] as unknown[]).every((x) => isObject(x) && typeof (x as Rec).glob === 'string' && typeof (x as Rec).sub === 'string')) ? `"${k}" must be an array of {glob, sub} objects` : null);
const withVersion = (...checks: Array<(r: Rec) => string | null>) => (r: Rec): string | null => first(r, [...checks, (x: Rec) => optSchemaVersion(x, 'schema_version')]);
const REPO_ROLES = ['service', 'lib', 'app', 'infra', 'docs', 'monorepo'], REPO_SRC = ['scan', 'manual', 'catalog'];

// ---- requirement, decision and team nodes (docs/FORMAT.md): field shapes; the node check (lib/store2/check.ts) applies the same rules as BAD_SCHEMA ----
export const REQ_KINDS = ['ears', 'gherkin', 'free'], REQ_STATUS = ['proposed', 'accepted', 'dropped'], DEC_STATUS = ['proposed', 'accepted', 'deprecated', 'superseded', 'rejected'];
const EXT_SYS = /^[a-z][a-z0-9-]{0,23}$/, EXT_XID = /^[A-Za-z0-9._:/#@ -]{1,200}$/, PATH_BAD = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\\]/;
/** Why a requirement `source` is refused, or null: a repo-relative path with an optional `#anchor`, or an external reference `<sys>:<xid>`; never a URL. */
export function sourceProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return '"source" must be a non-empty string';
  if (v.length > 300) return '"source" is longer than 300 characters';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v) || v.includes('://') || v.startsWith('//')) return '"source" must be a repo path or <sys>:<xid>, never a URL';
  const colon = v.indexOf(':'), slash = v.indexOf('/');
  if (colon > 0 && (slash < 0 || colon < slash) && EXT_SYS.test(v.slice(0, colon))) { // an external reference
    const xid = v.slice(colon + 1);
    return EXT_XID.test(xid) && !xid.includes('..') && !xid.startsWith('/') && !/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(xid) ? null : '"source" must be <sys>:<xid> (no URL, no email address)';
  }
  const file = v.split('#')[0] as string;
  return file === '' || file.startsWith('/') || file.split('/').some((x) => x === '..') || PATH_BAD.test(v) ? '"source" must be a repo-relative path (no "..", no absolute path) with an optional #anchor, or <sys>:<xid>' : null;
}
const optSource: FieldCheck = (r, k) => (has(r, k) ? sourceProblem(r[k]) : null);

export const validators: Record<string, (r: Rec) => string | null> = {
  'requirements.jsonl': withVersion((x) => nonEmpty(x, 'id'), (x) => optStr(x, 'text'), (x) => optEnum(...REQ_KINDS)(x, 'kind'), (x) => optEnum(...REQ_STATUS)(x, 'status'), (x) => optSource(x, 'source'), (x) => optStrings(x, 'acceptance'), (x) => optStr(x, 'priority')),
  'decisions.jsonl': withVersion((x) => nonEmpty(x, 'id'), (x) => optStr(x, 'title'), (x) => optEnum(...DEC_STATUS)(x, 'status'), (x) => optDate(x, 'date'), (x) => optStrings(x, 'affects'), (x) => optStr(x, 'source'), (x) => optStr(x, 'derivation')),
  'teams.jsonl': withVersion((x) => nonEmpty(x, 'id'), (x) => optStr(x, 'name'), (x) => optStrings(x, 'members'), (x) => optStrings(x, 'owns')),
  'tickets.jsonl': (r: Rec) => first(r, [need('key'), (x: Rec) => optNonNeg(x, 'sp'), (x: Rec) => optNum(x, 'v2_sprint'), (x: Rec) => optStr(x, 'v2_owner'), (x: Rec) => (has(x, 'impl_status') && !(IMPL_STATUSES as readonly unknown[]).includes(x.impl_status) /* includes accepts any value; the cast only widens the list type */ ? '"impl_status" must be one of todo, in_progress, done, blocked' : null)]),
  'edges.jsonl': need('consumer', 'producer'),
  'schedule.jsonl': (r: Rec) => first(r, [need('key'), (x: Rec) => optStr(x, 'owner'), (x: Rec) => optInt(x, 'sprint'), (x: Rec) => optStr(x, 'version')]),
  'findings.jsonl': need('key', 'kind', 'text'),
  'refs.jsonl': (r: Rec) => first(r, [need('key'), (x: Rec) => (has(x, 'plans') && !Array.isArray(x.plans) ? '"plans" must be an array' : null), (x: Rec) => (has(x, 'files') && (typeof x.files !== 'object' || Array.isArray(x.files)) ? '"files" must be an object' : null)]),
  'open-items.jsonl': (r: Rec) => first(r, [need('key', 'kind'), (x: Rec) => optStr(x, 'owner'), (x: Rec) => (has(x, 'status') && (typeof x.status !== 'string' || !x.status) ? '"status" must be a non-empty string' : null)]),
  'people.jsonl': withVersion((x) => nonEmpty(x, 'id'), (x) => optStr(x, 'name'), (x) => optBool(x, 'active')),
  'sprints.jsonl': withVersion((x) => reqInt(x, 'n'), (x) => optStr(x, 'name'), (x) => optDate(x, 'start'), (x) => optDate(x, 'end'), (x) => (has(x, 'start') && has(x, 'end') && isDate(x.start) && isDate(x.end) && (x.start as string) > (x.end as string) ? '"end" must not be before "start"' : null) /* both are dates: ISO dates compare as text */, (x) => optStr(x, 'state')),
  'epics.jsonl': withVersion((x) => nonEmpty(x, 'id'), (x) => optStr(x, 'name')),
  'repos.jsonl': withVersion((x) => nonEmpty(x, 'id'), (x) => optStr(x, 'name'), (x) => optEnum(...REPO_ROLES)(x, 'role'), (x) => optStrings(x, 'langs'), (x) => optStr(x, 'pm'), (x) => optStr(x, 'runtime'), (x) => optStrings(x, 'frameworks'), (x) => optCmds(x, 'cmds'), (x) => optStrings(x, 'entry'), (x) => optStr(x, 'deploy'), (x) => optStrings(x, 'owners'), (x) => optPaths(x, 'paths'), (x) => optEnum(...REPO_SRC)(x, 'src'), (x) => optStr(x, 'fp'), (x) => optStr(x, 'scanned_at'), (x) => optStr(x, 'scanner')),
  'capacity.jsonl': withVersion((x) => nonEmpty(x, 'person'), (x) => reqInt(x, 'sprint'), (x) => reqNonNeg(x, 'sp'), (x) => optNonNeg(x, 'review_h')),
  'links.jsonl': withVersion((x) => nonEmpty(x, 'from'), (x) => nonEmpty(x, 'from_type'), (x) => nonEmpty(x, 'rel'), (x) => nonEmpty(x, 'to'), (x) => nonEmpty(x, 'to_type'), (x) => optObject(x, 'attrs')),
  'xrefs.jsonl': withVersion((x) => nonEmpty(x, 'type'), (x) => nonEmpty(x, 'id'), (x) => nonEmpty(x, 'sys'), (x) => nonEmpty(x, 'xid'), (x) => optStr(x, 'src'), (x) => optDate(x, 'seen'), (x) => optStr(x, 'note')),
};
