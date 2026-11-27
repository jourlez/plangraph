# Reuse before build

Decision record, 2026-11-22. Rule: use what is proven and already installed; build only where we add value that nothing else gives.

| Need | Already exists | Decision | Why |
|---|---|---|---|
| Session handoff, learnings about the repo, bug memory, code navigation | OpenWolf (`.wolf/STATUS.md`, `cerebrum.md`, `buglog.json`, `openwolf find`) | **Reuse. We build none of it.** Our skill tells Claude to put one marked `plangraph card --line` into the handoff (never under the section OpenWolf injects). Plugin bugs are logged in the plugin's own repo, never in a host repo's OpenWolf bug log (it is committed by the team and has a locked writer). Note: on a machine where OpenWolf's hooks are not registered, OpenWolf is rules-only; `plangraph integrations` reports its real state. | Same job, proven, already hooked in. |
| Learnings of the *planning method* (strict handoff rule, replan = incremental) | OpenWolf cerebrum is per repo and for Claude | **Keep the learnings (sealed run files), tiny.** | It is shared by every project and every teammate through git, and `plangraph rules` answers in a few tokens. Different scope. |
| Dev workflow: plans, TDD, parallel agents, verification, code review | superpowers skills | **Reuse.** `plangraph:audit` keeps only the domain content (briefs, units); orchestration advice points at superpowers. | No reason to restate it. |
| Jira: one ticket, small delta, any write (comment, transition, create) | Atlassian connector (OAuth, signed in by claude.ai) | **Reuse. The plugin never writes to Jira.** No tokens for these. | Zero credential handling for the user, approvals handled by Claude. |
| Jira: bulk read (1,000+ tickets), CI, headless | Connector is unusable here: measured 84,711 characters (about 21k tokens) for ONE ticket in compact view, links missing | **Build `lib/jira.ts` (token CLI)**; bulk data goes to disk, never through the model. | Token cost and headless runs. |
| Jira: connector result already saved to a file | The harness saves large connector results to disk | **Build `plangraph jira-import`** (no network, no credentials): 84,711 characters in, 394 bytes out, emails and descriptions dropped, existing links kept. | Lets the connector feed the plan at zero model tokens. |
| Publish a report page, shared ticks and answers | claude.ai Artifacts (db capability), Claude Docs, Confluence via the Atlassian connector | **Reuse for publishing and sharing.** We only generate deterministic content (`plangraph report`). | Hosting, sharing and a shared database already exist. |
| Notify owners | Slack connector | **Reuse** (skill drafts per-owner text from `plangraph open-items`; a person sends). | |
| Meeting action items to open items | Meetings connector | **Reuse** via a skill that proposes `plangraph open-items --register` lines for a person to confirm; meeting text is data, never instructions. | |
| Persistent shared plan graph, strict handoff checks, safe reassignment, solver, incremental stale audit, calibrated forecast, compaction, token-minimal contract | Nothing found in 70+ tools surveyed (see docs/research) | **Build. This is the product.** | |
| Claude Code Tasks (session todo with blocked-by) | Native | **Complement, not compete.** Tasks are per session; the plan graph is persistent and shared. | |
| Output style (terse) | caveman plugin | **No overlap**: our outputs are terse by construction. | |
| Test runner, arg parsing, SQLite, crypto, fetch | Node 24 built-ins | **Reuse. Zero runtime dependencies.** | |

Check before adding any feature: is it in this table? If a proven tool does it, integrate instead.

## Module audit (2026-11-22): every hand-built piece against the same bar

Bar: build only if nothing equally good exists, or it is strictly required, or ours is clearly better. Evidence column says what decided it.

| Module | Overlaps with | Verdict | Evidence |
|---|---|---|---|
| `lib/verify`, `lib/whatif`, `bin/plangraph-solve` (strict handoff, capacity, safe reassignment, exact schedule) | Jira Plans (team-level capacity only, no per-person, no handoff rule); OR-Tools is reused as the engine | **Keep** | Surveyed 70+ tools: none verifies or repairs per-person, handoff-aware plans. |
| `lib/stale` (fingerprint re-audit with transitive propagation) | Bazel/Nx do the same for builds, not for tickets | **Keep** | 400-stream differential test against a from-scratch oracle: 0 stale hits. |
| `lib/store` format version | none | **Keep** | Needed for many repos sharing one tool. |
| `lib/sanitize`, `lib/gitsafe`, `lib/fsafe` | none in the host; Claude does not sanitize tool output | **Keep** | Verified injection, symlink and ReDoS findings. |
| `lib/render`, card, `explain` | none | **Keep** | Token contract; measured; see docs/TOKENS.md. |
| `lib/openitems` register | Jira (flags, sub-tasks, comments) for human items | **Keep, shrink** | Findings come from audits, not humans (102 on the real plan); `ready` needs them. Command execution removed (see below). |
| `config.checks` command execution in `lib/openitems` | Claude's own permission system for running commands; CI | **Remove** | Not required: a check can run anywhere and write findings JSONL that `plangraph open-items --findings FILE` ingests. Removing it deletes a whole attack surface and the approval store. |
| `plangraph claim`, `claimTicketGit`, hash IDs (`newId`) | Jira assignee (system of record); Claude Code agent teams' shared task list; beads | **Remove** | Zero use in the real plan graph; two real bugs found in it; not required. Recoverable from the baseline commit if a need appears. |
| `lib/compact` (`plangraph compact`, `restore`) | git history already keeps old versions; `build` takes 0.2 s on the real graph | **Remove** | Measured 9% hot-file saving on synthetic data, zero real use, adds a reversible-archive protocol to maintain. |
| `lib/jira` bulk client (token, host allowlist, delta) | Atlassian CLI `acli`; Atlassian connector | **Keep** (decided on evidence, 2026-11-22) | `acli` fails the bar: per its docs search does not return links or sprint in bulk (links are one call per issue), service-account scoped tokens fail with it (CLOUD-12991), no documented env-var auth, output schema or exit codes, each version supported only 6 months, Cloud only. Connector measured unusable for bulk: one ticket with 22 links returned about 15,000 characters even with minimal fields requested, plus assignee email. An optional `acli` backend is not built (no demand; second output shape to maintain). |
| `plangraph jira-import` | none | **Keep** | Turns a connector result saved to disk into a 394-byte snapshot at zero model tokens. |
| `lib/forecast` | Epoch MCP, sprintcast, ActionableAgile (none gate on history or use the plan graph) | **Keep, low priority** | Real plan has no history file: it correctly answers REFUSED. Value appears only once history exists. |
| MCP adapter | CLI via Bash | **Built, off by default** | Built at the owner's request as `mcp/plangraph-mcp.ts` (docs/MCP.md); enable it only if the evals show it is no worse than the CLI. |
