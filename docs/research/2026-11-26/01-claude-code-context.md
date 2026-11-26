# Claude Code context mechanisms, token economics, evidence (research 01)

Fetched 2026-11-26. Docs are live pages (undated; Claude Code version cues up to v2.1.304). Fetch tool summarizes pages; hooks and MCP pages were partly truncated (noted).

## 1. Mechanisms Claude Code offers

### CLAUDE.md, imports, rules, AGENTS.md
- CLAUDE.md is delivered as a user message after the system prompt, not system prompt; no strict-compliance guarantee. [verified: https://code.claude.com/docs/en/memory]
- Target under 200 lines per file; longer reduces adherence. Startup warning on oversize files and on combined size. Files over 4 MiB skipped. [verified: memory page above]
- `@path` imports expand into context with the importing file, max depth 4 hops; they organize but do NOT reduce cost. [verified: memory page]
- Block-level HTML comments are stripped before injection. [verified: memory page]
- Path-scoped rules (`.claude/rules/` with `paths:`) load only when matching files are touched. [verified: memory page]
- Project-root CLAUDE.md is re-injected from disk after compaction; nested CLAUDE.md and path rules reload on demand. [verified: https://code.claude.com/docs/en/context-window]
- AGENTS.md is read directly (v2.1.277+). [verified: memory page]
- A CLAUDE.md at a plugin root is NOT loaded as context; validator warns. Put instructions in a skill. [verified: https://code.claude.com/docs/en/plugins-reference]

### Auto memory
- First 200 lines or 25KB of `MEMORY.md` load at session start, per repository; re-injected after compaction. [verified: memory page; context-window page]
- Subagents do not inherit auto memory; they can have their own `memory:` dir with the same 200-line/25KB rule. [verified: https://code.claude.com/docs/en/sub-agents]

### Skills
- Descriptions sit in context always; body loads only on use. `description`+`when_to_use` truncated at 1,536 chars per skill in the listing. SKILL.md under 500 lines advised. [verified: https://code.claude.com/docs/en/skills]
- Once invoked, body stays in the conversation as one message across turns. After compaction: most recent invocation of each skill re-attached, first 5,000 tokens each, 25,000 shared; older dropped. [verified: skills page; context-window page]
- Frontmatter: `disable-model-invocation`, `paths` (glob activation), `context: fork` (subagent, no history). [verified: skills page]
- Skill descriptions are rebuilt and re-injected after compaction (v2.1.304+). [verified: context-window page]
- Fact I did not confirm: any "1% of context window" listing budget. [claimed/unverified]

### Hooks
- Events (partial list, page truncated): SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, PreCompact, PostCompact, SubagentStart/Stop, InstructionsLoaded, FileChanged, CwdChanged, Stop, others. [verified: https://code.claude.com/docs/en/hooks]
- SessionStart matchers: startup, resume, clear, compact, fork. Exit 0 plain stdout is added as context; `additionalContext` goes at the conversation start. Not blocking. Reruns on resume so it can refresh. [verified: hooks page]
- UserPromptSubmit: always fires, stdout/`additionalContext` added alongside the prompt; exit 2 blocks. [verified: hooks page]
- Cap: `additionalContext`, `systemMessage`, `initialUserMessage`, plain stdout each capped at 10,000 chars. Over cap: saved to a file; Claude gets path plus first 2,000 chars preview and is not told to read it. PreCompact stdout exempt. [verified: hooks page]
- Timeouts: command/http/mcp_tool default 600 s; 30 s on UserPromptSubmit and model-switch events; 10 s on MessageDisplay; SessionEnd shares a 1.5 s budget (max 60 s if raised). [verified: hooks page]
- PreCompact plain stdout becomes instructions for the compaction summary; exit 2 blocks compaction. [verified: hooks page]
- SessionStart hooks matching `compact` re-run and add output to compacted context. Context earlier hooks added is summarized with the conversation. [verified: context-window page]
- Docs advise writing `additionalContext` as factual statements; imperative system-style wording can trip prompt-injection defenses. [verified: hooks page]
- PreToolUse/PostToolUse `additionalContext` specifics: not read in my truncated fetch. [claimed/unverified]
- Hook output size shown in docs example: a Prettier PostToolUse hook adds ~100-120 tokens per edit. [verified: context-window page]

### MCP
- Spec: tools are model-controlled; resources are application-driven (host decides how to include); prompts are user-invoked. [verified: https://modelcontextprotocol.io/specification/2025-11-25/server/tools ; .../server/resources]
- Tool results: `content` blocks, optional `structuredContent` (+ serialized text copy SHOULD be included) with `outputSchema`; `resource_link` blocks let a tool return a URI instead of the data. Resource annotations: audience, priority 0-1, lastModified. [verified: tools spec]
- Claude Code: tool search is on by default; only tool names and server instructions load at session start, definitions deferred. `ENABLE_TOOL_SEARCH=auto` switches at 10% of window. Per-server `alwaysLoad: true` exempts. [verified: https://code.claude.com/docs/en/mcp]
- Server instructions and upfront tool descriptions cut at 4,096 chars; deferred tool descriptions at 16,384. [verified: mcp page]
- Output: warning when any MCP result exceeds 10,000 tokens; default max 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`); text over 50,000 chars saved to file unless the tool sets `_meta["anthropic/maxResultSizeChars"]` (ceiling 500,000). [verified: mcp page]
- Resources are reachable via `@` mentions (user action; stays plain text under `-p`). So resources do not auto-inject; the model cannot pull them unless a tool exposes them. [verified: mcp page for @ mentions; "model cannot pull" is my inference]
- Plugins can ship `.mcp.json`, `hooks/hooks.json`, skills, agents, `bin/` on PATH; `${CLAUDE_PLUGIN_DATA}` persists across updates (good home for SQLite index). [verified: plugins-reference]
- Plugin `alwaysLoad` honored for plugin-provided servers (v2.1.285+). [verified: mcp page]

### Subagents
- Fresh context; gets agent body, task message, full CLAUDE.md hierarchy (except Explore/Plan/web-fetch), preloaded `skills:` (full content), not auto memory or parent history. Summary-only return. Nesting up to 3 layers. Descriptions of custom subagents over ~15,000 tokens total trigger a warning. [verified: sub-agents page]
- Plugin subagents ignore `mcpServers` frontmatter. [verified: sub-agents page]

## 2. Token economics

- Context rot: recall falls as input grows, across models; attention is a finite budget. [verified: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents, 2025-09-29]
- Independent study (18 LLMs incl. Claude Sonnet 4): reliability degrades with length even on trivial tasks; semantic matching degrades more than lexical. [verified: https://research.trychroma.com/context-rot, 2025-07-14 via search summary]
- Lost in the Middle: U-shaped accuracy, best at start/end, worse in middle; drops with length. [verified: https://arxiv.org/abs/2307.03172, 2023, TACL 2024]. Models are older than current ones. [claimed/unverified for current models]
- Prompt caching: reads 0.1x base price (0.05x on Sonnet 5.5/Opus 5.5), 5-min write 1.25x, 1-h write 2x, 5-min TTL refreshed on use; min cacheable 512-4,096 tokens by model. Prefix order tools, system, messages. Tool-definition changes invalidate the whole cache. [verified: https://platform.claude.com/docs/en/build-with-claude/prompt-caching]
  - Implication: SessionStart output is early and stable, so it caches after turn 1; anything that changes per turn (UserPromptSubmit with volatile data) lands in messages and does not break the tools/system prefix. Changing MCP tool lists mid-session breaks cache. [inference from verified facts]
- Tool-definition cost: loading all definitions up front can mean hundreds of thousands of tokens at scale; code-as-API pattern cut an example from ~150,000 to ~2,000 tokens. [verified: https://www.anthropic.com/engineering/code-execution-with-mcp, 2025-11-04]
- Baseline session budget example: system prompt 4,200, MCP tool names 120, skill descriptions 450, project CLAUDE.md 1,800, auto memory 680 tokens before first prompt. Illustrative only. [verified: context-window page]
- How big can SessionStart be before it hurts: no official threshold. Hard cap 10,000 chars (~2.5k tokens). Docs say CLAUDE.md files over 200 lines reduce adherence. [verified: hooks and memory pages for caps; "hurts" threshold: claimed/unverified]
- Cost multipliers: agents ~4x chat tokens, multi-agent ~15x; token usage explained ~80% of variance on BrowseComp. [verified: https://www.anthropic.com/engineering/multi-agent-research-system, 2025-06-13]

## 3. Evidence on context files

- "Evaluating AGENTS.md" (Gloaguen et al., arXiv 2602.11988, 2026-02-12, ICLR 2026): LLM-generated and developer-written context files do not generally improve task success; inference cost up over 20% on average; agents follow the instructions (more exploring, testing); repo overviews do not help; useful for non-standard practices; keep requirements minimal. v1 abstract said "tend to reduce" success; the later version says "no improvement". [verified: https://arxiv.org/abs/2602.11988 ; versions difference via search summary]
- Counter-evidence: Lulla et al. (arXiv 2601.20404, v2 Mar 2026), 10 repos / 124 PRs, one agent (Codex): AGENTS.md associated with ~29% lower median runtime and ~17% fewer output tokens, comparable completion. Small sample, association only. [verified: https://arxiv.org/abs/2601.20404 via search summary]
- Reading across: context helps efficiency when it holds non-discoverable facts and hurts/neutral when it duplicates the repo. [inference; partially claimed in secondary posts, unverified]
- Repo maps: Aider ranks files by PageRank over a reference graph, fits to a token budget, caches by mtime. This is a design, not an efficacy study. [claimed/unverified: secondary summary via DeepWiki; I found no controlled benchmark of repo-map benefit]
- Anthropic's own guidance: keep context small and high-signal; agents hold lightweight references and load just-in-time; hybrid with some up-front data is often best. [verified: effective-context-engineering post]

## 4. Anthropic engineering best practices

- Building effective agents (2024-12-19): simplest solution first; invest in the agent-computer interface (tool docs, absolute paths, hard-to-misuse params). [verified: https://www.anthropic.com/engineering/building-effective-agents]
- Writing tools (2025-09-11): paginate/filter/truncate with sensible defaults and steering messages; concise vs detailed `response_format` (72 vs 206 tokens in example); natural-language identifiers beat UUIDs for precision; consolidate tools; namespace; actionable errors. [verified: https://www.anthropic.com/engineering/writing-tools-for-agents]
- Long-running agents (2025-11-26): progress file + JSON feature list + git history; startup routine reads progress and git log, picks next feature; JSON edited less destructively than Markdown. [verified: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents]
- Multi-agent (2025-06-13): subagents with own contexts return condensed results; lead saves plan to external memory; pass lightweight references; poor fit for tightly coupled coding work. [verified: multi-agent post]
- Context engineering (2025-09-29): compaction, structured note-taking, sub-agents returning 1-2k-token summaries, minimal tool set. [verified: effective-context-engineering post]

## Implications for a project-graph plugin

1. Do not rely on resources for auto-use; Claude Code surfaces them via user `@` mentions. Expose every read path also as a tool. [verified basis: mcp spec + mcp page]
2. SessionStart payload: keep to a few hundred tokens (hard cap 10,000 chars; over-cap is replaced by a 2,000-char preview and a file path). Send a digest (counts, active sprint, owner, blockers) plus pointers, never the graph. [verified basis: hooks page]
3. Use factual phrasing in `additionalContext`, not commands, to avoid injection defenses. [verified: hooks page]
4. Register the same hook for `compact` (and `resume`) so the digest survives compaction. Keep it byte-stable between runs for cache friendliness. [verified basis: hooks + context-window + caching pages]
5. Put routing in skill descriptions: first 1,536 chars, key trigger first; keep SKILL.md small; bodies are free until used. `disable-model-invocation` only for write/destructive flows. [verified: skills page]
6. Ship few, consolidated MCP tools with concise-by-default output and a `detailed` flag; stable names; server instructions under 4,096 chars; leave tool search on, `alwaysLoad` only for 1-2 hot tools. [verified: writing-tools post + mcp page]
7. Return human-readable ids (ticket keys, names) not UUIDs; add `structuredContent` plus a compact text copy; use `resource_link` for bulk detail. [verified: tools spec + writing-tools post]
8. Use UserPromptSubmit only for narrow, keyword-triggered injection (ticket-id match), emitting under ~200 tokens or nothing; it fires every prompt with a 30 s timeout. [verified basis: hooks page; the narrow-trigger advice is inference]
9. Do not ship a plugin-root CLAUDE.md; do not write generic repo overviews. Store only non-discoverable facts (owners, dependencies, decisions), per the AGENTS.md study's guidance. [verified: plugins-reference; arXiv 2602.11988]
10. Keep SQLite index in `${CLAUDE_PLUGIN_DATA}`, committed JSONL in the repo; stay within the 10 s-class hook latency for SessionStart by reading a prebuilt digest. Measure token overhead and task success with and without the plugin before claiming benefit; evidence on context files is mixed. [verified basis: plugins-reference, arXiv 2602.11988, 2601.20404]
