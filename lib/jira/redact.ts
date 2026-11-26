// lib/jira/redact.ts: the secret registry and redact(). A leaf: it imports no other lib/jira module. The secret set and the base64 cores
// stay module-private; registerSecret is exported to credentials.ts and client.ts only (lib/jira/index.ts does not re-export it).

// ---------------------------------------------------------------- redaction
const secrets = new Set<string>();
// The base64 characters that depend only on the secret's bytes when it sits at byte offset k (0, 1 or 2 modulo 3) inside a longer encoded
// string: a character covers 6 bits, so the first and last ones also carry bits of the neighbours and are left out. Kept only from 12
// characters up, so a short core cannot match ordinary data.
function base64Cores(b: Buffer): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const core = Buffer.concat([Buffer.alloc(k), b]).toString('base64').slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + b.length)) / 6));
    if (core.length >= 12) out.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return out;
}
// Decision D11: a raw API token (registered as { raw }) is also matched in any letter case and through any substring of WINDOW or more
// characters; a raw token of 12 to WINDOW - 1 characters is matched in any letter case as a whole. Only the raw token gets this: the
// derived forms (the Basic credential, base64, hex, percent) stay whole-form matches, so their fragments are never widened.
const WINDOW = 16;
const rawWindows = new Set<string>(); // the ASCII-folded WINDOW-character substrings of every raw token of WINDOW+ characters
const rawWindowHeads = new Set<number>(); // the first two folded character codes of each window: a cheap filter before the set lookup
const rawShort = new Set<string>(); // ASCII-folded raw tokens of 12 to WINDOW - 1 characters
// Folds only ASCII A-Z to a-z: String#toLowerCase can change the length (U+0130 becomes two code units) and would shift every offset.
const asciiFold = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
function registerRaw(raw: string): void {
  const f = asciiFold(raw);
  if (f.length >= WINDOW) {
    for (let i = 0; i + WINDOW <= f.length; i++) { rawWindows.add(f.slice(i, i + WINDOW)); rawWindowHeads.add(f.charCodeAt(i) * 65536 + f.charCodeAt(i + 1)); }
  } else if (f.length >= 12) rawShort.add(f);
}
// The [start, end) ranges of s that hold a case-changed raw token or a WINDOW+ character piece of one, merged where they overlap or touch,
// so a run of matching windows extends to the longest match.
function rawRanges(s: string): Array<[number, number]> {
  if (!rawWindows.size && !rawShort.size) return [];
  const f = asciiFold(s), found: Array<[number, number]> = [];
  if (rawWindows.size) {
    for (let i = 0, last = f.length - WINDOW; i <= last; i++) {
      if (rawWindowHeads.has(f.charCodeAt(i) * 65536 + f.charCodeAt(i + 1)) && rawWindows.has(f.slice(i, i + WINDOW))) found.push([i, i + WINDOW]);
    }
  }
  for (const t of rawShort) for (let i = f.indexOf(t); i !== -1; i = f.indexOf(t, i + 1)) found.push([i, i + t.length]);
  found.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of found) {
    const prev = out[out.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]); else out.push([r[0], r[1]]);
  }
  return out;
}
/** Registers secrets for redact(). A plain string gets its whole forms only; { raw } (the API token itself) also gets the D11 matching. */
export function registerSecret(...vals: unknown[]): void {
  for (const item of vals) {
    const isRaw = typeof item === 'object' && item !== null && 'raw' in item;
    const v: unknown = isRaw ? item.raw : item;
    if (typeof v !== 'string' || v.length < 6) continue;
    if (isRaw) registerRaw(v);
    const b = Buffer.from(v), hex = b.toString('hex'), uri = encodeURIComponent(v);
    secrets.add(v); secrets.add(uri); secrets.add(JSON.stringify(v).slice(1, -1));
    secrets.add(b.toString('base64')); secrets.add(b.toString('base64url'));
    // the same secret in forms a proxy or a log may produce: inside a longer base64 blob at any offset, hex, lower-case or full percent-encoding
    for (const c of base64Cores(b)) secrets.add(c);
    secrets.add(hex); secrets.add(hex.toUpperCase());
    secrets.add(uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    secrets.add(hex.replace(/../g, '%$&')); secrets.add(hex.toUpperCase().replace(/../g, '%$&'));
  }
}
export function redact(text: unknown): string {
  let s = text instanceof Error ? text.message : text == null ? '' : String(text);
  for (const sec of [...secrets].sort((a, b) => b.length - a.length)) s = s.split(sec).join('[redacted]');
  s = s.replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s"',;]+/gi, '$1[redacted]');
  s = s.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{8,}/g, '$1 [redacted]');
  s = s.replace(/\bAT[A-Z]TT[A-Za-z0-9_=+/.-]{16,}/g, '[redacted]'); // Atlassian API token prefix (heuristic)
  // D11 last: a window redacted first could cut a token the patterns above would have removed whole, leaving its other part in the output
  const ranges = rawRanges(s);
  if (!ranges.length) return s;
  let out = '', at = 0;
  for (const [a, b] of ranges) { out += `${s.slice(at, a)}[redacted]`; at = b; }
  return out + s.slice(at);
}
