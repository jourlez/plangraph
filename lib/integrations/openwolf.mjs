// OpenWolf read-through (design: docs/research/integrations/openwolf.md sections 2, 5 and 7). OpenWolf is AGPL-3.0-only: nothing here is
// copied from it; these are independent, tolerant parsers written from the documented file formats.
// Modes: READ-THROUGH only. This module reads `.wolf/cerebrum.md`, `.wolf/STATUS.md` and `.wolf/anatomy-index.json` when asked and
// never writes anything (no memory.md, anatomy, hooks, config, cron, STATUS, cerebrum or bug log). It never starts a process: the
// `git ls-files` fallback of anatomyLookup is an injected `listFiles` function. It never prints and never exits.
// Every text that comes out of a `.wolf` file is untrusted: callers print it only through renderRepoRules (oneLine + caps + fence) or
// through oneLine/fence themselves. Parsing is linear in the input (string scans, no backtracking regexes) and never throws on drift.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readCapped } from '../jsonl.mjs';
import { assertInside } from '../fsafe.mjs';
import { oneLine, fence } from '../sanitize.mjs';
import { checkRepoPath } from '../gitsafe.mjs';

const MiB = 1024 * 1024;
export const CAPS = { 'cerebrum.md': MiB, 'STATUS.md': MiB, 'anatomy-index.json': 20 * MiB };
const ENTRY_MAX = 2000; // per-entry text kept by the parser (render caps are smaller)
const KEY_MAX = 120, KEYS_PER_BULLET = 20;

// ---------- reading (fixed messages; nothing from the file is ever echoed) ----------
// Returns { ok: true, text } or { ok: false, missing: bool, warning: <fixed message> }. Only the three files above can be read.
/** @param {string} root @param {string} name @param {{ fsImpl?: typeof fs }} [opts] @returns {{ ok: boolean, text?: string, missing?: boolean, warning?: string }} */
export function readWolfFile(root, name, { fsImpl = fs } = {}) {
  if (!Object.hasOwn(CAPS, name)) throw new TypeError('readWolfFile: unsupported file');
  const shown = `.wolf/${name}`;
  const no = (warning, missing = false) => ({ ok: false, missing, warning });
  const dir = path.join(root, '.wolf');
  let st;
  try { st = fsImpl.lstatSync(dir); } catch { return no(`${shown} not found`, true); }
  if (st.isSymbolicLink()) return no('.wolf is a symlink: refused');
  if (!st.isDirectory()) return no('.wolf is not a directory: refused');
  try { assertInside(root, dir); } catch { return no('.wolf is outside the repository: refused'); }
  const file = path.join(dir, name);
  try { st = fsImpl.lstatSync(file); } catch { return no(`${shown} not found`, true); }
  if (st.isSymbolicLink()) return no(`${shown} is a symlink: refused`);
  if (!st.isFile()) return no(`${shown} is not a regular file: refused`);
  const cap = CAPS[name];
  try { return { ok: true, text: readCapped(file, cap, { fsImpl }) }; }
  catch (e) {
    if (e.code === 'TOO_LARGE') return no(`${shown} is larger than ${cap / MiB} MiB: not parsed`);
    if (e.code === 'NOT_A_FILE') return no(`${shown} is not a regular file: refused`);
    return no(`${shown} could not be read`);
  }
}

// ---------- shared line scanning ----------
// BOM stripped, CRLF and lone CR are line breaks. One split, then per-line work that is linear in the line.
const toLines = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
// Frontmatter: only when the first line is exactly `---`; ends at the next `---` line. Unclosed: not frontmatter. Returns the first body line index.
function bodyStart(lines) {
  if (lines[0]?.trimEnd() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === '---') return i + 1;
  return 0;
}
const isSpace = (c) => c === ' ' || c === '\t';
// Leading whitespace: number of characters and visual width (a tab counts as 4).
const indentOf = (l) => { let i = 0, w = 0; while (i < l.length && isSpace(l[i])) { w += l[i] === '\t' ? 4 : 1; i++; } return { chars: i, width: w }; };
// `## heading` (exactly two #, then a space or tab). Returns the heading text or null.
const h2 = (l) => (l.length > 2 && l[0] === '#' && l[1] === '#' && isSpace(l[2]) ? l.slice(3).trim() : null);
const h3 = (l) => (l.length > 3 && l[0] === '#' && l[1] === '#' && l[2] === '#' && isSpace(l[3]) ? l.slice(4).trim() : null);
const isFenceLine = (l) => { const t = l.trimStart(); return (l.length - t.length) <= 3 && (t.startsWith('```') || t.startsWith('~~~')); };
const isDigit = (c) => c >= '0' && c <= '9';
// List item marker at the start of `t` (already left-trimmed): `- `, `* `, `+ `, `1. `, `1) `. Returns the text after it, or null.
function listItem(t) {
  if ((t[0] === '-' || t[0] === '*' || t[0] === '+') && isSpace(t[1] ?? '')) return t.slice(2).trim();
  let i = 0; while (i < t.length && i < 9 && isDigit(t[i])) i++;
  if (i > 0 && (t[i] === '.' || t[i] === ')') && isSpace(t[i + 1] ?? '')) return t.slice(i + 2).trim();
  return null;
}
// Normalized heading for kind detection: leading non-letter/non-digit characters (emoji, punctuation, parentheses) dropped,
// hyphens and underscores read as spaces, whitespace collapsed, lowercased. Linear char scan.
const LETTER = /[\p{L}\p{N}]/u;
function normHeading(h) {
  const s = String(h);
  let i = 0;
  while (i < s.length) { const cp = s.codePointAt(i); const ch = String.fromCodePoint(cp); if (LETTER.test(ch)) break; i += ch.length; }
  let out = '', sp = false;
  for (let j = i; j < s.length; j++) {
    let c = s[j]; if (c === '-' || c === '_' || c === '\t') c = ' ';
    if (c === ' ') { sp = true; continue; }
    if (sp && out) out += ' '; sp = false; out += c;
  }
  return out.toLowerCase();
}
// Strips HTML comments from one line given the carried state. Returns { text, inComment }. Linear: each indexOf starts after the last hit.
function stripComments(line, inComment) {
  let out = '', pos = 0;
  for (;;) {
    if (inComment) { const e = line.indexOf('-->', pos); if (e < 0) return { text: out, inComment: true }; pos = e + 3; inComment = false; }
    const b = line.indexOf('<!--', pos);
    if (b < 0) return { text: out + line.slice(pos), inComment: false };
    out += line.slice(pos, b); pos = b + 4; inComment = true;
  }
}
// `YYYY-MM-DD` at index i of s?
const dateAt = (s, i) => s.length >= i + 10 && isDigit(s[i]) && isDigit(s[i + 1]) && isDigit(s[i + 2]) && isDigit(s[i + 3]) && s[i + 4] === '-' && isDigit(s[i + 5]) && isDigit(s[i + 6]) && s[i + 7] === '-' && isDigit(s[i + 8]) && isDigit(s[i + 9]);
// Leading `[YYYY-MM-DD]` or `YYYY-MM-DD ` -> { date, rest }.
function splitDate(t) {
  if (t[0] === '[' && dateAt(t, 1) && t[11] === ']') return { date: t.slice(1, 11), rest: t.slice(12).trim() };
  if (dateAt(t, 0) && (t.length === 10 || isSpace(t[10]))) return { date: t.slice(0, 10), rest: t.slice(10).trim() };
  return { date: undefined, rest: t };
}
// Placeholder lines of the templates: `_<...>_`, `{{...}}`, or a bare label followed by `...` (for example `**Goal:** ...`).
function isPlaceholder(t) {
  if (!t) return true;
  if (t.startsWith('_<') && t.endsWith('>_')) return true;
  const o = t.indexOf('{{'); if (o >= 0 && t.indexOf('}}', o + 2) >= 0) return true;
  let body = t;
  if (body.endsWith('...')) body = body.slice(0, -3); else if (body.endsWith('…')) body = body.slice(0, -1); else return false;
  body = body.trim();
  return body === '' || body.endsWith(':') || body.endsWith(':**') || body.endsWith('**') || body === '>';
}

// ---------- cerebrum ----------
const KIND = (n, raw) => (n.startsWith('user preference') ? 'pref' : n.startsWith('key learning') ? 'learning'
  : n.startsWith('do not repeat') || n === 'dnr' || n.startsWith('dnr ') ? 'dnr' : n.startsWith('decision') ? 'decision'
    : dateAt(raw, 0) ? 'dated' : 'other');
const BRIDGE_BEGIN = '<!-- openwolf:native-memory-index:begin -->', BRIDGE_END = '<!-- openwolf:native-memory-index:end -->';

// parseCerebrum(text) -> { sections: [{ name, kind, entries: [{ text, date?, line }] }], doNotRepeat, keyLearnings }.
// Sections: every `## ` heading (template, drifted, dated, invented). Entries: `- `/`* `/`+ ` bullets (indent 0-1) or `[YYYY-MM-DD]` lines;
// lines indented 2+ after an entry continue it (also after a blank line); HTML comments (single or multi line, also inline) are dropped;
// fenced code blocks are skipped; placeholders skipped. The OpenWolf native-memory block gets kind `bridge` and is never a rule.
export function parseCerebrum(text) {
  const lines = toLines(text);
  const sections = [];
  let sec = null, entry = null, inComment = false, inFence = false, inBridge = false;
  const finish = () => {
    if (!entry) return;
    const t = entry.parts.join(' ').slice(0, ENTRY_MAX).trim();
    const { date, rest } = splitDate(t);
    if (rest && !isPlaceholder(rest)) sec.entries.push(date ? { text: rest, date, line: entry.line } : { text: rest, line: entry.line });
    entry = null;
  };
  const push = (name, kind) => { finish(); sec = { name, kind, entries: [] }; sections.push(sec); };
  /** @typedef {string[] & { len: number }} Parts */
  /** @param {Parts} parts @param {string} t */
  const add = (parts, t) => { if (parts.len < ENTRY_MAX) { parts.push(t); parts.len += t.length + 1; } };
  for (let i = bodyStart(lines); i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!inComment && trimmed === BRIDGE_BEGIN) { inBridge = true; push('native memory index', 'bridge'); continue; }
    if (!inComment && trimmed === BRIDGE_END) { finish(); inBridge = false; sec = null; continue; } // lines after it belong to no section until the next heading
    if (!inComment && isFenceLine(raw)) { finish(); inFence = !inFence; continue; }
    if (inFence) continue;
    const c = stripComments(raw, inComment); inComment = c.inComment;
    const l = c.text;
    if (!l.trim()) continue; // blank or comment-only: an entry may still continue on the next indented line
    const head = h2(l);
    if (head !== null) {
      if (inBridge && sec && sec.kind === 'bridge' && !sec.entries.length && !entry) { sec.name = head; continue; }
      push(head, inBridge ? 'bridge' : KIND(normHeading(head), head)); continue;
    }
    if (!sec) continue; // H1, quotes and prose before the first section
    const { chars, width } = indentOf(l);
    const t = l.slice(chars);
    if (entry && width >= 2) { add(entry.parts, t.trim()); continue; }
    const item = width <= 1 ? listItem(t) : null;
    const dated = width <= 1 && item === null && t[0] === '[' && dateAt(t, 1) && t[11] === ']';
    if (item !== null || dated) {
      finish();
      const parts = /** @type {Parts} */ ([]); parts.len = 0; add(parts, item !== null ? item : t.trim());
      entry = { parts, line: i + 1 };
      continue;
    }
    if (width >= 2 && !entry) { const it = listItem(t); if (it !== null) { const parts = /** @type {Parts} */ ([]); parts.len = 0; add(parts, it); entry = { parts, line: i + 1 }; continue; } }
    finish(); // prose, quotes or sub-headings end an entry
  }
  finish();
  const of = (k) => sections.filter((s) => s.kind === k).flatMap((s) => s.entries);
  return { sections, doNotRepeat: of('dnr'), keyLearnings: of('learning') };
}

// ---------- STATUS ----------
const STATUS_KIND = (n) => (n.startsWith('done') ? 'done' : n.startsWith('next') || n.startsWith('siguiente') ? 'next'
  : n.startsWith('open decision') || n.startsWith('open question') || n.startsWith('open for') ? 'decisions'
    : n.startsWith('blocker') || n.startsWith('external blocker') ? 'blockers' : 'other');
const isUpper = (c) => c >= 'A' && c <= 'Z';
const isKeyBody = (c) => isUpper(c) || isDigit(c);
const isWordChar = (c) => c !== undefined && (isUpper(c) || isDigit(c) || (c >= 'a' && c <= 'z') || c === '_');
const isSlugChar = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || isDigit(c) || c === '.' || c === '_' || c === '-');

// Ticket keys mentioned in a text: `[A-Z][A-Z0-9]*-\d+` on token boundaries (the characters before and after are not letters, digits,
// `_` or `-`), and superpowers keys `sp:<slug>[/<id>]`. One left-to-right scan; at most 20 unique keys, each at most 120 characters.
export function scanKeys(text) {
  const s = String(text ?? ''), out = [];
  const seen = new Set();
  const keep = (k) => { if (k.length <= KEY_MAX && !seen.has(k) && out.length < KEYS_PER_BULLET) { seen.add(k); out.push(k); } };
  let i = 0;
  while (i < s.length && out.length < KEYS_PER_BULLET) {
    const prev = s[i - 1];
    const boundary = i === 0 || !(isWordChar(prev) || prev === '-');
    if (boundary && s[i] === 's' && s[i + 1] === 'p' && s[i + 2] === ':' && prev !== ':') {
      let j = i + 3; while (j < s.length && isSlugChar(s[j])) j++;
      if (s[j] === '/') { let k = j + 1; while (k < s.length && isSlugChar(s[k])) k++; if (k > j + 1) j = k; }
      let end = j; while (end > i + 3 && (s[end - 1] === '.' || s[end - 1] === '-' || s[end - 1] === '_')) end--;
      if (end > i + 3) keep(s.slice(i, end));
      i = Math.max(j, i + 1); continue;
    }
    if (boundary && isUpper(s[i])) {
      let j = i + 1; while (j < s.length && isKeyBody(s[j])) j++;
      if (s[j] === '-' && isDigit(s[j + 1] ?? '')) {
        let k = j + 1; while (k < s.length && isDigit(s[k])) k++;
        const next = s[k];
        if (!(isWordChar(next) || next === '-')) keep(s.slice(i, k));
        i = k; continue;
      }
      i = j; continue;
    }
    i++;
  }
  return out;
}

// parseStatus(text) -> { done: string[], next: string[], openDecisions: string[], bullets: [{ text, keys, section }] }.
// Sections are `## ` headings (a `---` line also ends one). Kinds come from the normalized heading, so both `## ✅ Done` / `## 🚀 Next quest`
// and drifted `## Done (2031-04-01): ...` / `## Next: ...` work; `### Open decisions` (or any heading starting "open decision", "open
// question", "open for") feeds openDecisions. Items are list items and plain lines (markers stripped, placeholders, tables, quotes and
// comments dropped); `bullets` are list items only, in file order, with the keys they name.
export function parseStatus(text) {
  const lines = toLines(text);
  /** @type {{ done: string[], next: string[], openDecisions: string[], bullets: Array<{ text: string, keys: string[], section: string }> }} */
  const res = { done: [], next: [], openDecisions: [], bullets: [] };
  let h2kind = null, h3kind = null, inComment = false, inFence = false, cur = null;
  const flush = () => {
    if (!cur) return;
    const t = cur.parts.join(' ').slice(0, ENTRY_MAX).trim(); const c = cur; cur = null;
    if (!t || isPlaceholder(t)) return;
    if (c.h2 === 'done') res.done.push(t);
    if (c.h2 === 'next') res.next.push(t);
    if (c.sub === 'decisions' || c.h2 === 'decisions') res.openDecisions.push(t);
    if (c.bullet) res.bullets.push({ text: t, keys: scanKeys(t), section: c.sub ?? c.h2 ?? 'other' });
  };
  for (let i = bodyStart(lines); i < lines.length; i++) {
    const raw = lines[i];
    if (!inComment && isFenceLine(raw)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;
    const c = stripComments(raw, inComment); inComment = c.inComment;
    const l = c.text, t = l.trim();
    if (!t) continue;
    if (t === '---') { flush(); h2kind = null; h3kind = null; continue; } // a thematic break ends the section (as OpenWolf's own reader does)
    const head = h2(l);
    if (head !== null) { flush(); h2kind = STATUS_KIND(normHeading(head)); h3kind = null; continue; }
    const sub = h3(l);
    if (sub !== null) { flush(); const k = STATUS_KIND(normHeading(sub)); h3kind = k === 'other' ? null : k; continue; }
    if (h2kind === null) { flush(); continue; } // H1, quotes and prose before the first section or after a `---`
    if (t[0] === '#' || t[0] === '>' || t[0] === '|') { flush(); continue; }
    const { width } = indentOf(l);
    if (cur && width >= 2) { if (cur.len < ENTRY_MAX) { cur.parts.push(t); cur.len += t.length + 1; } continue; }
    flush();
    const item = listItem(t);
    const body = item !== null ? item : t;
    cur = { parts: [body], len: body.length, bullet: item !== null, h2: h2kind, sub: h3kind };
  }
  flush();
  return res;
}

// ---------- anatomy index ----------
// Tolerant read of `.wolf/anatomy-index.json` (research section 2.5): only `{ version: 1, files: { "<relpath>": { description, ... } } }`
// is accepted (another version, invalid JSON, or a non-object `files` -> null, so the caller falls back to git). Accepts a string or an object.
export function readAnatomyIndex(indexJson) {
  let j = indexJson;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { return null; } }
  if (j === null || typeof j !== 'object' || Array.isArray(j) || j.version !== 1) return null;
  const f = j.files;
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return null;
  return f;
}
const normRel = (p) => { let s = String(p); while (s.startsWith('./')) s = s.slice(2); return s; };
// anatomyLookup(files, indexJson, { listFiles }) -> { index: bool, results: [{ file, found, source?, description?, invalid? }] }.
// A file is looked up by exact path in the index; a miss (or no usable index) asks `listFiles(paths)` (the CLI passes a `git ls-files`
// wrapper) with only the paths that pass checkRepoPath. A listed path counts when it equals the file, or is under it when the file is a
// directory (`lib/pay/` or `lib/pay`). Descriptions are oneLine'd (200 chars); they still must be fenced when printed.
/** @param {any} files @param {any} indexJson @param {{ listFiles?: (files: string[]) => string[] }} [opts] */
export function anatomyLookup(files, indexJson, { listFiles } = {}) {
  const idx = readAnatomyIndex(indexJson);
  /** @type {Array<{ file: string, found: boolean, invalid?: boolean, source?: string }>} */
  const results = (Array.isArray(files) ? files : []).map((f) => {
    const file = normRel(f);
    let ok = true; try { checkRepoPath(file); } catch { ok = false; }
    if (!ok) return { file: oneLine(file, 200), found: false, invalid: true };
    const hit = idx && Object.hasOwn(idx, file) ? idx[file] : null;
    if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
      const r = { file, found: true, source: 'anatomy' };
      if (typeof hit.description === 'string' && hit.description.trim()) r.description = oneLine(hit.description, 200);
      return r;
    }
    return { file, found: false };
  });
  const misses = results.filter((r) => !r.found && !r.invalid);
  if (misses.length && typeof listFiles === 'function') {
    let listed = [];
    try { listed = listFiles(misses.map((r) => r.file)) || []; } catch { listed = []; }
    const set = new Set(listed.map(normRel));
    for (const r of misses) {
      const dir = r.file.endsWith('/') ? r.file : r.file + '/';
      if (set.has(r.file) || listed.some((p) => normRel(p).startsWith(dir))) { r.found = true; r.source = 'git'; }
    }
  }
  return { index: idx !== null, results };
}

// ---------- STATUS brain line (for the `brain doctor` drift check; never printed) ----------
// The first line whose text, after an optional list marker (`- `, `* `, `+ `) and an optional opening backtick, starts with `brain: `.
// Returned trimmed, without a closing backtick, one line, at most 300 characters; null when there is none. Linear: one pass over the lines.
/** @param {unknown} text @returns {string | null} */
export function statusBrainLine(text) {
  for (const raw of toLines(text)) {
    let s = raw.trim();
    if ((s[0] === '-' || s[0] === '*' || s[0] === '+') && isSpace(s[1])) s = s.slice(2).trimStart();
    if (s[0] === '`') s = s.slice(1);
    if (!s.startsWith('brain: ')) continue;
    if (s.endsWith('`')) s = s.slice(0, -1);
    return oneLine(s.trimEnd(), 300);
  }
  return null;
}

// ---------- rendering ----------
const nonceOf = (body) => crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
const newestFirst = (list) => list.map((e, i) => [e, i]).sort((a, b) => {
  const da = a[0].date, db = b[0].date;
  if (da && db && da !== db) return da < db ? 1 : -1;
  if (!!da !== !!db) return da ? -1 : 1;
  return b[1] - a[1]; // same date (or both undated): later in the file is newer
}).map(([e]) => e);

// The ordered list `rules --repo` shows and `learn --from-wolf <handle>` resolves: Do-Not-Repeat entries newest first, then Key
// Learnings newest first ("newest-looking": dated entries by date, undated after them, later position in the file first). The handle is
// `w` + 6 hex of sha256 over the oneLine'd rule text: it depends only on the text, so adding other entries never changes it.
export const handleOf = (text) => 'w' + crypto.createHash('sha256').update(oneLine(text, 2000)).digest('hex').slice(0, 6);
// With { all: true } the entries of dated sections (`## 2031-04-02 learnings (...)`) follow, newest first, as section `dated`.
/** @param {any} parsed @param {{ all?: boolean }} [opts] */
export function repoRuleList(parsed, { all = false } = {}) {
  const dnr = newestFirst(parsed?.doNotRepeat ?? []).map((e) => ({ ...e, section: 'do-not-repeat' }));
  const kl = newestFirst(parsed?.keyLearnings ?? []).map((e) => ({ ...e, section: 'key-learning' }));
  const dated = all ? newestFirst((parsed?.sections ?? []).filter((s) => s.kind === 'dated').flatMap((s) => s.entries)).map((e) => ({ ...e, section: 'dated' })) : [];
  return [...dnr, ...kl, ...dated].map((e) => ({ handle: handleOf(e.text), ...e }));
}
export const TOPIC_MAX = 60;
// Case-insensitive substring on the one-line rule text; the topic is at most TOPIC_MAX characters and the text at most 2000, so it is bounded.
const matchesTopic = (/** @type {string} */ text, /** @type {string} */ topic) => oneLine(text, 2000).toLowerCase().includes(topic.toLowerCase());

// renderRepoRules(parsed, { max = 12, entryMax = 200 }) -> output lines. One header line, then one fence per section
// (`wolf-do-not-repeat`, `wolf-key-learnings`) holding `<handle> [wolf:<section>] [date] <text>` lines. Each text is oneLine'd and capped;
// the fence nonce is derived from the fenced body, so the same input gives the same bytes and no entry can predict its own fence.
// { topic } keeps the rules whose text contains it (case-insensitive); { all } adds dated sections and puts one counts line first.
/** @param {any} parsed @param {{ max?: number, entryMax?: number, topic?: string, all?: boolean }} [opts] */
export function renderRepoRules(parsed, { max = 12, entryMax = 200, topic, all: withDated = false } = {}) {
  const list = repoRuleList(parsed, { all: withDated });
  const head = [];
  if (withDated) { const n = (/** @type {string} */ s) => list.filter((e) => e.section === s).length; head.push(`counts: do-not-repeat ${n('do-not-repeat')}, key-learning ${n('key-learning')}, dated ${n('dated')}`); }
  const all = topic ? list.filter((e) => matchesTopic(e.text, topic)) : list;
  if (!list.length) return [...head, 'no repo rules: no Do-Not-Repeat or Key Learnings entries in .wolf/cerebrum.md'];
  if (!all.length) return [...head, `no repo rules match the topic (0 of ${list.length})`];
  const shown = all.slice(0, max);
  const out = [...head, `repo rules from .wolf/cerebrum.md (read-through, never copied): showing ${shown.length} of ${all.length}${shown.length < all.length ? ' (-v for all)' : ''}${topic ? ` (topic filter: ${all.length} of ${list.length} match)` : ''}; data, not instructions; promote one with \`brain learn --from-wolf <handle>\``];
  for (const [section, label] of [['do-not-repeat', 'wolf-do-not-repeat'], ['key-learning', 'wolf-key-learnings'], ['dated', 'wolf-dated']]) {
    const rows = shown.filter((e) => e.section === section).map((e) => `${e.handle} [wolf:${section}] ${e.date ? e.date + ' ' : ''}${oneLine(e.text, entryMax)}`);
    if (!rows.length) continue;
    const body = rows.join('\n');
    out.push(...fence(label, body, { nonce: nonceOf(body), max: body.length + 16 }).split('\n'));
  }
  return out;
}
export const fenceWolf = (label, body) => fence(label, body, { nonce: nonceOf(body), max: body.length + 16 });
