// lib/jira/render.ts: issue text (ADF to text, the fenced issue view) and the changelog, both read through a verified client.
import { sanitizeText, fence, neutralizeTags } from '../sanitize.ts';
import { JiraError } from './error.ts';
import { str } from './snapshot.ts';
import { KEY_RE } from './types.ts';
import type { ChangelogClient, ChangelogEntry, IssueTextClient, RawAdf, RawComment, RawFields, RawHistory, RawIssue } from './types.ts';

export async function fetchChangelog(client: ChangelogClient, key: string): Promise<ChangelogEntry[]> {
  if (!KEY_RE.test(String(key))) throw new JiraError('bad_key', 'not a Jira issue key');
  await client.verify();
  return ((await client.changelog(key)) as RawHistory[]).map((h) => ({ id: str(h.id), created: str(h.created), author: str(h.author?.displayName), items: (h.items || []).map((x) => ({ field: str(x.field), from: str(x.fromString), to: str(x.toString) })) })); // entries unchecked: str() tests each leaf
}

// ---------------------------------------------------------------- issue text (ADF -> text)
// Same flattening as the previous bin/plangraph adf(); the only addition is a depth guard because the input is untrusted JSON.
// `content` must be an array (anything else is a JiraError bad_input, a data error), a heading level is clamped to 1..6 (default 2).
const contentOf = (n: RawAdf): Array<RawAdf | string> => {
  if (n.content == null) return [];
  if (!Array.isArray(n.content)) throw new JiraError('bad_input', 'issue text is not valid ADF: "content" must be an array');
  return n.content;
};
const headingLevel = (n: RawAdf): number => { const l = n.attrs && n.attrs.level; return Number.isInteger(l) ? Math.min(6, Math.max(1, l as number)) : 2; }; // Number.isInteger is the check
/** Plain text of an ADF document (untrusted JSON); a string passes through, anything deeper than 100 levels is dropped. */
export function adfToText(n: RawAdf | string | null | undefined, depth = 0): string {
  if (n == null || depth > 100) return ''; if (typeof n === 'string') return n;
  const kids = contentOf(n).map((c) => adfToText(c, depth + 1)).join('');
  switch (n.type) {
    case 'text': return (n.text as string) || ''; // as before: a non-string text is returned as is
    case 'hardBreak': return '\n';
    case 'paragraph': return kids + '\n\n';
    case 'heading': return '#'.repeat(headingLevel(n)) + ' ' + kids + '\n';
    case 'bulletList': case 'orderedList': return contentOf(n).map((li) => '- ' + adfToText(li, depth + 1).trim() + '\n').join('') + '\n';
    case 'codeBlock': return '```\n' + kids + '\n```\n';
    case 'mention': return '@' + ((n.attrs && n.attrs.text) || '');
    default: return kids;
  }
}
// Cut `s` to at most `n` chars without splitting a surrogate pair or a fence tag, and re-close any fence left open,
// so the result always has balanced <untrusted ...> / </untrusted> pairs (the closing tag is appended after the cut).
function cutFenced(s: string, n: number): string {
  if (n > 0 && /[\uD800-\uDBFF]/.test(s[n - 1] as string)) n--; // RegExp.test stringifies undefined, as before
  let t = s.slice(0, Math.max(0, n));
  const lt = t.lastIndexOf('<');
  if (lt >= 0) { const tail = t.slice(lt); if ('</untrusted>'.startsWith(tail) || '<untrusted '.startsWith(tail) || /^<untrusted [^>\n]*$/.test(tail)) t = t.slice(0, lt); }
  const opens = (t.match(/<untrusted /g) || []).length, closes = (t.match(/<\/untrusted>/g) || []).length;
  return opens > closes ? `${t}\n</untrusted>` : t;
}
/** The issue as fenced text for an agent to read. `j` is the untrusted issue JSON (`{ fields: ... }`). */
export function renderIssue(key: string, j: RawIssue | null | undefined, { maxChars = 30000 }: { maxChars?: number } = {}): string {
  const f: RawFields = (j && j.fields) || {}; const cs: RawComment[] = f.comment?.comments || [];
  key = sanitizeText(key, { max: 40 }).replace(/\s+/g, ' ').trim(); const src = `jira:${key}`;
  // header and list text is one line with every <untrusted tag neutralized (no forged closing tag); a fence always starts its own line
  const line = (v: unknown) => neutralizeTags(sanitizeText(v, { max: 300 }).replace(/\n+/g, ' '));
  const desc = adfToText(f.description).trim();
  const summary = line(f.summary || '');
  let out = `# ${key}\nStatus: ${line(f.status?.name || '')} | updated ${line(f.updated || '')}\n\n## Summary\n${summary ? fence('summary', summary, { src, max: 300 }) : '(empty)'}\n\n## Description\n${desc ? fence('description', desc, { src, max: maxChars }) : '(empty)'}\n\n## Comments (${cs.length})\n`;
  for (const c of cs) out += `- [${line(c.author?.displayName || 'unknown')}, ${line(c.created)}]:\n${fence('comment', adfToText(c.body).trim().replace(/\n+/g, ' '), { src, max: 5000 })}\n`;
  if (Number(f.comment?.total) > cs.length) out += `... ${((f.comment as { total: number }).total) - cs.length} more comments not fetched\n`; // Number(total) > length proves comment is set and total is numeric-coercible (not that it is a number)
  return out.length > maxChars ? `${cutFenced(out, maxChars)}\n... ${out.length - maxChars} more chars\n` : out;
}
export async function fetchIssueText(client: IssueTextClient, key: string, opts: { maxChars?: number } = {}): Promise<string> {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new JiraError('bad_key', 'not a Jira issue key (expected like ABC-123)');
  await client.verify();
  return renderIssue(key, await client.issue(key, ['summary', 'status', 'updated', 'description', 'comment']), opts);
}
