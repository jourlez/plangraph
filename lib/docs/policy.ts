// D24 and data-class scan for generated documents. Pure string functions. A finding never repeats the offending value (it could be a token):
// it names the kind and the line only.
export type DataClass = 'names' | 'tracker_text' | 'authors';
export type DataPolicy = { include: ReadonlySet<DataClass> };
export type Violation = { code: 'D24_VIOLATION' | 'DATA_CLASS_VIOLATION'; kind: string; line: number };
/** Values a document must not print unless the policy lists their class. */
export type Known = { names?: readonly string[]; texts?: readonly string[]; authors?: readonly string[] };

const CLASSES: readonly string[] = ['names', 'tracker_text', 'authors'];
/** The policy from the `docs.include` config list (unknown entries ignored). Default: empty. */
export function policyFromList(list: unknown): DataPolicy {
  const out = new Set<DataClass>();
  if (Array.isArray(list)) for (const x of list) if (typeof x === 'string' && CLASSES.includes(x)) out.add(x as DataClass);
  return { include: out };
}
export const policyKey = (p: DataPolicy): string => [...p.include].sort().join(',');

const TLD = 'com|org|net|io|dev|app|ai|cloud|co|edu|gov|info|biz|me|us|uk|de|eu|xyz|tech|local|internal|test|example|lan';
const D24_RULES: readonly { kind: string; re: RegExp }[] = [
  { kind: 'url', re: /\b[a-z][a-z0-9+.-]*:\/\/\S+/i },
  { kind: 'url', re: /\bwww\.[a-z0-9-]+\./i },
  { kind: 'email', re: /[^\s@<>()]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i },
  { kind: 'host', re: new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD})\\b`, 'i') },
  { kind: 'host', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { kind: 'token', re: /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abprs]-|sk-|AKIA)[A-Za-z0-9_-]{8,}/ },
  { kind: 'token', re: /\bBearer\s+\S{8,}/i },
  { kind: 'token', re: /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/ },
  { kind: 'account', re: /\b\d{4,8}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { kind: 'account', re: /\b[0-9a-f]{24}\b/ },
];
/** Kinds of D24 material in a text (url, email, host, token, account), sorted, without repeats. */
export function d24Kinds(text: string): string[] {
  const out = new Set<string>();
  for (const r of D24_RULES) if (r.re.test(text)) out.add(r.kind);
  return [...out].sort();
}
export const hasD24 = (text: string): boolean => D24_RULES.some((r) => r.re.test(text));

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
function hasWord(line: string, w: string): boolean {
  for (let i = line.indexOf(w); i >= 0; i = line.indexOf(w, i + 1)) {
    if (!isWordChar(line[i - 1]) && !isWordChar(line[i + w.length])) return true;
  }
  return false;
}

/** Scan the generated body (markers excluded). D24 always; data classes only when the policy does not list them. */
export function scanDocs(text: string, policy: DataPolicy, known: Known = {}): Violation[] {
  const out: Violation[] = [];
  const lines = text.split('\n');
  const names = policy.include.has('names') ? [] : (known.names ?? []).filter((n) => n.length >= 2);
  const texts = policy.include.has('tracker_text') ? [] : (known.texts ?? []).filter((n) => n.length >= 8);
  const authors = policy.include.has('authors') ? [] : (known.authors ?? []).filter((n) => n.length >= 2);
  // tracker texts are matched through a map of their first 8 characters (every text here has at least 8): a line holds a text only where one of
  // its 8-character windows is such a prefix, so a line costs its length, not the number of tickets (a includes per text per line is quadratic)
  const byPrefix = new Map<string, string[]>();
  for (const t of texts) { const k = t.slice(0, 8), g = byPrefix.get(k); if (g) g.push(t); else byPrefix.set(k, [t]); }
  const hasText = (line: string): boolean => {
    for (let j = 0; j + 8 <= line.length; j++) { const g = byPrefix.get(line.slice(j, j + 8)); if (g?.some((t) => line.startsWith(t, j))) return true; }
    return false;
  };
  lines.forEach((line, i) => {
    for (const k of d24Kinds(line)) out.push({ code: 'D24_VIOLATION', kind: k, line: i + 1 });
    if (names.some((n) => hasWord(line, n))) out.push({ code: 'DATA_CLASS_VIOLATION', kind: 'names', line: i + 1 });
    if (byPrefix.size > 0 && hasText(line)) out.push({ code: 'DATA_CLASS_VIOLATION', kind: 'tracker_text', line: i + 1 });
    if (authors.some((n) => hasWord(line, n))) out.push({ code: 'DATA_CLASS_VIOLATION', kind: 'authors', line: i + 1 });
  });
  return out;
}
