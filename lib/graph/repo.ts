// Pure parsers behind `plangraph repo scan` (docs/superpowers/plans/2026-11-25-graph-v2-amendment.md section 3.10): allowlisted file text in, one canonical
// repos.jsonl row out. No I/O. Scanned text is untrusted data: only allowlisted tokens (enums, short names matched by a strict pattern, person ids
// already in people.jsonl) reach the row; nothing else from a file is copied.
import { createHash } from 'node:crypto';

export const MAX_FILE = 256 * 1024;
const SCANNER = 'plangraph-scan/1';
const FIXED = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.nvmrc', '.node-version', '.python-version', '.tool-versions', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', 'Dockerfile']);
/** True for a repo-relative path the scan may read. */
export const isScanFile = (p: string): boolean => FIXED.has(p);

export interface ScanFile { path: string; sha: string; text?: string } // text absent: the file was over MAX_FILE (refused, still part of fp)
export type Row = Record<string, unknown>;

/** SHA-256 of the sorted (path, blob sha) pairs of the files read. */
export const fingerprint = (files: readonly { path: string; sha: string }[]): string =>
  createHash('sha256').update([...files].map((f) => `${f.path}\0${f.sha}\n`).sort().join('')).digest('hex');

const NAME = /^[a-z0-9][a-z0-9@/._-]{0,99}$/;
const PATHLIKE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
const VERSION = /^v?(\d{1,4}(?:\.\d{1,4}){0,2})$/;
export const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const FRAMEWORKS: Record<string, string> = { react: 'react', next: 'next', vue: 'vue', svelte: 'svelte', express: 'express', fastify: 'fastify', hono: 'hono', '@nestjs/core': 'nestjs', '@angular/core': 'angular' };
const PY_FRAMEWORKS = ['django', 'flask', 'fastapi'];
const EXT: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift', c: 'c', cpp: 'cpp' };
const TOOL_RUNTIMES: Record<string, string> = { nodejs: 'node', python: 'python', ruby: 'ruby', golang: 'go' };

/** Top 3 languages by extension count (ties by name). */
export function langsOf(paths: readonly string[]): string[] {
  const n = new Map<string, number>();
  for (const p of paths) { const m = /\.([A-Za-z]{1,5})$/.exec(p), l = m && EXT[(m[1] as string).toLowerCase()]; if (l) n.set(l, (n.get(l) ?? 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map((e) => e[0]);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function parsePackageJson(text: string): Row {
  let j: unknown; try { j = JSON.parse(text); } catch { return {}; }
  if (!isObj(j)) return {};
  const out: Row = { runtime: 'node', pm: 'npm' };
  if (typeof j.name === 'string' && NAME.test(j.name)) out.name = j.name;
  const pm = typeof j.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(j.packageManager) : null;
  if (pm) out.pm = pm[1];
  const deps = { ...(isObj(j.devDependencies) ? j.devDependencies : {}), ...(isObj(j.dependencies) ? j.dependencies : {}) };
  const fw = Object.keys(FRAMEWORKS).filter((k) => Object.hasOwn(deps, k)).map((k) => FRAMEWORKS[k] as string);
  if (fw.length) out.frameworks = fw;
  if (isObj(j.scripts)) { const cmds: Record<string, string> = {}; for (const k of ['build', 'test', 'lint']) if (typeof j.scripts[k] === 'string') cmds[k] = k; if (Object.keys(cmds).length) out.cmds = cmds; } // the script NAME, never its body
  const bins = typeof j.bin === 'string' ? [j.bin] : isObj(j.bin) ? Object.values(j.bin) : [];
  const entry = [j.main, ...bins].filter((p): p is string => typeof p === 'string' && PATHLIKE.test(p) && !p.split('/').includes('..'));
  if (entry.length) out.entry = [...new Set(entry)].sort().slice(0, 3);
  return out;
}

function tomlSections(text: string): Map<string, Map<string, string>> {
  const secs = new Map<string, Map<string, string>>([['', new Map()]]); let cur = secs.get('') as Map<string, string>;
  for (const raw of text.split('\n')) {
    const line = raw.trim(), h = /^\[([A-Za-z0-9_.-]{1,60})\]$/.exec(line);
    if (h) { cur = secs.get(h[1] as string) ?? new Map(); secs.set(h[1] as string, cur); continue; }
    const kv = /^([A-Za-z0-9_-]{1,40})\s*=\s*"([^"]{0,200})"/.exec(line);
    if (kv) cur.set(kv[1] as string, kv[2] as string);
  }
  return secs;
}
function parsePyproject(text: string): Row {
  const s = tomlSections(text), out: Row = { runtime: 'python', pm: s.has('tool.poetry') ? 'poetry' : s.has('tool.uv') ? 'uv' : 'pip' };
  const name = s.get('project')?.get('name') ?? s.get('tool.poetry')?.get('name');
  if (name !== undefined && NAME.test(name.toLowerCase())) out.name = name.toLowerCase();
  const fw = PY_FRAMEWORKS.filter((f) => new RegExp(`^\\s*"?${f}\\b`, 'mi').test(text));
  if (fw.length) out.frameworks = fw;
  return out;
}
function parseCargo(text: string): Row {
  const out: Row = { runtime: 'rust', pm: 'cargo' }, name = tomlSections(text).get('package')?.get('name');
  if (name !== undefined && NAME.test(name)) out.name = name;
  return out;
}
function parseGoMod(text: string): Row {
  const out: Row = { runtime: 'go', pm: 'go' }, m = /^module\s+(\S{1,200})/m.exec(text), last = m ? (m[1] as string).split('/').pop() : undefined;
  if (last && NAME.test(last)) out.name = last;
  return out;
}

/** CODEOWNERS rules in file order; comments, blank lines and negations (`!`) are skipped. */
export interface Rule { pattern: string; owners: string[] }
export function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n').slice(0, 5000)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('!')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && pattern.length <= 200 && !/[\u0000-\u001f\u007f]/.test(pattern)) rules.push({ pattern, owners: owners.slice(0, 20) });
  }
  return rules;
}
function globRe(pattern: string): RegExp {
  const dirOnly = pattern.endsWith('/'), p = dirOnly ? pattern.slice(0, -1) : pattern, anchored = p.startsWith('/') || p.includes('/'), body = (p.startsWith('/') ? p.slice(1) : p)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:/|$)'}`);
}
/** The owners of `path`: the last matching rule wins. */
export function ownersFor(rules: readonly Rule[], path: string): string[] {
  let hit: Rule | undefined;
  for (const r of rules) if (globRe(r.pattern).test(path)) hit = r;
  return hit ? hit.owners : [];
}
const ROOT_PATTERNS = new Set(['*', '**', '/', '/*', '/**']);
/** The default owners of the whole repository: the last catch-all rule, resolved to person ids (an unresolvable owner is dropped). */
export function repoOwners(rules: readonly Rule[], people: ReadonlySet<string>): string[] {
  let hit: Rule | undefined;
  for (const r of rules) if (ROOT_PATTERNS.has(r.pattern)) hit = r;
  const ids = (hit?.owners ?? []).filter((o) => /^@[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/.test(o)).map((o) => o.slice(1)).filter((id) => people.has(id));
  return [...new Set(ids)].sort();
}

const MANIFESTS: Array<[string, (t: string) => Row]> = [['package.json', parsePackageJson], ['pyproject.toml', parsePyproject], ['Cargo.toml', parseCargo], ['go.mod', parseGoMod]];
function versioned(files: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>(), put = (family: string, v: string | undefined) => { const m = v ? VERSION.exec(v.trim()) : null; if (m && !out.has(family)) out.set(family, `${family}@${m[1]}`); };
  put('node', files.get('.nvmrc')); put('node', files.get('.node-version')); put('python', files.get('.python-version'));
  for (const line of (files.get('.tool-versions') ?? '').split('\n').slice(0, 200)) { const [t, v] = line.trim().split(/\s+/); const fam = TOOL_RUNTIMES[t ?? '']; if (fam) put(fam, v); }
  return out;
}

export interface ScanInput { slug: string; files: readonly ScanFile[]; paths: readonly string[]; people: ReadonlySet<string> }
export interface ScanResult { row: Row; warnings: string[] }
/** One scanned row (no `scanned_at`: the caller adds it, it is not part of the fingerprinted data). */
export function scanRepo({ slug, files, paths, people }: ScanInput): ScanResult {
  const warnings: string[] = [], texts = new Map<string, string>();
  for (const f of files) { if (f.text === undefined) warnings.push(`${f.path}: over ${MAX_FILE / 1024} KB, not read`); else texts.set(f.path, f.text); }
  let m: Row = {};
  for (const [file, parse] of MANIFESTS) { const t = texts.get(file); if (t !== undefined) { m = { ...parse(t), ...m }; } } // the first manifest in MANIFESTS order wins a field
  const vr = versioned(texts), fam = typeof m.runtime === 'string' ? m.runtime : undefined;
  if (fam && vr.has(fam)) m.runtime = vr.get(fam); else if (!fam && vr.size) m.runtime = [...vr.values()].sort()[0];
  const owners = repoOwners(parseCodeowners(['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].map((p) => texts.get(p) ?? '').join('\n')), people);
  const langs = langsOf(paths), row: Row = { id: `repo:${slug}`, name: typeof m.name === 'string' ? m.name : slug, src: 'scan', fp: fingerprint(files), scanner: SCANNER };
  if (langs.length) row.langs = langs;
  for (const k of ['pm', 'runtime', 'frameworks', 'cmds', 'entry']) if (m[k] !== undefined) row[k] = m[k];
  if (texts.has('Dockerfile')) row.deploy = 'docker';
  if (owners.length) row.owners = owners;
  return { row, warnings };
}

const SCANNED = ['name', 'langs', 'pm', 'runtime', 'frameworks', 'cmds', 'entry', 'deploy', 'src', 'fp', 'scanned_at', 'scanner'];
/** A rescan: scanned fields are overwritten (and removed when no longer found), hand-written ones (`role`, `paths`, anything else) stay, owners are unioned. */
export function mergeRow(existing: Row | undefined, scanned: Row): Row {
  if (!existing) return scanned;
  const out: Row = { ...existing };
  for (const k of SCANNED) { if (scanned[k] !== undefined) out[k] = scanned[k]; else delete out[k]; }
  const owners = [...new Set([...(Array.isArray(existing.owners) ? (existing.owners as string[]) : []), ...((scanned.owners as string[] | undefined) ?? [])])].sort();
  if (owners.length) out.owners = owners; else delete out.owners;
  return out;
}
