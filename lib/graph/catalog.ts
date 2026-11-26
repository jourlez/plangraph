// `catalog-info.yaml` seed (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.10, federation): a repository's own Backstage descriptor is an
// optional seed for its node, never an authority. The text is untrusted: this is a line reader, not a YAML parser (no anchors, tags, includes or
// merge keys are ever followed), and only three allowlisted tokens leave it: a name, a role enum and owners that already exist in people.jsonl.
export interface CatalogSeed { name?: string; role?: string; owners?: string[] }

const NAME = /^[a-z0-9][a-z0-9@/._-]{0,99}$/;
const ROLES: Record<string, string> = { service: 'service', library: 'lib', website: 'app', documentation: 'docs', infrastructure: 'infra' };
const scalar = (raw: string): string => raw.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');

/** The seed of the first YAML document of a catalog-info.yaml; `{}` when nothing passes the allowlists. */
export function parseCatalogInfo(text: string, people: ReadonlySet<string>): CatalogSeed {
  const out: CatalogSeed = {}; let top = '';
  const lines = text.split('\n').slice(0, 400);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).replace(/\r$/, '');
    if (i > 0 && /^---(\s|$)/.test(raw)) break; // the first document only
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length, m = /^([A-Za-z][A-Za-z0-9]{0,30}):(?:\s+(.*))?$/.exec(raw.trim());
    if (!m) continue;
    if (indent === 0) { top = m[1] as string; continue; }
    if (indent > 4 || m[2] === undefined) continue; // direct children of a top-level key only
    const key = m[1] as string, v = scalar(m[2]);
    if (top === 'metadata' && key === 'name' && out.name === undefined) { const n = v.toLowerCase(); if (NAME.test(n)) out.name = n; }
    else if (top === 'spec' && key === 'type' && out.role === undefined) { const r = ROLES[v.toLowerCase()]; if (r !== undefined && Object.hasOwn(ROLES, v.toLowerCase())) out.role = r; }
    else if (top === 'spec' && key === 'owner' && out.owners === undefined) {
      const id = /^user:(?:default\/)?([A-Za-z0-9][A-Za-z0-9_.-]{0,38})$/.exec(v)?.[1]; // a group or team owner is not a person: dropped
      if (id !== undefined && people.has(id)) out.owners = [id];
    }
  }
  return out;
}
