# Optional read-only MCP adapter

`mcp/plangraph-mcp.ts` is a small MCP server (stdio) with three read-only tools: `ready`, `whatif` (dry run only) and `ticket`. It is
**off by default**. Installing the plugin does not start it and does not add it to any session: `plugin.json` has no `mcpServers` entry,
there is no `.mcp.json` at the plugin root, and the file is not in `bin/`, so it is not a command on PATH. A default install pays zero
tokens for it (checked with `claude plugin details`, below).

It duplicates the CLI. Everything it can answer, `plangraph ready KEY`, `plangraph whatif KEY ...` and `plangraph ticket KEY` already answer through
Bash, with the same bytes. Turn it on only if your own evals show the MCP condition is no worse than the CLI (success within noise,
median total tokens not worse by more than 25%; docs/research/ai-engineering.md section 6.3). Two reasons you might: a client with no
shell, or a locked-down session where you would rather grant three read-only tools than `Bash(plangraph *)`.

## Turning it on

Pick one. The server finds the repository from its working directory, the way `plangraph` does (the nearest `.git`, then `PLANGRAPH_DIR`,
`.plangraphrc` or `.plangraph`), so register it where the client starts it in the project.

1. Claude Code, one project, private to you (stored in your user config, not in the repo):

   ```
   claude mcp add plangraph -- node /absolute/path/to/plangraph/mcp/plangraph-mcp.ts
   ```

2. A project `.mcp.json` you commit in YOUR repository (Claude Code asks each person to approve it once):

   ```json
   {
     "mcpServers": {
       "plangraph": {
         "type": "stdio",
         "command": "node",
         "args": ["/absolute/path/to/plangraph/mcp/plangraph-mcp.ts"]
       }
     }
   }
   ```

Use the path of a checkout of this repository, or of the installed plugin copy (`claude plugin details plangraph` shows its
source). The installed copy's path contains the version, so it changes on update; a checkout does not. Node 24.2 or newer is needed.

Turning it off: `claude mcp remove plangraph`, or delete the entry. Do not add the snippet to the plugin's own root: Claude Code would then
start it for every user of the plugin.

For evals, `claude --strict-mcp-config --mcp-config <file>` runs a session with only the servers in that file (condition C of the
eval plan), so other servers do not skew the token counts.

## Tools

| tool | arguments | same text as |
|---|---|---|
| `ready` | `key`, `verbose` | `plangraph ready KEY [-v]` |
| `whatif` | `key`, `to`, `sprint`, `earlier`, `owner_change`, `slip`, `strict`, `verbose` | `plangraph whatif KEY [--to P] [--sprint N] [flags] [-v]`, never `--apply-plan` or `--write` |
| `ticket` | `key`, `verbose` | `plangraph ticket KEY [-v]` |

Not exposed: `ready --jira FILE` (a path), `--dir`, `--json`, and every command that writes. The bulk forms `plangraph ready --person NAME
--sprint N` and `plangraph whatif --relieve NAME --sprint N` are read-only and bounded, but they are CLI-only on purpose: adding their
arguments would raise the up-front tool-definition cost every MCP session pays (the table below), for a server that is off by default.

A call runs the same command through the CLI runner (`src/cli.ts`) with a collecting output, so fencing of untrusted text, output
sanitization, the 40-line bound, the STALE warning and the error lines are the CLI's own. The result is one text item: the command's
stdout lines, then its stderr lines (as `plangraph ... 2>&1` would print them in that order), cut at 256 KiB with a marker line.
`isError` is true only for exit codes 2 and up (usage, data, environment, refused); `NOT READY` and a `NO:` dry run are answers (exit 1),
not errors.

## Safety

- Arguments are checked against fixed shapes before anything runs: `key` is a Jira key (`ABC-123`) or a superpowers key
  (`sp:<plan>/<task>`); `to` is a person name (letters, digits, space, `. _ ' -`, at most 80, starting with a letter or digit); `sprint`
  is a whole number from 0 to 100000; flags are JSON booleans. Any other property, including `__proto__`, is refused. A bad argument
  returns `isError: true` with a fixed message that never repeats the value.
- The argv is built from a fixed list: the command name, `--to=`/`--sprint=` with the checked value, the allowed flags, then `--` and
  the key. `--write`, `--apply-plan`, `--jira` and `--dir` cannot be built (checked twice). No shell, no paths from arguments.
- Read-only: no tool writes. `test/mcp.test.ts` hashes the whole fixture repository before and after a session of every tool,
  `whatif` included, and finds it byte-identical; it also checks that nothing appears in HOME.
- No network. A command never reads stdin (stdin is the protocol stream; commands get an empty one).
- One message line may be at most 1 MiB; a longer one is answered with one error and skipped up to its newline without being kept.
  Messages are handled one at a time, in order, and input is only read after the previous chunk is answered, so memory stays bounded.
- Rate limiting: the spec says servers MUST rate limit tool invocations. Calls here are sequential and local (tens of milliseconds);
  there is no other limit.

## Protocol

Hand-written JSON-RPC 2.0, no SDK, no runtime dependency. What it does, and where each behavior comes from:

| behavior | source |
|---|---|
| stdio: one JSON-RPC message per line, no embedded newlines, nothing but MCP messages on stdout, nothing logged on stderr | spec 2025-06-18 basic/transports, verified |
| No Content-Length framing (that is LSP). A `Content-Length:` line is invalid JSON and gets a parse error | spec: stdio messages are newline-delimited, verified |
| `initialize`: echo the requested version if supported (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), else answer 2025-11-25 | spec 2025-06-18 basic/lifecycle "Version Negotiation", verified |
| capabilities `{ tools: { listChanged: false } }`, serverInfo name and version, no `instructions` (they would cost tokens every session) | spec lifecycle and server/tools, verified |
| `ping` answered with `{}` at any time, also before `initialize` | spec basic/utilities/ping, verified |
| `tools/list` with every tool, no pagination (a `cursor` is refused with -32602) | spec server/tools, verified; the cursor refusal is our choice |
| `tools/call`: unknown tool -32602; argument problems as a tool result with `isError: true` | spec server/tools and 2025-11-25 changelog (SEP-1303), verified |
| Text only: no `structuredContent`, no `outputSchema` | allowed by the spec; our choice, to keep the CLI text as the one answer |
| Unknown method -32601, including the modern `server/discover` probe | JSON-RPC 2.0; spec 2026-07-28 versioning: a dual-era client falls back to `initialize` on any non-modern error, verified (and observed, below) |
| Batches (a JSON array) refused with -32600 | batching was removed in 2025-06-18 (changelog, verified). A client that negotiates 2025-03-26 and sends a batch is refused: conservative, unverified against such a client |
| `tools/*` before `initialize` -32600 "server not initialized"; a second `initialize` -32600 | the spec does not fix a code for these: our conservative choice, unverified against other clients |
| Tools are served once `initialize` was answered; `notifications/initialized` is accepted but not required | the spec says the client SHOULD NOT send other requests before the initialize response; not requiring the notification is our choice |
| Notifications are never answered; responses from the client are ignored (the server sends no requests) | JSON-RPC 2.0 |
| Invalid UTF-8, a byte-order mark, invalid JSON: -32700 with id null. Invalid request object (wrong `jsonrpc`, id null, a non-integer number or object id, no method): -32600 | JSON-RPC 2.0; MCP: ids are strings or integers, not null |
| A command that throws: -32603 "internal error", fixed text | JSON-RPC 2.0 |
| End of stdin: answer what was read (a last line without a newline too), then exit 0. Output pipe closed: stop writing | spec lifecycle "Shutdown" (stdio), verified |

The current protocol revision is 2026-07-28, which drops the `initialize` handshake for per-request `_meta`. This server implements
only the handshake ("legacy") revisions; clients that also speak those (dual-era) work, as below. A modern-only client would not.

## Verified against a live client

Claude Code 2.1.329 (the native CLI), in an isolated config (`CLAUDE_CONFIG_DIR` and `HOME` set to a temporary directory), 2026-11-22:

- Default plugin install (`claude plugin marketplace add <checkout>`, `claude plugin install plangraph@plangraph-marketplace`,
  `claude plugin details plangraph`): `MCP servers (0)`, always-on cost `~630 tok`, the same before and after this change.
- Opt-in: `claude mcp add plangraph -- <script>` in a scratch git repository, then `claude mcp list` and `claude mcp get plangraph`:
  `✔ Connected`. A tee wrapper logged the exchange: Claude Code first sent `server/discover` (protocol 2026-07-28), got -32601, fell back
  to `initialize` with `protocolVersion` 2025-11-25, which was echoed, then sent `notifications/initialized` and `tools/list` and got the
  three tools. `test/mcp.test.ts` replays that exact sequence.
- The `.mcp.json` snippet above, placed in a scratch repository: `claude mcp list` and `claude mcp get plangraph` read it as a project-scope
  stdio server, `⏸ Pending approval` (approval is interactive and was not given there).
- `claude --help` lists `--mcp-config` and `--strict-mcp-config` as described above.

Then, in a logged-in Claude Code 2.1.329 session with the server opted in (an owner-run session, not part of the automated tests):

- Claude Code DEFERS the MCP tool definitions and loads them on demand: the model's first step was a `ToolSearch` select of the three
  `plangraph` tools, and only then did it call them. The definitions are not in the context up front.
- A model made the tool calls: a 5-turn session made 3 correct calls and cost $0.046 in total (as reported by Claude Code).

Still not verified: how many tokens the deferred entry (the tool names listed for `ToolSearch`) costs before the first use; how Claude
Code shows the tool text to the model, byte for byte; whether deferral happens in every configuration (other Claude Code versions,
settings that turn tool search off, sessions with few tools); a comparison of that session against the same questions through the CLI;
and any other MCP client.

## Token cost (measured, with limits)

`node test/bench-mcp.ts` (2026-11-22). The plan is the token benchmark's synthetic one (test/bench-tokens.ts: 1400 tickets). Of its 24
questions, the five that `ticket` or `ready` answer are measured; the others need commands that are not exposed. `whatif` has no bench
question, so one dry run is listed for size only.

<!-- MCP-BENCH:START -->
Tokenizer: est tok = ceil(chars/4) x 1 (test/token-calibration.json, unverified). Bytes are exact.

| up-front item | bytes | est tok |
|---|--:|--:|
| tool definitions (JSON of the 3 tools) | 1992 | 498 |
| - ready | 617 | 155 |
| - whatif | 837 | 210 |
| - ticket | 534 | 134 |
| tools/list reply line | 2036 | 509 |
| initialize reply line | 169 | 43 |

| # | call | cli bytes | mcp text bytes | same text | reply line bytes | wrapper bytes | cli est tok | reply est tok |
|--:|---|--:|--:|:-:|--:|--:|--:|--:|
| 1 | ticket {"key":"T-700"} | 324 | 324 | yes | 419 | 95 | 81 | 105 |
| 4 | ready {"key":"T-700"} | 508 | 508 | yes | 608 | 100 | 127 | 152 |
| 15 | ticket {"key":"T-1200"} | 318 | 318 | yes | 413 | 95 | 79 | 103 |
| 21 | ticket {"key":"T-20"} | 296 | 296 | yes | 391 | 95 | 74 | 98 |
| 22 | ticket {"key":"T-99999"} | 95 | 95 | yes | 186 | 91 | 24 | 47 |
| whatif (no bench question) | whatif {"key":"T-700","sprint":3} | 530 | 530 | yes | 621 | 91 | 133 | 156 |
| | total | 2071 | | | 2638 | 567 | | |
<!-- MCP-BENCH:END -->

Reading it:

- Up front: about 490 est tok of tool definitions per session on a client that loads them eagerly, against 0 for the CLI (whose cost is
  the card and the skill description, paid either way). This is inside the 360-540 estimate of ai-engineering.md 6.2. Claude Code 2.1.329
  was seen to defer them (above): it pays a short entry until the model selects the tools with `ToolSearch`, then the definitions of
  the selected tools. The size of that entry is not measured here; the table is the eager-client cost.
- Per call: the answer text is the same bytes as the CLI. The JSON-RPC reply adds about 90-100 bytes of envelope and escaping; how much
  of that a client shows to the model is client-specific and not measured. On the CLI side, the Bash tool call and its framing are not
  measured either. So the per-call difference is small and its sign is not established here.
- Not measured: success rate, turns, or total session tokens with a real model. That is what the owner-run evals decide.
