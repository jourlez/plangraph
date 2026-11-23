// Parse a `claude -p --output-format stream-json --verbose` trace (also the native harness's kept traces): the tool calls with their
// outcome (ran, denied by the permission mode, brain not found = exit 127), the final message, cost, turns and tokens from the result
// event, and whether the plugin was actually used (a brain call that ran; plugin skills and the SessionStart card, seen in hook events
// with --include-hook-events, are listed apart). Pure: no I/O; never throws on a bad line.
import { SKILLS } from './schema.mjs';

const BRAIN_CALL = /(?:^|[\s;&|(`])(?:node\s+)?(?:\S*\/)?brain(?:\s|$)/m;
const NOT_FOUND = /command not found: brain|brain: (?:command )?not found|no such file or directory[^\n]*brain|exit code 127/i;
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');
const PLUGIN_SKILL = new RegExp(`^(?:project-brain:)?(?:${SKILLS.join('|')})$`);
// The grader input of a tool call: Bash -> the command (what input_match patterns are written against), anything else -> its JSON.
export const callInput = (tool, input) => (tool === 'Bash' && input && typeof input.command === 'string' ? input.command : JSON.stringify(input ?? {}));

/** Parse a stream-json trace into what the graders and the report need. Never throws on a bad line. */
export function parseTrace(text) {
  const calls = [], byId = new Map();
  let init = null, result = null, lastText = '', card = false;
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    if (j.type === 'system' && j.subtype === 'init') init = { model: j.model, version: j.claude_code_version, plugins: (j.plugins || []).map((p) => p && p.name).filter(Boolean), skills: j.skills || [], tools: j.tools || [], permissionMode: j.permissionMode, mcp: (j.mcp_servers || []).length };
    else if (j.type === 'system' && j.subtype === 'hook_response' && j.hook_event === 'SessionStart' && j.exit_code === 0 && /^brain\b/m.test(String(j.stdout ?? j.output ?? ''))) card = true;
    else if (j.type === 'system' && j.subtype === 'permission_denied') { const c = byId.get(j.tool_use_id); if (c) c.denied = true; }
    else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      let t = '';
      for (const b of j.message.content) {
        if (b && b.type === 'tool_use') { const c = { id: b.id, tool: b.name, input: callInput(b.name, b.input), raw: b.input ?? {}, parent: j.parent_tool_use_id ?? null, denied: false, ran: false, error: null, notFound: false }; calls.push(c); byId.set(b.id, c); }
        else if (b && b.type === 'text' && typeof b.text === 'string' && !j.parent_tool_use_id) t += b.text;
      }
      if (t) lastText = t;
    } else if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const c = byId.get(b.tool_use_id); if (!c) continue;
        const out = textOf(b.content);
        c.error = !!b.is_error;
        if (/^Permission to use \w+ (?:with [^\n]* )?has been denied|don't ask mode/i.test(out)) c.denied = true;
        c.notFound = NOT_FOUND.test(out);
        c.ran = !c.denied;
      }
    } else if (j.type === 'result') result = j;
  }
  const u = (result && result.usage) || {};
  const tokens = result ? ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((s, k) => s + (Number.isFinite(u[k]) ? u[k] : 0), 0) : null;
  const brain = calls.filter((c) => c.tool === 'Bash' && BRAIN_CALL.test(c.input));
  const skills = calls.filter((c) => c.tool === 'Skill').map((c) => String(c.raw.skill ?? ''));
  return {
    init, calls,
    message: result && typeof result.result === 'string' ? result.result : lastText,
    result: result ? { cost: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null, turns: Number.isFinite(result.num_turns) ? result.num_turns : null, tokens, usage: u, isError: !!result.is_error, subtype: result.subtype ?? null, durationMs: result.duration_ms ?? null } : null,
    denials: calls.filter((c) => c.denied).length,
    plugin: { brainCalls: brain.length, brainRan: brain.filter((c) => c.ran && !c.notFound).length, brainNotFound: brain.filter((c) => c.notFound).length, skills: skills.filter((s) => PLUGIN_SKILL.test(s)), card, toolCalls: calls.length, loaded: !!(init && init.plugins.includes('project-brain')) },
  };
}
// A plugin-arm run counts as plugin evidence only when the plugin's CLI did work: a brain call that ran (not denied, not exit 127). A
// skill that fired but whose brain calls all failed (pilot #1: the skill loaded, bin/ was not on PATH) does not count; skills are
// reported separately (plugin.skills).
export const pluginUsed = (p) => p.brainRan > 0;
