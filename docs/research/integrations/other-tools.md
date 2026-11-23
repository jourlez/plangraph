# open-brain and the other installed tools

Research date 2026-11-22. Scope: caveman, context7, gitkraken-hooks, and the hosted connectors (Atlassian, Slack, Artifacts / Claude Docs, Meetings, Google Drive). Every claim carries a tag:

- **VERIFIED-source (path)**: read in the installed plugin source.
- **VERIFIED-docs (URL)**: read in published docs.
- **VERIFIED-local**: measured or observed on this machine. Hook outputs were measured with `CLAUDE_CONFIG_DIR` / `HOME` pointed at a scratch directory and synthetic payloads, so no real config was touched.
- **UNVERIFIED**: inference, or a single weak source.

Plugin roots, abbreviated below:

- `CAVE` = `~/.claude/plugins/cache/caveman/caveman/0d95a81d35a9`
- `C7` = `~/.claude/plugins/cache/context7-marketplace/context7/1.0.2`
- `GKH` = `~/.claude/plugins/cache/gitkraken/gitkraken-hooks/3.1.79`

Token figures use the project rule `ceil(chars/4)`. Byte counts are used as an approximation for chars.

---

## 0. Detection evidence that applies to all tools

- **Install registry.** `~/.claude/plugins/installed_plugins.json` has the shape `{version, plugins: {"<name>@<marketplace>": [{scope, installPath, version, installedAt, lastUpdated, gitCommitSha?}]}}`. Present here: `caveman@caveman`, `context7@context7-marketplace`, `superpowers@superpowers-dev`, `gitkraken-hooks@gitkraken`, all `scope: user`. VERIFIED-local.
- **Enabled.** `~/.claude/settings.json` `enabledPlugins` maps the same keys to `true`. Project `.claude/settings.json` can add or override keys. VERIFIED-local.
- **Rule: "installed" is not "enabled".** Detection must require the key in the registry AND `enabledPlugins[key] === true` in user or project settings. A project-level `false` wins (UNVERIFIED precedence; this is the documented settings layering in general).
- **Pitfall found.** This repo's project settings enable `superpowers@superpowers-marketplace`, but the installed key is `superpowers@superpowers-dev`. VERIFIED-local. So a plugin can be "enabled" under a key that is not installed, and the reverse. Match on the part before `@` and report a mismatch; do not trust either file alone.
- **No `hooks` block in either settings file**, user or project. VERIFIED-local. Plugin hooks live in each plugin's own `plugin.json` or `hooks/hooks.json`.
- **OpenWolf hooks are not registered anywhere on this machine.** There are no hook entries in `~/.claude/settings.json` or the host project's `.claude/settings.json`, there is no `settings.local.json`, and `.wolf/` has no hooks directory. VERIFIED-local. Yet `.wolf/OPENWOLF.md` and `.claude/rules/openwolf.md` tell the model "the hooks handle bookkeeping". docs/REUSE.md row 1 relies on OpenWolf doing handoff bookkeeping automatically: here, nothing does.
- **Hosted connectors** are not visible from the filesystem. The only evidence is the tool names present in the session, which follow the pattern `mcp__claude_ai_<Server>__<tool>`. The `<Server>` segment is not stable across products: here it is `Atlassian_MCP`, not `Atlassian`, while the auth notice calls the same connector "claude.ai Atlassian". VERIFIED-local. Detection must therefore be an instruction to the agent with a glob, never an exact name.

---

## 1. caveman (version 0d95a81d35a9, plugin key `caveman@caveman`)

### What it shines at

- Cuts the model's prose output: "Cuts 65% of output tokens". VERIFIED-source (`CAVE/.claude-plugin/plugin.json`). The project's own `docs/HONEST-NUMBERS.md` exists; the measurement itself was not re-checked.
- Modes: `lite`, `full` (default), `ultra`, `wenyan-*`, plus the one-shot modes `commit`, `review`, `compress`. VERIFIED-source (`CAVE/skills/caveman/SKILL.md`, `src/hooks/caveman-mode-tracker.js`).
- Other pieces:
  - Statusline badge (`src/hooks/caveman-statusline.sh`).
  - `caveman-compress` rewrites prose files in place (below).
  - The cavecrew subagents (`agents/cavecrew-{investigator,builder,reviewer}.md`) return compressed results, so less text comes back into the main context.
  - `caveman-shrink` is an MCP stdio proxy that compresses tool *descriptions* only, and is opt-in (`src/mcp-servers/caveman-shrink/README.md`).

### What it injects (VERIFIED-source + VERIFIED-local)

- **SessionStart** (`src/hooks/caveman-activate.js`): plain stdout.
  - Content: "CAVEMAN MODE ACTIVE — level: full" plus the whole SKILL.md body, filtered to the active level.
  - Measured: **3,213 bytes (about 803 tokens)** with a statusLine configured.
  - Measured: **3,744 bytes (about 936 tokens)** without one. This user has no `statusLine`, so they pay the larger figure every session. The extra text is "STATUSLINE SETUP NEEDED ... Proactively offer to set this up for the user on first interaction", a standing nudge that competes with any first action, including brain's.
  - Side effects: writes `~/.claude/.caveman-active` (here it contains `full`) and appends to `.caveman-mode-log.jsonl`.
- **UserPromptSubmit** (`src/hooks/caveman-mode-tracker.js`): on *every* turn while active, emits `additionalContext`: "CAVEMAN MODE ACTIVE (full). Drop articles/filler/pleasantries/hedging. Fragments OK. Code/commits/security: write normal." That is about 120 chars, **about 30 tokens per turn**.
  - It also arms caveman from natural language. Any prompt matching `less tokens|fewer tokens|be brief|be terse|shorter answers` turns it on session-wide.
  - `/caveman-stats` blocks the prompt.

### What it changes about behavior

- "ACTIVE EVERY RESPONSE", drop articles, fragments OK, "no decorative tables/emoji", "no tool-call narration". VERIFIED-source (SKILL.md).
- **Boundaries** (what stays normal): only "Code/commits/PRs: write normal". The per-turn reminder says only "Code/commits/security".
- **Auto-Clarity** (when caveman drops itself): security warnings, irreversible confirmations, multi-step sequences where order could be misread, ambiguity, and when the user asks for clarity.
- Preserves the user's language: Spanish in, Spanish caveman out. Identifiers, commands and error strings stay verbatim.
- It never touches tool output. Bash stdout from `brain` reaches the model unchanged; caveman only shapes what the model writes.

### Detection

| Evidence | Cost | Reliability |
|---|---|---|
| `enabledPlugins["caveman@caveman"] === true` plus the registry entry | 1 JSON read | installed and enabled |
| `~/.claude/.caveman-active` exists, content in `{lite,full,ultra,wenyan*,commit,review,compress}` | 1 stat | **global, not per session.** One file per config dir, shared by concurrent sessions and rewritten by each. Use as a hint only. VERIFIED-source (`caveman-activate.js`, `caveman-config.js` `readFlag`) |
| `CAVEMAN_DEFAULT_MODE` env, `<repo>/.caveman/config.json` or `.caveman.json`, `~/.config/caveman/config.json` (`off` disables) | env + 3 stats | per project. VERIFIED-source (`src/hooks/caveman-config.js` header) |
| `caveman-init` artifacts in a repo: `.cursor/rules/caveman.mdc`, `.windsurf/rules/caveman.md`, `.opencode/AGENTS.md`, a block in `AGENTS.md` | stats | other IDE agents. VERIFIED-source (`src/tools/caveman-init.js`) |

### Interaction with open-brain

- **CLI output: already compatible, change nothing.** brain output is data on stdout, which caveman never rewrites. The CONTRACT (counts first, capped lists, no prose) already matches caveman's goal. Do **not** add a caveman-aware short mode: it would create a second output shape for zero gain and break determinism (CONTRACT rule 6).
- **Card: compatible.** The card is injected data; caveman does not compress it.
- **Real conflict 1: text written for other people.** caveman exempts only code, commits, PRs and security. These brain-driven outputs would come out in caveman style:
  - Slack open-items drafts to owners
  - Jira comments drafted for a person to post
  - Confluence, Artifact and Claude Docs report prose
  - `.wolf/STATUS.md` handoff text
  - learnings written to `learnings.jsonl`
  - auditor verdict reasons stored in `evidence.jsonl`

  Fragmentary Spanish to a teammate, or an article-free verdict reason that a later re-verifier must interpret, is a correctness risk, not only a style issue. "migrate table drop column backup first" is caveman's own example of compression creating ambiguity.

  **Fix:** add one line to `skills/brain/SKILL.md` and `skills/brain-audit/SKILL.md`: "Anything written for other people or stored in the brain (Slack and Jira drafts, reports, handoff, learnings, verdict reasons) is written in complete sentences, whatever style the chat uses." This works with caveman's own Auto-Clarity logic rather than fighting it.
- **Real conflict 2: `caveman-compress` on brain files.** It overwrites natural-language files (`.md`, `.txt`, extensionless) and leaves a `FILE.original.md` beside them. VERIFIED-source (`skills/caveman-compress/SKILL.md` lines 106-111).
  - `.jsonl` is not in its allow-list, so canonical data is safe.
  - `CARD.md` and `OPEN-ITEMS.md` in the brain dir are fair game. The next `brain card --write` silently undoes the compression, and a stray `CARD.original.md` is left in the brain directory.
  - **Fix:** have `brain doctor` flag `*.original.md` inside the brain dir. Mark generated markdown with a first-line `<!-- generated by brain; do not edit or compress -->`.
- **cavecrew in audits.** `cavecrew-investigator` is fine for "where is X" inside an audit unit. Its compressed output must not become evidence text or a verdict reason: the re-verifier and `brain stale` humans read that later. `brain-audit` should say: use cavecrew to locate, never to write verdicts.
- **Synergy.** caveman shortens what the model says *about* brain output. Together with "counts in chat, keys in files" this is the cheapest pairing. No brain change is needed beyond the boundary line.
- **Statusline.** There is one `statusLine` slot. If brain ever adds a statusline, it collides with caveman's. Do not add one, or document chaining.

---

## 2. context7 (1.0.2, key `context7@context7-marketplace`)

### What it shines at

- Current, version-specific library docs over a remote MCP. `C7/.mcp.json`: `{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"${CONTEXT7_API_KEY:-}"}}`. VERIFIED-source.
- Tools: `mcp__plugin_context7_context7__resolve-library-id` and `mcp__plugin_context7_context7__query-docs`. VERIFIED-local (session tool list).
- Skill `context7-mcp`: two steps (resolve, then query), "one topic per query". 2,693 B. VERIFIED-source (`C7/skills/context7-mcp/SKILL.md`).
- Agent `docs-researcher` (`model: sonnet`): fetches docs off the main context. 2,101 B. VERIFIED-source.
- Command `/context7:docs`. VERIFIED-source.

### What it injects

- **No hooks.** There are no `hooks` in the manifest. VERIFIED-source.
- Always-on cost:
  - The server's MCP instructions block. In this session it read "Use this server ... whenever the user asks about a library ... Use even when you think you know the answer". About 700 chars, **about 175 tokens**. VERIFIED-local (the session's MCP instructions).
  - Two skill descriptions in the skill list.
  - Tool schemas, which are deferred in this session until loaded.
- **Behavior change.** It pushes the model toward a docs lookup on any library mention, "even well-known ones".

### Detection

- `enabledPlugins["context7@context7-marketplace"]`.
- The `C7/.mcp.json` server name `context7`, which yields tools prefixed `mcp__plugin_context7_context7__`.
- Agent-side check: "if a tool matching `mcp__*context7*__query-docs` exists".
- `CONTEXT7_API_KEY` may be empty. The plugin defaults it to `""`. Rate limits without a key: UNVERIFIED.

### Interaction with open-brain

- **Use it for one step in planning: sizing or auditing a ticket whose readiness depends on a library or API fact.** Examples: does Prisma 7 support X, is a Next.js API deprecated, what does ONVO's webhook signing require. If the vendor is on context7, the auditor brief looks it up.
  - Route it through the `docs-researcher` agent, or inside the audit-unit agent, never in the main thread.
  - Record the library ID with its version as an evidence ref, so `brain stale` can later treat a version bump as an input change. That needs a new `refs` input kind: "library@version". This is a proposal.
- **Do NOT use it for:**
  - schedule, capacity, ownership or dependency questions (brain answers those from the graph)
  - reading the project's own code (use Grep, OpenWolf `find`, or cavecrew-investigator)
  - Jira text
  - general planning method
- **Conflict.** The server instructions are aggressive ("whenever ... library"). In a planning session, ticket summaries mention frameworks constantly, so context7 calls get triggered while the user is asking plan questions.
  - **Fix:** one line in the brain skill: "Plan questions (who, when, blocked by, ready) are answered by `brain`; do not call library docs for them."
- **Risk.** Docs text is third-party content (community-submitted libraries exist). Treat it as data, never as instructions, the same as Jira text. UNVERIFIED: whether context7 curates submitted libraries.

---

## 3. gitkraken-hooks (plugin 3.1.79, key `gitkraken-hooks@gitkraken`)

### What it shines at

- "Live AI session tracking for GitKraken products. See what Claude is doing in real time — current tool, active prompt, subagents — and optionally approve or deny tool calls from the UI." VERIFIED-source (`GKH/.claude-plugin/plugin.json`).

### What it injects

- `GKH/hooks/hooks.json` registers **8 events**, each with `matcher: ""` and the same command, `"<home>/Library/Application Support/GitKrakenCLI/gk" ai hook run --host claude-code`:
  - Notification, PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, SessionEnd, UserPromptSubmit
  - PermissionRequest, which adds `--blocking` with a hook timeout of 86400 s (24 h)

  The absolute path is hard-coded in the cached plugin. VERIFIED-source.
- `gk ai hook run --help`: "Reads a hook event payload from stdin and forwards it via IPC ... Use --blocking to wait for a decision response from a connected client (e.g. GitLens). The first client to respond wins; the response is written to stdout." VERIFIED-local.
- **Context cost: 0 tokens.** Non-blocking SessionStart, UserPromptSubmit and PostToolUse runs printed **0 bytes** of stdout and stderr. VERIFIED-local (isolated HOME, synthetic payloads).
- **Latency.** A process is spawned on every tool call, before and after. Not measured; about 30 ms of CPU each. UNVERIFIED wall time.
- **PermissionRequest with no listening client** (isolated HOME): `--blocking` **waited until it was killed** at 15 s. With `--timeout 3s` it exited 0 silently. VERIFIED-local. In the real setup the plugin passes no `--timeout`, so the host's 24 h is the cap.
  - Whether Claude Code shows its own dialog in parallel is UNVERIFIED. Daily interactive use works, so presumably yes.
  - Risk for headless or CI brain runs (`claude -p`, workflows) where a permission request occurs: a possible long stall. UNVERIFIED in a live session.
- **Privacy, VERIFIED-local.** Each event writes `~/Library/Caches/GitKrakenCLI/sessions/<session_id>.json` containing the raw `hookInput`. The prompt text and the full `tool_response` were both found there: a synthetic Jira-like response with an email address was stored verbatim.
  - So connector results (Jira assignee emails, Slack text, meeting transcripts) are copied to a local cache file outside Claude's control.
  - This machine's real cache dir has 45 entries.
  - Retention: `.last_prune` and `cleanup.stamp` exist; the policy is UNVERIFIED.

### Detection

- `enabledPlugins["gitkraken-hooks@gitkraken"]`.
- The binary symlink `~/Library/Application Support/GitKrakenCLI/gk` exists. It points to `versions/gk_3_1_80/gk_3_1_80`. VERIFIED-local.
- **Drift found:** the plugin is 3.1.79, the binary 3.1.80. VERIFIED-local.

### Interaction with open-brain

- **Git merge driver and `.gitattributes`: no direct interaction from the hooks.** They forward events and never run git. VERIFIED-source (only the command above).
- **Indirect risk from GitKraken Desktop.** If someone merges or rebases in GitKraken Desktop, custom merge drivers from `.gitattributes` may be ignored. A 2017 report says GitKraken "mostly uses its own built-in git along with its config" and ignored a custom driver ([mirror of SO 43386585](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/43386585/custom-merge-driver-not-working-in-gitkraken)). Current behavior is UNVERIFIED.
  - Consequence: JSONL conflicts that `brain-merge` would have resolved show up as conflict markers.
  - Mitigation: `brain build` already fails on unparsable JSONL (it must). `brain doctor` should detect conflict markers in brain files and print "merge in CLI git: `git merge` uses brain-merge; GUI clients may not". Recommend CLI merges for brain dirs in the README.
  - Note that `merge.<driver>.driver` lives in `.git/config`, is unversioned, and must be set in every clone. brain already warns about this (`lib/store.mjs` `doctorMergeDriver`). VERIFIED-source.
- **Hook stacking.** brain's SessionStart (`brain card --if-present`) runs alongside caveman's, superpowers' and gk's. Order between plugins is unspecified (UNVERIFIED). Do not rely on the card appearing first or last. brain's hook must stay idempotent, quick (its timeout is 10 s), and silent on error.
- **Do not** make brain depend on PermissionRequest approvals being answered quickly. Do not add brain hooks on PreToolUse/PostToolUse: gk already spawns twice per tool call.

---

## 4. Hosted connectors

Runtime naming: `mcp__claude_ai_<Server>__<tool>`. Server segments seen in this session (VERIFIED-local):

- `Atlassian_MCP`
- `Slack`
- `Google_Drive`
- `Meetings`
- `Claude_Docs`
- `Claude_Data`

Artifacts is not an MCP server. It is the harness's `Artifact` / `ArtifactData` / `ArtifactComments` tools. Source code cannot be read for any of these.

**Detection instruction for brain skills (copy verbatim):**

> Before a connector step, look at your tool list. Atlassian: a tool matching `mcp__*Atlassian*__getJiraIssue` or `mcp__*Atlassian*__searchJiraIssuesUsingJql`. Slack: `mcp__*Slack*__slack_send_message_draft`. Meetings: `mcp__*Meetings*__get_meeting_action_items`. Google Drive: `mcp__*Google_Drive*__read_file_content`. Claude Docs: `mcp__*Claude_Docs*__create`. Artifacts: a tool named `Artifact`. If a tool is listed only as deferred, load it with ToolSearch first. If none matches, use the fallback in the routing table and say which connector was missing.

The detection must match on the tool suffix, not an exact server segment: `Atlassian_MCP` versus `Atlassian` is real variance. VERIFIED-local.

### 4.1 Atlassian (Jira + Confluence, Rovo MCP)

**Shines at:** one ticket, small deltas, and every write (comment, transition, create, Confluence publish), with OAuth and no credential handling.

- Primary tools (VERIFIED-docs, https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/):
  - Common: `atlassianUserInfo`, `getAccessibleAtlassianResources`, `discover`, `executeRead/Write/Destructive`
  - Jira: `getJiraIssue`, `searchJiraIssuesUsingJql`, `listJiraIssueComments`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`
  - Confluence: `getConfluenceContent`, `createConfluenceContent`, `updateConfluenceContent`, `searchConfluence`
  - Other: `search`, Loom
- Everything else is reached through `discover`, then `execute*`.
- The tool set is filtered by credential scopes (VERIFIED-docs, https://support.atlassian.com/rovo/kb/rovo-mcp-server-only-returns-teamwork-graph-tools-when-using-api-token/).

**What the live schemas say** (VERIFIED-local, tool schemas in this session):

- `getJiraIssue` takes `view` (`compact|evidence|full`), `fields` (custom field IDs), `fieldsByKeys`, `expand`, `responseContentFormat`.
  - "View 'evidence' also returns the issue's links."
  - It has `additionalProperties: false` and **no `responseFields` parameter**. The server's own instructions say to "slim large responses with `responseFields`". That parameter evidently applies only to the `execute*` path. The instructions are inconsistent with the schema.
- `searchJiraIssuesUsingJql`: `maxResults` (max 100), `nextPageToken` paging until `isLast`.
  - Issue links require "full with minimal fields".
  - "custom field values map to issues[].fields.customFields". Per the server instructions, custom fields are not top-level `customfield_*` keys.

**Gap found in brain:** `lib/jira.mjs` `normalizeIssue` reads `f[sprintField]` and `f.assignee.displayName`. A connector result puts the sprint under `fields.customFields`, so `jira-import` would silently drop sprint data. VERIFIED-source for the brain code; connector shape VERIFIED-local from the server instructions; not tested against a real payload.

- **Fix:** fall back to `f.customFields?.[sprintField]`, and add a test fixture of that shape.

**Minimal request recipes** (these are recommendations):

- One ticket for readiness: `getJiraIssue({cloudId, issueIdOrKey, view:"evidence"})`. If links are not needed, use `view:"compact"`.
  - Measured in docs/REUSE.md: about 15,000 chars for a ticket with 22 links, even minimal, and the result includes the assignee email.
- Delta for import:

  ```
  searchJiraIssuesUsingJql({cloudId, jql:"<config.jql> AND updated >= -2d", view:"full", fields:["summary","status","assignee","updated","resolutiondate","issuelinks","<sprint customfield>"], maxResults:100})
  ```

  These fields are exactly what `normalizeIssue` consumes: `key`, `summary`, `status.name`, `assignee.displayName`, `updated`, `resolutiondate`, `issuelinks`, sprint. Request nothing else; descriptions belong to `jira-text` only.

**Keeping bulk work off the model context:**

1. Above roughly 20 tickets, prefer `brain jira-pull` (token CLI). Zero model tokens.
2. If no token is available, delegate the connector paging to a **subagent** whose brief is: page with the recipe above, write each page to a file in the scratchpad (the harness also saves large results to disk), run `brain jira-import <files> --out snapshot.jsonl`, and return only the one-line summary. The main context sees about 100 tokens. The subagent's own context still pays about 15k chars per link-heavy ticket, so cap it at a few hundred tickets.
3. Never print connector JSON in the main thread. Never paste it into a file by hand: `Write` would also push it through the model.

**Integration modes:**

| Data / action | Mode | Tool |
|---|---|---|
| status, assignee display name, updated, resolution, links, sprint | **ingest** via `jira-import` | `searchJiraIssuesUsingJql`, `getJiraIssue` |
| description, comments for audit | **read-through** into `jira-text`-like files fenced as `<untrusted>` (`lib/sanitize.mjs` `fence`) | `getJiraIssue` (`responseContentFormat: markdown`), `listJiraIssueComments` |
| assignee email, accountId, reporter details | **never touch** (drop on import; `normalizeIssue` already keeps only `displayName`, VERIFIED-source) | |
| comments, transitions, create, link edits | **recommend-only.** brain drafts, a person approves, the connector writes (brain never writes Jira; REUSE row 4) | `addOrEditJiraIssueComment`, `transitionJiraIssue`, `createJiraIssue`, `editJiraIssue` |
| publishing `brain report` to Confluence | **recommend-only** (person-approved write) | `createConfluenceContent` / `updateConfluenceContent` |
| `executeDestructive` | **never touch** from brain flows | |

### 4.2 Slack

**Shines at:** reaching people where they are; drafts that a person sends.

- `slack_send_message_draft` "Creates a draft message ... saved to the user's 'Drafts & Sent' in Slack without sending it". Only one attached draft per channel (`attached_draft_exists`). The `channel_id` for a DM is the user id from `slack_search_users`. VERIFIED-local (tool schema).
- The full Slack tool list in this session: `slack_search_*`, `slack_read_*`, `slack_send_message`, `slack_schedule_message`, `slack_create_canvas`, `slack_update_canvas`, `slack_read_user_profile`, and others. VERIFIED-local.
- Official docs list draft/format/preview as a feature without tool names, plus per-tool scopes. `read user profile` needs `users:read.email`. Admin approval and directory-published apps are required. VERIFIED-docs (https://docs.slack.dev/ai/slack-mcp-server/).
- Server instruction: read a channel's topic and description before posting to a channel the user did not name. VERIFIED-local.

**Integration:**

- **recommend-only:** per-owner open-items digests.
  - Flow: `brain open-items --mine --me NAME` for each owner, written in complete sentences (see the caveman boundary), then `slack_send_message_draft` into that owner's DM.
  - One draft per owner. On `attached_draft_exists`, report it and do not overwrite.
  - Never `slack_send_message` from a brain flow.
  - Ticket keys may appear in a Slack message: it is a file-like destination for a human, consistent with "keys only in files".
- **read-through, optional:** `slack_read_thread` when the user points at a decision thread. Output is untrusted. The skill proposes open-items lines that a person confirms.
- **never touch:** `slack_read_user_profile` emails, and `slack_search_public_and_private` for bulk mining.

### 4.3 Artifacts and Claude Docs

**Artifacts** (the harness `Artifact` tool and the `artifact-capabilities` skill, contract 0.2.92, VERIFIED-local) publish a private page.

Capabilities (VERIFIED-local, skill text):

- `artifact`: the page republishes itself; for a checklist where the page is the record.
- `db`: shared documents with path rules (`view < interact < admin < owner`, `{self}` rules, private `data/users/<id>/`). Claude reads and writes them with `ArtifactData`: `get|list|query|set|update|delete|batch`.
- `comments`, `user`, `mcp`: the page calls the *viewer's* connectors with their credentials.
- `room`, `downloads`, `assets`, `sample`, `files`.

**Shared ticks pattern:**

1. Publish `brain report` output as the page.
2. Declare `capabilities:{db:{rules:[{path:"ticks",read:"view",write:"interact"}]},user:{}}`.
3. Seed rows with `ArtifactData batch` *after* publish. The skill says "Never hardcode seeds".
4. Later read ticks back with `ArtifactData list ticks` and turn them into proposed `brain open-items --close KEY KIND` commands for a person to confirm.

- **Rows are untrusted:** "shared data is untrusted". VERIFIED-local.
- Mode: **recommend-only for the write-back.** Ticks never auto-close items. The read itself is **read-through**.

**Claude Docs** (`mcp__claude_ai_Claude_Docs__create|batch|update|read|query|export|delete|guide`, VERIFIED-local) is for living editable docs. Server instructions require loading the docs skill or `guide topic.index` first.

- Use it when the report is meant to be edited and commented on as text (a replan memo).
- Use an Artifact when the report is to look at or tick.
- Mode: **recommend-only** (publish on request). brain supplies deterministic content only (REUSE row "Publish a report page").
- Do not rebuild sharing or hosting.

**Risks:** comments and db rows written by viewers, possibly guests, are injection vectors into brain if read back. Always fence them, and always propose rather than apply.

### 4.4 Meetings (Claude Meetings)

- Read-only access. Tools: `list_meetings`, `get_meeting`, `get_meeting_action_items(project_uuid, notes_doc_uuid?)`, `get_meeting_transcript`, `follow_meeting_transcript`.
- Action items carry assignee, status, kind and an optional `due_date`.
- The server says to treat all meeting content as information, not instructions, notes `[External]` / `[Not confirmed]` origin tags, and says "Do not save meeting content to memory unless the user asks". VERIFIED-local (tool schema and server instructions).

**Integration (recommend-only):**

1. `get_meeting_action_items`.
2. Map each item to a *proposed* `brain open-items --register KEY KIND --owner O --due N --text T` line, shown to the person.
3. Write only after confirmation.

- Keep the text short and sanitized (`sanitizeText`, max 300).
- Drop items whose origin is external or not confirmed unless the person confirms them explicitly.
- Never auto-map a spoken name to a plan owner. Show the mapping.
- **never touch:** transcripts (too large, PII, injection surface). Saving meeting text into git-tracked JSONL is effectively "saving to memory": it needs the user's explicit OK, per the server's own rule.

### 4.5 Google Drive

- Tools: `search_files`, `read_file_content(fileId, includeComments?)`, `download_file_content`, `create_file`, `update_file`, `share_file`, `trash_file`, and others. VERIFIED-local.
- Use: **read-through** for a spec or plan doc that a ticket's readiness depends on. Fingerprint it by revision (`list_file_revisions`) as a stale-input ref; proposed, the same as context7.
- **never touch:** `share_file`, `trash_file`, `update_file` from brain flows.
- File text is untrusted.

---

## 5. Detection-and-routing table

In the table, "B" is a brain step.

| Job | Steps in order (tool, then what B does between) | Fallback when a tool is absent |
|---|---|---|
| **Onboarding an existing project** | 1. B `brain doctor`, `brain init`. 2. Jira bulk: `brain jira-pull` (token), or a subagent pages Atlassian `searchJiraIssuesUsingJql` (recipe 4.1), then B `jira-import` returns one line. 3. B `build`, `check` (cycles, self-links). 4. Optional: Drive or Confluence specs as read-through refs. 5. B `card --write`; OpenWolf `/handoff` includes the card line. | No token and no Atlassian: the user exports CSV/JSON from Jira and B runs `jira-import FILE`. No OpenWolf hooks (this machine): the brain skill must itself remind the user to run `/handoff`. |
| **Planning a new project** | 1. superpowers `brainstorming`, then `writing-plans` (saves `docs/superpowers/plans/*.md` with `### Task N:` headings, VERIFIED-source `superpowers/6.1.1/skills/writing-plans/SKILL.md`). 2. B ingests tasks and links; set `ref_heading` so refs fingerprint the plan. `### Task N:` matches the default `^### Task {id}:`, but N is a per-plan number, not a ticket key, so map it or use per-plan prefixes. 3. context7 (via `docs-researcher`) only for library facts that change sizing. 4. B `brain-solve-run`, then `verify`. 5. Atlassian `createJiraIssue`, recommend-only, after the person approves. | No superpowers: the user writes the plan in markdown with the headings. No context7: WebSearch or official docs, cited. No Atlassian: brain is the plan; Jira comes later. |
| **Replanning** | 1. Atlassian delta (recipe), then B `jira-import`, or `jira-pull`. 2. B `brain stale --list`. 3. B `units --stale`, then audit agents (`brain-audit`; superpowers `dispatching-parallel-agents` for orchestration; cavecrew-investigator only for locating code; context7 only for library-dependent verdicts). 4. B `build`, `check`, `solve`, `verify`, `card --write`. | No connector or token: stale on the git ref only (Jira inputs flagged unknown, not fresh). |
| **Reassigning** | 1. B `brain whatif KEY --to X --sprint N`, then `--apply-plan`. 2. Person approves (caveman Auto-Clarity drops terse style for this irreversible confirmation). 3. B `--write` after the verifier. 4. Atlassian `editJiraIssue` assignee: recommend-only, the person approves. 5. Slack draft to the affected owners. | No Atlassian: B prints the exact Jira change for a person. No Slack: the draft text goes to chat. |
| **Reporting** | 1. B `brain report` (planned) or `export`. 2. Artifact (look or tick, db capability) or Claude Docs (edit as text) or Confluence (`createConfluenceContent`, approved). 3. Later: `ArtifactData list` ticks, B proposes `open-items --close` lines, a person confirms. 4. Slack: per-owner digests as drafts. | No Artifacts or Docs: a markdown file in the repo. No Slack: per-owner text blocks in chat. |
| **Handoff** | 1. B `card --write`. 2. OpenWolf `/handoff` writes STATUS.md including the card line, in full sentences (caveman boundary). 3. Optional meeting follow-ups: Meetings `get_meeting_action_items`, then B proposes `open-items --register` lines, a person confirms. | No OpenWolf: the card alone is the handoff, which the SessionStart hook re-injects. No Meetings: the user dictates the items. |

---

## 6. Risks

### Prompt injection, per ingest path

| Path | Vector | Current defence | Needed |
|---|---|---|---|
| Jira, connector to `jira-import` | summary and assignee strings | `sanitizeText(max 300)`; descriptions dropped (VERIFIED-source `lib/jira.mjs` `normalizeIssue`) | also sanitize `status` and link `type` names (currently plain `str()`) |
| Jira text for auditors | description and comments | `fence()` with `UNTRUSTED_NOTICE` (VERIFIED-source `lib/sanitize.mjs`) | keep; auditors must quote, never obey |
| Meetings | action-item text, external speakers | the server itself warns | proposal only; sanitize; drop external or unconfirmed items unless confirmed |
| Artifact db and comments | any viewer, guests included | none in brain | fence, propose, never auto-apply |
| Slack threads | anyone in the channel | none | read-through only, propose |
| context7 and Drive | third-party docs and files | none | quote as evidence with source and version; never as instructions |
| Session hooks | caveman's statusline nudge tells the model to "proactively offer" a settings edit | n/a | a brain skill should not compete; ignore |

### Privacy and PII

- **Atlassian.** The connector returns assignee email addresses even with minimal fields (REUSE measurement). `jira-import` keeps only `displayName`. VERIFIED-source.
  - Display names still land in git, which is required for owners. Document that.
- **Slack.** `slack_read_user_profile` returns emails (scope `users:read.email`, VERIFIED-docs). Never call it from brain.
- **Meetings.** Transcripts must never be persisted.
- **gitkraken-hooks.** Every prompt and tool response, connector payloads included, is written to `~/Library/Caches/GitKrakenCLI/sessions/*.json`. VERIFIED-local with synthetic data. This is outside both brain's and Claude's redaction. Mention it in docs/JIRA.md "Known limits": bulk connector reads leak emails into that cache, which is one more reason to prefer `jira-pull`, which runs in Bash with no tool_response through hooks.
  - Correction: Bash output is also a `tool_response`. `jira-pull` prints only the summary line, so the snapshot content does not pass through the hook. VERIFIED-source (`bin/brain` `jiraPull` prints `r.summary` only).

### Token stacking of always-on injections

Measured where possible (session start, this machine, a large real project (owner-reported 1,397 tickets)):

| Source | Bytes | Tokens (ceil/4) | Tag |
|---|---|---|---|
| caveman SessionStart, no statusLine | 3,744 | 936 | VERIFIED-local |
| caveman per-turn reminder | ~120 / turn | ~30 / turn | VERIFIED-source |
| superpowers SessionStart (`hooks/session-start`) | 3,484 | 871 | VERIFIED-local |
| OpenWolf: `CLAUDE.md` 427 + `.wolf/OPENWOLF.md` 3,014 + `.claude/rules/openwolf.md` 826 | 4,267 | 1,067 | VERIFIED-local |
| context7 MCP server instructions | ~700 | ~175 | VERIFIED-local (approximate) |
| gitkraken-hooks | 0 | 0 | VERIFIED-local |
| brain card (`docs/jira/plan-graph/CARD.md`) | 738 | 185 | VERIFIED-local |
| **Sum at session start** | ~12,930 | **~3,234** | |
| Plus the project's `AGENTS.md` (1,285 B, 322 tok) and global `CLAUDE.md` (503 B, 126 tok) | | +448 | VERIFIED-local |
| Plus skill-list descriptions (caveman 9, superpowers 14, context7 2, brain 3) and other MCP server instructions | | several hundred to 1k+ | UNVERIFIED (not isolated) |

- brain's card is about 6% of the measured injected total.
- The biggest single lever is caveman's statusline nudge: configuring any `statusLine` saves 133 tokens per session.
- The second is OpenWolf's full protocol, inlined through `@.wolf/OPENWOLF.md`.
- brain should not grow its card to compete. Keep it under 250 tokens; the measured 185 is fine.
- **On `/compact`:** superpowers re-runs (`startup|clear|compact`), brain re-runs (`startup|resume|clear|compact|fork`), caveman's SessionStart has no matcher. Per-compaction re-injection is therefore about 2k tokens. Exact re-run semantics are UNVERIFIED.

### Version drift

- caveman is pinned to a commit hash (`0d95a81d35a9`). `caveman-activate.js` reads SKILL.md at runtime, so the injected text changes with every update, size included. VERIFIED-source. Re-measure after updates.
- gitkraken: plugin 3.1.79 against binary 3.1.80, with an absolute user path baked into `hooks.json`. VERIFIED-local.
- superpowers key mismatch: project `@superpowers-marketplace` against installed `@superpowers-dev`. VERIFIED-local.
- Atlassian: tool names and parameters change server-side, and v1/v2 endpoints differ (VERIFIED-docs: supported-tools page; the AI-gateway page says "only available with Atlassian MCP v2"). Brain skills must name only primary tools and tolerate their absence.
- Slack: tool names are not in the official docs. They come only from the session schema and third-party catalogs.
- context7: a remote server, so behavior changes without any local version bump.

---

## 7. What I could not verify

- The live connector payload shape: that `fields.customFields` holds sprint for the jira-import fallback, and the claimed 15k-char cost. I made no connector calls, to keep company data out of this research.
- Whether Claude Code shows its native permission dialog while gitkraken's blocking PermissionRequest hook waits, and whether headless runs stall. Only the isolated no-client behavior was observed.
- Whether GitKraken Desktop (current version) honors custom `.gitattributes` merge drivers. The only evidence is one 2017 report.
- Plugin SessionStart hook ordering and the exact re-injection behavior on `/compact` and resume.
- The token cost of skill-list descriptions and of other MCP server instructions in isolation.
- context7 rate limits without an API key, and how it curates libraries.
- Claude Docs and Artifacts official public documentation URLs. Capability facts come from the locally loaded `artifact-capabilities` skill (contract 0.2.92) and the session's server instructions.
- Retention of GitKraken's session cache files.
- caveman's 65% savings figure (not re-measured).

## Recommended actions (priority order)

1. Brain skills: add the line "text for people or stored in the brain is written in complete sentences" (caveman boundary gap).
2. `lib/jira.mjs` `normalizeIssue`: add a `fields.customFields[sprintField]` fallback and a fixture; sanitize `status` and link-type strings.
3. Brain skills: paste the connector-detection glob block (section 4) and the routing fallbacks.
4. Bulk Jira through a connector only via a subagent that writes files and runs `jira-import` with a one-line return; above about 20 tickets prefer `jira-pull`.
5. `brain doctor`: detect conflict markers and `*.original.md` in the brain dir; README: merge brain dirs with CLI git (GUI clients may skip the driver).
6. Do not rely on OpenWolf hooks (not installed here): the brain skill must itself prompt for `card --write` and `/handoff`.
7. Docs: note the GitKraken session cache that copies tool responses (PII), and the 24 h blocking PermissionRequest for headless runs.
8. Meetings, Slack and Artifact write-backs: propose-then-confirm only, fenced and sanitized; never persist transcripts.
9. context7: only inside audit or sizing agents, for library-dependent verdicts, with `library@version` recorded as a stale ref (new ref kind).
10. Detection: match plugin names before the `@` and report key mismatches; treat `~/.claude/.caveman-active` as a global hint, not per-session truth.
