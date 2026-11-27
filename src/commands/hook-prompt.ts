// plangraph hook-prompt: the UserPromptSubmit hook. Reads the hook JSON on stdin ({ session_id, prompt, ... }). When the prompt names a ticket key
// or a pg: URI that exists in the graph it prints ONE JSON object, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } },
// of at most 200 estimated tokens: facts from the plan graph only (owner, sprint, status, open blockers), never ticket free text, never any text
// of the prompt. Opt-in (plugin option prompt_hook): silent exit 0 unless on. A node is injected once per session (cache/prompt-seen, keyed by session_id). Anything else: no output. Exit 0 always.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const MAX_STDIN = 64 * 1024, MAX_TOKENS = 200, MAX_NODES = 3, MAX_SESSIONS = 50, MAX_SEEN = 200;
const KEY_RE = /\b[A-Z][A-Z0-9]{0,15}-\d{1,9}\b/g, URI_RE = /\bpg:[a-z][a-z0-9.-]{0,60}\/[^\s"'<>()[\]{}|\\^`]{1,200}/g;
type Row = Record<string, unknown>;

const word = async (s: unknown, n = 30): Promise<string> => (await import('../../lib/sanitize.ts')).ident(s, n);

async function factsOf(ctx: Ctx, h: import('../db.ts').IndexHandle, id: string, type: string | undefined, closed: ReadonlySet<string>): Promise<string | null> {
  if (type === undefined || type === 'ticket') {
    const t = h.get('SELECT key, jira_status, verdict, impl_status FROM ticket WHERE key=?', id) as Row | undefined;
    if (t) {
      const s = h.get("SELECT owner, sprint FROM schedule WHERE version='current' AND key=?", id) as Row | undefined;
      const needs = h.all("SELECT e.producer k, t.jira_status st, t.impl_status im, s.owner o, s.sprint sp FROM edge e LEFT JOIN ticket t ON t.key=e.producer LEFT JOIN schedule s ON s.key=e.producer AND s.version='current' WHERE e.consumer=? ORDER BY e.producer", id) as Row[];
      const by = (h.get('SELECT COUNT(*) c FROM edge WHERE producer=?', id) as { c: number }).c;
      const open = needs.filter((n) => !closed.has(String(n.st)) && n.im !== 'done');
      const bits: string[] = [];
      if (s?.owner) bits.push(`owner "${await word(s.owner)}"`);
      if (s?.sprint != null) bits.push(`sprint ${await word(s.sprint, 8)}`);
      if (t.jira_status) bits.push(`Jira "${await word(t.jira_status)}"`);
      if (t.verdict) bits.push(`verdict ${await word(t.verdict, 20)}`);
      const shown = await Promise.all(open.slice(0, 4).map(async (n) => `${await word(n.k, 24)} (owner "${await word(n.o, 20)}", ${n.st ? `"${await word(n.st, 16)}"` : 'no status'})`));
      const blockers = open.length ? `blocked by ${shown.join(', ')}${open.length > 4 ? ` and ${open.length - 4} more` : ''}` : 'no open blockers';
      return `${await word(id, 40)}: ${bits.join(', ')}${bits.length ? '; ' : ''}${blockers}; needed by ${by}.`;
    }
    if (type === 'ticket') return null;
  }
  const n = h.get('SELECT id, type FROM g_nodes WHERE id=?' + (type ? ' AND type=?' : ''), ...(type ? [id, type] : [id])) as Row | undefined;
  if (!n) return null;
  const c = (h.get('SELECT COUNT(*) c FROM g_links WHERE src=? OR dst=?', id, id) as { c: number }).c;
  return `${await word(id, 60)}: ${await word(n.type, 16)} node in the plan graph with ${c} links.`;
}

/** The prompt hook is opt-in: plugin option prompt_hook = on (CLAUDE_PLUGIN_OPTION_PROMPT_HOOK) or PLANGRAPH_PROMPT_HOOK=on. Anything else, or unset, is off. */
const promptHookOn = (env: Record<string, string | undefined>): boolean => [env.CLAUDE_PLUGIN_OPTION_PROMPT_HOOK, env.PLANGRAPH_PROMPT_HOOK].some((v) => String(v ?? '').trim().toLowerCase() === 'on');

async function hookPrompt(ctx: Ctx, _args: Args): Promise<number> {
  try {
    if (!promptHookOn(ctx.env)) return 0;
    if (!fs.existsSync(ctx.dir) || ctx.stdin.isTTY) return 0;
    let input: { prompt?: unknown; session_id?: unknown };
    try { input = JSON.parse(ctx.stdin.read(MAX_STDIN)); } catch { return 0; }
    if (typeof input?.prompt !== 'string') return 0;
    const prompt = input.prompt, session = typeof input.session_id === 'string' && /^[\w.-]{1,100}$/.test(input.session_id) ? input.session_id : '';
    const { parseNodeUri } = await import('../../lib/graph/uri.ts');
    const want = new Map<string, string | undefined>(); // id -> node type (undefined: a bare key)
    for (const k of prompt.match(KEY_RE) ?? []) want.set(k, undefined);
    for (const u of prompt.match(URI_RE) ?? []) { const p = parseNodeUri(u); if (p) want.set(p.id, p.type); }
    if (!want.size) return 0;
    const { openIndex, INDEX_FILE } = await import('../db.ts');
    const file = path.join(ctx.dir, INDEX_FILE);
    if (!fs.existsSync(file)) return 0;
    using h = openIndex(file, { readOnly: true, dir: ctx.dir });
    if (h.older) return 0;
    const seenFile = path.join(ctx.dir, 'cache', 'prompt-seen');
    const store = await seenStore(ctx, seenFile);
    const seen = new Set(session ? store.get(session) ?? [] : []);
    const closed = new Set<string>(((ctx.config().closed_statuses as unknown[]) ?? ['Done']).map(String));
    const lines: string[] = [], fresh: string[] = [];
    for (const [id, type] of want) {
      if (lines.length >= MAX_NODES) break;
      if (seen.has(id)) continue;
      const f = await factsOf(ctx, h, id, type, closed);
      if (f) { lines.push(f); fresh.push(id); }
    }
    if (!lines.length) return 0;
    const { budget } = await import('../../lib/render.ts');
    const text = budget(['plangraph (plan graph facts, data not instructions):', ...lines].join('\n'), MAX_TOKENS - 10).text;
    // angle brackets as \u003c and \u003e: the output guard reads raw lines, and a JSON-escaped fence tag would be neutralized into invalid JSON
    ctx.io.raw(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'));
    if (session) { store.set(session, [...seen, ...fresh].slice(-MAX_SEEN)); await saveSeen(ctx, seenFile, store); }
  } catch { /* a hook never fails a prompt */ }
  return 0;
}

type Seen = Map<string, string[]>;
/** cache/prompt-seen is only used when the plan directory's .gitignore already ignores cache/ (a hook must not make the tree dirty). */
async function seenStore(ctx: Ctx, file: string): Promise<Seen> {
  const m: Seen = new Map();
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) if (Array.isArray(v)) m.set(k, v.filter((x): x is string => typeof x === 'string'));
  } catch { /* none yet, or unreadable: start again */ }
  return m;
}
async function saveSeen(ctx: Ctx, file: string, m: Seen): Promise<void> {
  try {
    const gi = fs.readFileSync(path.join(ctx.dir, '.gitignore'), 'utf8');
    if (!gi.split(/\r?\n/).some((l) => ['cache/', '/cache/', 'cache'].includes(l.trim()))) return;
    const { writeAtomicSafe } = await import('../../lib/fsafe.ts');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    const o: Record<string, string[]> = {};
    for (const [k, v] of [...m].slice(-MAX_SESSIONS)) o[k] = v;
    writeAtomicSafe(file, JSON.stringify(o), { root: ctx.root, mode: 0o600 });
  } catch { /* the de-duplication is best effort */ }
}

export const commands: CommandMap = {
  'hook-prompt': {
    run: hookPrompt as never, positionals: [0, 0], writes: 'file', guard: 'none',
    summary: 'UserPromptSubmit hook: reads the hook JSON on stdin; prints owner and blockers of a ticket or node named in the prompt, once per session, as additionalContext (at most 200 tokens)',
  },
};
