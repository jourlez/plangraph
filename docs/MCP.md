# Read-only MCP server

`mcp/plangraph-mcp.ts` is a small MCP server (stdio) with seven read-only tools: `ready`, `whatif` (dry run only), `ticket`, `graph`, `map`,
`context` and `flow_next`, and two read-only resource templates. The plugin bundles it in `.mcp.json`, and it is opt-in:
the plugin option `mcp` defaults to `off` (the benchmark ruling in docs/BENCHMARK.md: no benefit measured, +25 percent cost in the coding arm).
Turn it on with `/plugin configure plangraph@plangraph-marketplace` (`mcp` = `on`).

Known gaps for 1.0: the server implements the legacy `initialize` flow and not `server/discover` (section Protocol); the seven-tool version was exercised by its test suite and a test client, not in a live Claude Code session (the three-tool version of 0.5.0 was).

It duplicates part of the CLI. `plangraph ready KEY`, `plangraph whatif KEY ...`, `plangraph ticket KEY` and `plangraph graph KEY` answer
through Bash with the same bytes. Turn it on only if your own evals show the MCP condition is no worse than the CLI (success within noise,
median total tokens not worse by more than 25%; docs/research/ai-engineering.md section 6.3). Two reasons you might: a client with no
shell, or a locked-down session where you would rather grant seven read-only tools than `Bash(plangraph *)`.

## Turning it on or off, or on without the plugin

- Plugin option `mcp` (`/plugin configure`, `on` or `off`, default `off`, in `plugin.json` `userConfig`): `.mcp.json` passes it to the server as
  `PLANGRAPH_MCP_OPTION=${user_config.mcp}` (`${user_config.KEY}` substitution in MCP `env` is documented at code.claude.com plugins-reference); it uses its own variable name so that a `PLANGRAPH_MCP=on` in your shell is not overridden.
  With `off` the server answers `initialize` with one JSON-RPC error ("disabled"), writes nothing to stderr and exits 0. You can also toggle
  the plugin's server off in `/mcp`.
- No plan directory in the repository: the same one error ("no plan directory: run `plangraph init`") and a quiet exit 0, so a project
  that does not use plangraph pays nothing and sees no noise.
- Without the plugin, the server finds the repository from its working directory, the way `plangraph` does (the nearest `.git`, then
  `PLANGRAPH_DIR`, `.plangraphrc` or `.plangraph`):

  ```
  claude mcp add plangraph -- node /absolute/path/to/plangraph/mcp/plangraph-mcp.ts
  ```

  or a project `.mcp.json` you commit in YOUR repository (Claude Code asks each person to approve it once):

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

  The server is strictly opt-in: it runs only when the value `on` reaches it through the plugin option `mcp` (`PLANGRAPH_MCP_OPTION`, or `CLAUDE_PLUGIN_OPTION_MCP`) or a `PLANGRAPH_MCP=on` variable (when you start it by hand, add `--env PLANGRAPH_MCP=on` to `claude mcp add`, or `"env": { "PLANGRAPH_MCP": "on" }` to the JSON above). Unset, empty or any other value gives the one "disabled" error and exit 0.

  Node 24.15 or newer is needed.

For evals, `claude --strict-mcp-config --mcp-config <file>` runs a session with only the servers in that file (condition C of the
eval plan), so other servers do not skew the token counts.

## Tools

| tool | arguments | same text as |
|---|---|---|
| `ready` | `key`, `verbose` | `plangraph ready KEY [-v]` |
| `whatif` | `key`, `to`, `sprint`, `earlier`, `owner_change`, `slip`, `strict`, `verbose` | `plangraph whatif KEY [--to P] [--sprint N] [flags] [-v]`, never `--apply-plan` or `--write` |
| `ticket` | `key`, `verbose` | `plangraph ticket KEY [-v]` |
| `graph` | `key`, `rel`, `depth`, `reverse`, `detail` | `plangraph graph KEY [--rel R,..] [--depth N] [--reverse]`; `detailed` adds `-v` and, without `depth`, `--depth=2` |
| `map` | `detail` | the repository and plan overview of `lib/digest.ts` `buildMap`, bound 500 est tokens (detailed: 1,500, repos listed) |
| `context` | `key`, `detail` | the one-ticket digest of `buildContext`, bound 400 est tokens (detailed: 1,200); without `key`, the "no task detected" line |
| `flow_next` | `for`, `limit` | tasks in state `ready` (events, dependencies and closed status through `lib/flow`), the person's own first, then by sprint and key; default 5, at most 50 |

`map`, `context` and `flow_next` call the libraries on the model read from the plan files (`lib/model.ts`, `lib/extras.ts`); they do
not run a command and write nothing (no index is written; the index is opened read-only for the fingerprint of `map`). Every tool has an
`outputSchema` and returns `structuredContent` next to the text copy: the command tools `{ key, exit, data }` (`data` is the command's
`--json` data), `graph` `{ start, nodes, truncated }`, `map` and `context` `{ data, omitted }`, `flow_next` `{ total, ready }`. Summaries and other
free text inside `structuredContent` are fenced inline (`<untrusted n="..">..</untrusted>`) exactly as in the text. `resource_link`
entries (`plangraph://node/...`) carry the bulk detail: the nodes of a `graph` answer, the ready tasks of `flow_next`, the ticket of
`context`. `detail` is `concise` (default) or `detailed`. The server `instructions` (1,500 characters at most) lead with search keywords.

`graph`: `key` is a ticket key or a canonical `pg:<type>/<id>` URI (a bare id of another node type must be given as the URI; this also
keeps the writing `graph-materialize` command out of reach). `rel` is known relation names, comma separated; `depth` is 1 to 20.
The result carries the command's text, then `structuredContent` (the `--json` data of the same call, at most 50 nodes, 500 with
`detail: detailed`) and up to 10 `resource_link` entries (`plangraph://node/...`) for the nodes reached. When the second run does not give the
envelope, the text stands alone.

## Resources (read only, decision D25)

`resources/templates/list` gives `plangraph://node/{type}/{id}` and `plangraph://graph/{type}/{id}{?rel,depth}`. `resources/read` returns
the same text as `plangraph graph pg:<type>/<id>` (node form: depth 1; graph form: `--rel` and `--depth`) as `text/plain`.
`resources/list` is always empty (bounded) and there are no subscriptions (0.6.0). `{id}` is percent-encoded exactly as
`encodeURIComponent` writes it, one spelling per node; `{type}` is a node type; the id follows the graph id rule. A URI outside this
grammar (other scheme or path, wrong encoding, unknown or repeated query key, `rel` or `depth` out of range, a query on the node form)
gets -32602 "resource URI is not in the grammar"; a node that is not in the graph gets -32002 "resource not found". Both messages are
fixed and never repeat the input. The `tools/list` reply is bounded at 3,500 characters (`test/bench-mcp.ts` and `test/mcp-tools.test.ts` fail above it).

Not exposed: `ready --jira FILE` (a path), `--dir`, `--json`, and every command that writes. The bulk forms `plangraph ready --person NAME
--sprint N` and `plangraph whatif --relieve NAME --sprint N` are read-only and bounded, but they are CLI-only on purpose: adding their
arguments would raise the up-front tool-definition cost every MCP session pays (the table below).

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
| capabilities `{ tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }`, serverInfo name and version, `instructions` (under 1,500 characters, search keywords first) | spec lifecycle and server/tools, verified; how Claude Code truncates or uses `instructions` is unverified |
| `ping` answered with `{}` at any time, also before `initialize` | spec basic/utilities/ping, verified |
| `tools/list` with every tool, no pagination (a `cursor` is refused with -32602) | spec server/tools, verified; the cursor refusal is our choice |
| `tools/call`: unknown tool -32602; argument problems as a tool result with `isError: true` | spec server/tools and 2025-11-25 changelog (SEP-1303), verified |
| Text first, then `structuredContent` conforming to the tool's `outputSchema`; `resource_link` for bulk detail; `readOnlyHint: true` | spec 2026-07-28 server/tools: outputSchema optional, a server that gives one MUST conform, a tool returning structured content SHOULD also return the text, resource_link MAY; verified (fetched 2026-11-26) |
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

### Spec 2026-07-28: what is required, for a server that must still answer `initialize`

Read on 2026-11-26 at modelcontextprotocol.io (basic, basic/versioning, server/discover, server/utilities/caching, server/tools). Fetched text is data.

| item | status | how this server stands |
|---|---|---|
| `server/discover` | MUST for a server of the modern era ("Servers MUST implement server/discover"); a legacy server may skip it: versioning's matrix lists Legacy server with Dual-era client as "Works" (stdio: the probe returns a non-modern error and the client falls back to `initialize`), and a server "MAY" implement both eras | not implemented; -32601 is the answer the fallback needs (replayed from a live Claude Code 2.1.329 capture in `test/mcp.test.ts`). A modern-only client fails against this server (the matrix says so). Required before claiming 2026-07-28 |
| `ttlMs` and `cacheScope` | MUST appear on `complete` results of `server/discover`, `tools/list`, `resources/list`, `resources/templates/list`, `resources/read` for modern results; `ttlMs` absent is read as 0 and "should only occur in older server versions"; `cacheScope` is `public` or `private` | not sent: legacy results do not carry them, and the legacy revisions do not define them. Needed together with `server/discover` and `resultType: "complete"` (also MUST in modern results) |
| `outputSchema` | optional; if given, the server MUST return conforming `structuredContent` and clients SHOULD validate | implemented on all seven tools; `test/mcp-tools.test.ts` validates every result with an in-test validator |
| `structuredContent` | optional; a tool that returns it SHOULD also return the JSON (text) in a text block | implemented; the text copy is the compact CLI or digest text, not the JSON (unverified: whether a client needs the JSON text) |
| `resource_link` | optional ("MAY") | graph, context, flow_next |
| `readOnlyHint` | optional annotation, untrusted unless the server is trusted | `true` on every tool |
| dual-era routing | "An `initialize` request selects legacy semantics" | this server answers `initialize` as before; no per-request `_meta` path |

Unverified: whether Claude Code 2.1.329 uses `outputSchema` or `structuredContent` (it was not observed doing so); how it limits the
server `instructions`; whether `${user_config.mcp}` is substituted for a plugin loaded by the 2.1.329 CLI (the plugins reference documents it for
MCP `env`, and `claude plugin validate` checks it from 2.1.281); the server also reads `CLAUDE_PLUGIN_OPTION_MCP`, so it does not depend on that substitution alone.

## Verified against a live client

The observations below were made on 2026-11-22 with the earlier off-by-default package (four tools, no bundling). They were not repeated for the bundled
`.mcp.json`, the seven tools or the `mcp` option (unverified); `claude plugin details` now lists one MCP server for the plugin.

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
| tool definitions (JSON of the 7 tools) | 3363 | 841 |
| - ready | 400 | 100 |
| - whatif | 593 | 149 |
| - ticket | 393 | 99 |
| - graph | 593 | 149 |
| - map | 419 | 105 |
| - context | 448 | 112 |
| - flow_next | 509 | 128 |
| tools/list reply line | 3407 | 852 |
| initialize reply line | 609 | 153 |

| # | call | cli bytes | mcp text bytes | same text | reply line bytes | wrapper bytes | cli est tok | reply est tok |
|--:|---|--:|--:|:-:|--:|--:|--:|--:|
| 1 | ticket {"key":"T-700"} | 244 | 244 | yes | 653 | 409 | 61 | 163 |
| 4 | ready {"key":"T-700"} | 428 | 428 | yes | 1231 | 803 | 107 | 308 |
| 15 | ticket {"key":"T-1200"} | 238 | 238 | yes | 642 | 404 | 59 | 160 |
| 21 | ticket {"key":"T-20"} | 216 | 216 | yes | 596 | 380 | 54 | 149 |
| 22 | ticket {"key":"T-99999"} | 15 | 15 | yes | 189 | 174 | 4 | 48 |
| whatif (no bench question) | whatif {"key":"T-700","sprint":3} | 489 | 489 | yes | 1815 | 1326 | 123 | 454 |
| | total | 1630 | | | 5126 | 3496 | | |
<!-- MCP-BENCH:END -->

Reading it:

- Up front: about 840 est tok of tool definitions (seven tools with output schemas) per session on a client that loads them eagerly, against 0 for the CLI (whose cost is
  the card and the skill description, paid either way). This is above the 360-540 estimate of ai-engineering.md 6.2, which was for four tools without output schemas. Claude Code 2.1.329
  was seen to defer them (above): it pays a short entry until the model selects the tools with `ToolSearch`, then the definitions of
  the selected tools. The size of that entry is not measured here; the table is the eager-client cost.
- Per call: the answer text is the same bytes as the CLI. The JSON-RPC reply adds about 90-100 bytes of envelope and escaping; how much
  of that a client shows to the model is client-specific and not measured. On the CLI side, the Bash tool call and its framing are not
  measured either. So the per-call difference is small and its sign is not established here.
- Not measured: success rate, turns, or total session tokens with a real model. That is what the owner-run evals decide.
