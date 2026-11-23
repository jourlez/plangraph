# plangraph: plugin excellence research and audit

Date: 2026-11-22. Scope: deep research against primary sources plus an adversarial audit of this repository. Nothing in the plugin was edited; this file is the only output.

Tags: **VERIFIED** = read in a primary source (official docs or repository file) during this session. **SECONDARY** = blog or third-party summary. **UNVERIFIED** = inferred or not testable here. Important limit: the `claude` CLI is not installed in this environment, so nothing below about `claude plugin validate --strict` or `claude plugin eval` was executed against plangraph; those results are predictions from documented rules.

Contents: 1. Sources read; 2. What the best plugins do that we do not; 3. Agent Skills spec applied to our skills; 4. Component best practice; 5. Distribution, trust, CI; 6. Security model; 7. Audit gap table; 8. Target layout and manifests; 9. Ready-to-paste artifacts; 10. What could not be verified.

---

## 1. Sources read (all fetched this session)

Official docs (code.claude.com), VERIFIED:
- Manifest reference https://code.claude.com/docs/en/plugins-reference (fields, userConfig, env vars, standard layout, path rules)
- Components https://code.claude.com/docs/en/plugins/components.md (agents, hooks, bin, monitors, userConfig, data dir)
- Marketplace reference https://code.claude.com/docs/en/plugins/marketplace-reference.md; create https://code.claude.com/docs/en/plugin-marketplaces; host https://code.claude.com/docs/en/plugins/host-marketplace.md
- CLI reference (validate, tag, eval, install) https://code.claude.com/docs/en/plugins/cli-reference.md
- Evals https://code.claude.com/docs/en/plugin-evals.md; measure cost https://code.claude.com/docs/en/plugins/measure.md
- Loading/versions/auto-update https://code.claude.com/docs/en/plugins/loading.md; dependencies https://code.claude.com/docs/en/plugins/dependencies.md; publish https://code.claude.com/docs/en/plugins/publish.md
- Security https://code.claude.com/docs/en/plugins/security.md; hooks https://code.claude.com/docs/en/hooks.md; skills https://code.claude.com/docs/en/skills.md; prompt caching https://code.claude.com/docs/en/prompt-caching.md
- Agent Skills spec https://agentskills.io/specification; Anthropic skill best practices https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices

Real repositories read through `gh api`, VERIFIED:
- anthropics/claude-plugins-official (Apache-2.0, ~48k stars at read time): `plugins/plugin-dev`, `plugins/security-guidance` (hooks + 100+ pytest files), `plugins/ralph-loop`, `.github/workflows/{validate-plugins,scan-plugins,validate-licenses,bump-plugin-shas,check-mcp-urls,revert-failed-bumps,close-external-prs}.yml`
- anthropics/claude-plugins-community `.github/actions/validate-plugins` (README, RELEASING, invariants I1-I11)
- anthropics/knowledge-work-plugins (layout: one folder per plugin, `.claude-plugin/plugin.json`, `skills/`, `.mcp.json`, `CONNECTORS.md`)
- anthropics/skills (`spec/`, `template/`, `skills/skill-creator` with `agents/`, `eval-viewer/`, `references/`, `scripts/`)
- obra/superpowers (MIT, ~324k stars; SECONDARY for popularity, VERIFIED for file contents): hooks, `tests/` (skill-size, skill-layout, shell-lint, version-bump), `.version-bump.json`

Third-party (SECONDARY): marketplace roundups (buildtolaunch, ayautomate, designrevision) say the reviewed community marketplace `anthropics/claude-plugins-community` is the most-recommended third-party source; counts and rankings are editorial and inconsistent. Security guides (matthewswong.com, mintive, pluto.security) repeat the unsandboxed-hooks risk; I rely on Anthropic's own security page for the facts.

---

## 2. The top 5 and what they do that we do not

The five reference points, chosen by authority and quality of engineering: (1) `plugin-dev` (Anthropic), (2) `security-guidance` (Anthropic, the only reference plugin with a serious test suite), (3) the claude-plugins-official/-community CI and validation action, (4) `skill-creator` (anthropics/skills, evals), (5) `superpowers` (largest community plugin; engineering of hooks and tests).

| # | Reference | What it does | We lack |
|---|---|---|---|
| 1 | plugin-dev (VERIFIED, plugins/plugin-dev) | Ships 7 skills with `references/`, `examples/`, `scripts/` per skill (progressive disclosure), 3 agents (`plugin-validator`, `skill-reviewer`, `agent-creator`) with `<example>` triggering blocks, a `/create-plugin` command, own LICENSE and README | Zero `references/` use; our 3 skills are single files; no agents (our `briefs/` are agent prompts that are not registered agents); no per-plugin LICENSE |
| 2 | security-guidance (VERIFIED) | Hooks with `if` filters (`Bash(git*commit*)`), `asyncRewake`, timeouts per hook (180s bootstrap), a launcher shim `sg-python.sh`, ~100 `tests/test_*.py` including launcher, timing, prompt-cache, Windows lookup tests, `README` | No hook-level tests (only a smoke script), no launcher hardening for PATH/Windows, no timing test |
| 3 | Official CI (VERIFIED) | Required checks `validate`, `scan`, `check`; frontmatter validation of every agent/skill/command; license check; `claude plugin validate`; every external source pinned to a 40-char `sha`; nightly SHA-bump PRs; scans cached per (plugin, sha); actions pinned by SHA; `permissions: contents: read` | No CI at all (no `.github/`), no license file, no SHA pinning story, no frontmatter linter |
| 4 | skill-creator (VERIFIED dir listing; behaviour VERIFIED via skills docs) | Evals per skill with baseline (with/without), blind A/B, description tuning with should/should-not-trigger sets, benchmark.json | Zero evals; description never measured against triggering |
| 5 | superpowers (VERIFIED) | `tests/` for skill-size, skill-layout, shell-lint, version-bump consistency across 12 manifests (`.version-bump.json`), hardened `session-start` script (no subshells, PATH-independent, JSON escaping, handles platform differences), RELEASE-NOTES.md | No release notes/changelog, no version-bump consistency check, hook script not hardened (see GAP-05) |

Honest counterpoint: superpowers injects an entire skill body (`<EXTREMELY_IMPORTANT>` block) at every SessionStart; that is the opposite of our token budget rule and our approach (a ~100 token card) is better. Keep it.

Things the top plugins do that are NOT worth copying here: multi-platform manifests (`.cursor-plugin` etc.), MCP servers (adds always-on tool schemas), output styles, themes, mods.

---

## 3. Agent Skills spec and Anthropic guidance, applied to our three skills

Facts (all VERIFIED):
- Spec `name`: 1-64 chars, lowercase letters/digits/hyphens, no leading/trailing/double hyphen, must equal the directory name. `description`: required, **max 1024 chars**, say what it does AND when to use it. `compatibility` max 500 chars, `license`, `metadata` (string map), `allowed-tools` space-separated, experimental. (agentskills.io/specification)
- Progressive disclosure: metadata (~100 tokens) at startup, body (<5000 tokens recommended, <500 lines) on activation, `scripts/`, `references/`, `assets/` on demand; references one level deep from SKILL.md; reference files over 100 lines get a table of contents. (spec; best-practices page)
- Claude Code listing: combined `description` + `when_to_use` truncated at **1,536** chars per entry; listing budget is 1% of context window; angle brackets in descriptions render as `&lt;`/`&gt;`. (skills docs)
- Once invoked, a skill body stays in the conversation; after compaction only the first 5,000 tokens of each invoked skill are re-attached, 25,000 combined, most recent first; put the critical rules at the top. (skills docs)
- `disable-model-invocation: true` removes the skill from model triggering; user runs it as `/plugin:skill`. Plugin skill command name is `/<plugin>:<directory>`. (components page)
- `${CLAUDE_SKILL_DIR}` resolves to the skill's own directory for plugin skills; use `${CLAUDE_PLUGIN_ROOT}` for plugin-wide files. `allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/x *)` pre-approves a bundled script. A failing `!`cmd`` aborts the skill load, so append `|| true`. (skills docs)
- Best practices: third-person descriptions, trigger keywords users actually say, concise body, scripts that solve rather than defer, evaluate with at least three scenarios and on Haiku/Sonnet/Opus. Anthropic's own plugin-dev examples use "Use when..." and "This skill should be used when..." phrasing (both VERIFIED in repos/docs).

Applied to ours (measured on the files):

| Skill | Description length | Findings |
|---|---|---|
| brain | ~420 chars, under limits | Lists nouns, not the phrases a user types. No "when NOT to use". The body is imperative and good. Lacks `allowed-tools` so every `brain ...` prompts in default permission mode. Critical rules are at the bottom (compaction keeps only the head). No `references/`: command table and rules fit, fine at 2.9 KB, but the rules block should move above the command list |
| brain-init | ~235 chars | `disable-model-invocation: true` means the model will never offer it; but the brain skill's first line tells Claude to run `brain init` anyway when no brain exists, so the guard is partly bypassed. Decide one path |
| brain-audit | ~240 chars | Same flag. Procedure is sound. References `briefs/` and `workflows/` by relative name; inside a plugin those must be written as `${CLAUDE_PLUGIN_ROOT}/briefs/auditor.md` (substituted in skill content, VERIFIED) otherwise the model searches the user's project. Currently the text says `briefs/auditor.md` (skills/brain-audit/SKILL.md step 4) |

Also: our validator (`test/validate-plugin.ts:15`) enforces 1,536 chars (Claude Code limit) but the portable Agent Skills limit is 1,024; fail at 1,024 if you want the skills usable in other agents.

---

## 4. Plugin component best practice

### 4.1 Hooks

VERIFIED facts:
- SessionStart matchers: `startup`, `resume`, `clear`, `compact`, `fork`. On exit 0 plain stdout becomes context; structured form `hookSpecificOutput.additionalContext`. Exit 2 shows stderr to the user only; the session proceeds. Injected strings are capped at **10,000 chars** (over the cap: saved to a file, Claude gets path + first 2,000 chars). Default timeout for `command` is 600 s. (hooks.md)
- Hooks re-run on `resume` and `fork`, but the earlier `additionalContext` is already saved in the transcript and replayed, so a resumed session carries the old card plus a new card (hooks.md; my inference about duplication is UNVERIFIED by test).
- Exec form (`command` + `args`) spawns without a shell; on Windows exec form needs a real executable, so use `"command": "node"` with the script in `args`; `.cmd`/`.bat` shims do not spawn. (hooks.md)
- Prompt caching: skills and hook context are appended to the conversation, so adding them does not break the cached prefix; enabling a plugin with skills/commands/agents/hooks never invalidates the cache; a plugin providing MCP servers can (prompt-caching.md). Therefore a **stable, small, deterministic card** is cache-safe; the cost is only its own tokens each session. A card that embeds a timestamp does not break the prefix either (appended at session start) but goes stale on resume (hooks.md notes this).
- Plugin hooks are not gated on the plugin's skills being used; they fire from session start. Two enabled plugins with the same manifest name: one plugin's hooks are silently left out. (components.md, loading.md)
- Hooks, monitors, MCP/LSP servers run outside the sandbox with full user permissions; Bash-tool permission rules cover only Claude's own tool calls, including a Bash command that runs a `bin/` executable. (security.md)

Our hook (`hooks/hooks.json`): exec form, `${CLAUDE_PLUGIN_ROOT}`, timeout 10, matcher with all 5 sources, silent exit 0 when no brain or old Node (bin/brain:48). That is already better than most. Residual issues in the gap table (GAP-04, GAP-05).

### 4.2 `bin/`

VERIFIED: files in `bin/` are on the Bash tool's PATH while enabled, after the user's own PATH (cannot shadow `git`/`ls`); claude.ai and Cowork refuse to install a plugin with a top-level `bin/`, and organization sync rejects it. `${CLAUDE_PLUGIN_ROOT}`/`CLAUDE_PLUGIN_DATA` are NOT present in the environment of commands Claude runs through Bash (components.md, manifest reference). Consequence for us: `brain-solve-run` reads `${CLAUDE_PLUGIN_DATA:-$HOME/.cache/project-brain}` (bin/brain-solve-run:9), so inside a Bash call it always falls back to `~/.cache/project-brain`. Harmless but the `CLAUDE_PLUGIN_DATA` branch is dead code via the Bash tool; it only works from hooks. Either set it explicitly via a skill instruction or drop it.

### 4.3 userConfig (answering the question directly)

VERIFIED: yes, `plugin.json` supports `userConfig`; each option needs `type` (string|number|boolean|directory|file), `title`, `description`; optional `required`, `default`, `options` (fixed pick list, needs v2.1.271+), `multiple`, `sensitive`, `min`/`max`. Non-sensitive values go to `pluginConfigs` in settings.json; `sensitive: true` values go to the platform secure credential store. A saved value is available as `${user_config.KEY}` (MCP/LSP config, **exec-form** hook `args`, skill and agent body for non-sensitive values) and as `CLAUDE_PLUGIN_OPTION_<KEY>` in hook process environments. Shell-form hook commands and monitors reject `${user_config.*}`. Prompts appear in `/plugin`; `claude plugin install` never prompts; use `--config KEY=VALUE` or `claude plugin configure --values-stdin`. (manifest reference, components.md, cli-reference)

**Adversarial conclusion for us: do NOT move the Jira token into userConfig.** The values are exported to hook processes only; the Bash tool environment does not receive them, and `brain jira-pull` is run by Claude through Bash. A sensitive userConfig token would be unreachable by the command that needs it. Keep env / 1Password / keychain (already implemented and good: lib/jira.ts:90-104). userConfig is useful for non-secret, hook-time behavior:
- `card` (options `auto` | `off`, default `auto`) so a user can turn off the SessionStart injection without disabling the plugin (passed to the hook via exec-form `args`).
- optionally `card_max_tokens` (number, min 40, max 250).
Cost: requires Claude Code >= 2.1.271 for `options`; `engines` field requires >= 2.1.323 and older versions (2.0.15-2.1.75) reject manifests containing it (VERIFIED). State the minimum version in README and `engines`.

### 4.4 Subagents (`agents/*.md`) worth shipping

VERIFIED: plugin agents support `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation: worktree`, `color`; they ignore `permissionMode`, `hooks`, `mcpServers`. Named `<plugin>:<name>`; invoked with `@agent-plangraph:<name>`.

Recommendation: promote `briefs/auditor.md`, `reverify.md`, `loop-reader.md` to real agents with a **read-only tool allowlist** (`tools: Read, Grep, Glob, Bash`, `disallowedTools: Write, Edit` except the one output file is a problem: the brief says "the only file you write is your output JSON"; give the agent `Write` but instruct and enforce through a PreToolUse hook? agents cannot carry hooks; so keep `Write` and accept, or have the agent return JSON in its final message and let the parent write it). Benefits: model pinning (`model: sonnet`), `maxTurns: 40` mirrors the brief's "Max 40 tool calls", discoverable via `/agents`, and the tool allowlist enforces "read-only" in code instead of prose. Also add one new agent, `plan-reviewer` (read-only; runs `brain check`, `brain verify`, `brain stale`, summarizes in under 150 tokens). Keep `briefs/` as the canonical text and have `agents/*.md` bodies short and reference them, or delete duplication.

Slash commands: the docs say new work should be skills, not `commands/` (VERIFIED). So `/brain-report` and `/whatif` should be **skills with `disable-model-invocation: true`** (user-triggered, side-effect free), not commands:
- `skills/whatif/SKILL.md` argument-hint `[KEY] [--to NAME] [--sprint N]`, body runs `brain whatif $ARGUMENTS` (use `$ARGUMENTS` substitution) and shows the result; read-only with `allowed-tools: Bash(brain whatif *)`.
- `skills/brain-report/SKILL.md` with a `!`brain check || true`` / `!`brain stale --list || true`` dynamic block so the report is assembled before Claude sees it (zero extra turns).
Note: whatif already exists inside the `brain` skill table; a separate user-invocable `/plangraph:whatif` is a discoverability win, not a capability win.

### 4.5 Monitors, LSP, MCP, dependencies, engines

- Monitors (experimental; run unsandboxed; do not start under `-p`; cannot use `${user_config.*}`): not justified. A "plan went stale" monitor would poll the filesystem every session for value that `brain stale` provides on demand. Skip.
- LSP: not applicable. MCP: not justified; the CLI plus skill already beats a tool schema on the token budget (contract rule 2), and an MCP server forfeits the `bin/`-based zero-always-on-cost design. A reasoned "no" belongs in docs/DESIGN so it is not re-litigated.
- `dependencies`: none needed (no other plugin). Do not add.
- `engines.claude-code`: add `">=2.1.323"` once userConfig options are used; document the trade-off. `network.hosts` (v2.1.328+, informational, validated by `claude plugin validate`): add `["api.atlassian.com", "*.atlassian.net"]` so reviewers see the network surface (matches lib/jira.ts:46,64).
- Node: the real minimum is **Node 24** (bin/brain:48 exits 2 below 24) but README.md:6 and docs/CONTRACT.md:9 say 22.13+. Fix the docs (or lower the guard); package.json already says `>=24`.

---

## 5. Distribution and trust

VERIFIED facts:
- `marketplace.json` requires `name`, `owner{name}`, `plugins[]` (each `name` + `source`). `description` missing gives a warning. `metadata.pluginRoot`, `renames`, `forceRemoveDeletedPlugins`, `allowCrossMarketplaceDependenciesOn`, `$schema` (editor only) exist. Unknown keys are warnings.
- Plugin sources: relative path, `github`, `url`, `git-subdir` (all with `ref` and a 40-char lowercase `sha`), `npm`, `archive` (`sha256`), `command`. When both `ref` and `sha` are set, `sha` is checked out.
- Version resolution: manifest `version` > entry `version` > commit SHA (12 chars). Pinning `version` means users never update until you bump it; omit it to track every commit; never set both (plugin.json silently wins, validate warns). Marketplace auto-update is **off by default for third-party marketplaces**; users turn it on in `/plugin`, or admins set `autoUpdate`.
- Pin a marketplace itself with `owner/repo#<ref>` on the add command (host-marketplace.md); marketplace `ref` as a full SHA needs Claude Code >= 2.1.324 and is refused for reserved names.
- `claude plugin tag [path] [--push] [--dry-run]` creates annotated tag `<name>--v<version>`, checks `plugin.json` and the marketplace entry agree on the version, requires a clean tree, refuses an existing tag. Dependency ranges resolve against these tags.
- `claude plugin validate <path> [--strict] [--json]`: exit 0/1, 2 on an unexpected error; `--strict` turns warnings into failures; given a directory containing both marketplace.json and plugin.json (v2.1.289+) it validates both plus component files. It does NOT read `.lsp.json`, and for a marketplace run does not open other plugins' skills.
- `claude plugin eval`: cases in `evals/<case>/prompt.md` + `graders/*.md` (types `regex`, `tool_used`, `tool_order`, `file_exists` free; `llm`, `baseline` call a judge). 3 runs per case by default, with-plugin vs no-plugin baseline (`WITH`, `W/OUT`, `Δ`). CI flags: `--trust-plugin --json results.json --threshold 0.8 --model ... --judge-model ... --no-publish --max-cost-usd N`. Exit 0 pass, 1 below threshold or load/API failure, 2 partial (cost ceiling or auth), 143 timeout. Δ never changes the exit code. Requires Claude Code >= 2.1.269 and Git >= 2.31. Cost is real model spend. Cases cannot use custom code graders.
- Headless install in CI: `claude plugin marketplace add ./ && claude plugin install plangraph@plangraph-marketplace --scope user` (shell), `--json`, `-y` only matters for command sources; a marketplace added from a local path loads the plugin **in place** (no cache copy, no version needed), which is what you want in CI.
- Trust UI: before install the details pane shows a "Will install" component list and a generic trust warning; a plugin in the official marketplace also shows context cost (our own marketplace shows none). `claude plugin details <name>` prints component inventory and always-on token estimate (measure.md). The `claude-community` catalog pins nearly every entry to a commit SHA and Claude Code refuses a different commit.
- Signed releases / provenance: Claude Code verifies only `sha` (git sources) and `sha256` (archive sources). It does **not** verify Sigstore/GitHub attestations or git tag signatures (nothing in the install docs mentions it; absence of evidence, UNVERIFIED as a negative). So provenance is a human/CI-verifiable trust signal, not an install-time gate.

Recommended distribution design for a one-plugin, single-repo project (decision with rationale):
1. Keep the plugin at the repo root with the marketplace in the same repo (what you have; `source: "./"` is the documented single-plugin form, publish.md).
2. Choose explicit semver: keep `version` in `plugin.json` only, remove it from marketplace entry (already absent). Bump on every release, `claude plugin tag --push`, and document that users should add the marketplace pinned: `claude plugin marketplace add OWNER/plangraph#plangraph--v0.2.0`. That gives exact-version, no-surprise installs; users who want latest add without `#ref`.
3. When the project has external consumers: move the marketplace to a tiny separate repo whose entry uses `github` + `ref` + `sha`, and add the official nightly "bump PR" pattern (bump-plugin-shas.yml) so every release goes through a PR and CI. This is how `claude-plugins-official` treats third parties (VERIFIED).
4. Release assets: zip + sha256 + GitHub build-provenance attestation, so a cautious org can use an `archive` source with `sha256` (the only integrity-checked non-git form). Attestation verification is manual: `gh attestation verify` (UNVERIFIED version-specific syntax).

Exact CI design (ready to paste) is in section 9.3.

---

## 6. Security model: what a high-trust plugin must document and enforce

Facts (VERIFIED, security.md): installing a plugin lets it run arbitrary code with user privileges; hooks, monitors, MCP/LSP processes run outside the sandbox and outside permission rules; `bin/` executables are on Bash PATH; skills/agents/commands are instructions that steer the model; auto-update can change files after review; a loaded plugin registers hooks immediately, so review the source before loading.

What plangraph ALREADY does well (keep, and say so in SECURITY.md): network only in `lib/jira.ts` (contract rule 3); allowlisted Atlassian hosts with an anti-redirect pin (lib/jira.ts:46-66); tokens from env/1Password/keychain, never argv, never written (docs/JIRA.md); token redaction (lib/jira.ts:26); committed config treated as untrusted and Data Center host never read from the repo; hook is silent and read-only; zero npm dependencies (no supply chain through npm; Claude Code's auto dependency install would not even trigger without a lockfile, VERIFIED loading.md); the Python solver pins `ortools==9.15.6755` (bin/brain-solve-run:5).

What a high-trust plugin must additionally document and enforce (all missing today, see gaps):
1. SECURITY.md: threat model in 10 lines (what runs unsandboxed: one SessionStart hook + `bin/*`; what it reads: `.brain/`, `.brainrc`, git; what it writes: `.brain/` and `.git/config` (merge driver) and `~/.cache/project-brain` (venv); network: Atlassian read-only, only on explicit `jira-pull`), a vulnerability disclosure channel, supported versions.
2. A "what runs on my machine" table in README: hook command line, all bin entry points, the git config mutation, the one-time venv/pip install in `brain-solve-run` (it runs `pip install ortools==...` from PyPI at first solve: a network + supply-chain event that contract rule 3 and the README do not disclose; `uv run --with` does the same).
3. `network.hosts` in the manifest (informational, VERIFIED) plus PyPI/uv hosts for the solver: list `pypi.org`, `files.pythonhosted.org` as optional.
4. Integrity: hash-pin the solver wheel (`pip install --require-hashes -r`) or vendor a `requirements.lock` with hashes; `uv run --with` supports a lock only with a project, so use `uv run --with-requirements`. UNVERIFIED flags; test before adopting.
5. Release provenance: signed tags (`git tag -s`), build attestation, SHA/sha256 published in release notes.
6. Update hygiene: CHANGELOG entry that lists any change to hooks, bin, git-config writes, or network hosts under a "Security-relevant changes" heading, since auto-update can change these silently.
7. Merge-driver: writing `merge.brain-jsonl.driver` into `.git/config` executes a path as a program during `git merge`. Document it (bin/brain:95, lib/store.ts:289); fix the stale-path bug (GAP-01).

---

## 7. Audit: gap table

Severity: P0 = breaks users or trust now; P1 = high; P2 = medium; P3 = polish. Effort: S under 2 h, M under 1 day, L multi-day.

| ID | Gap | Evidence | Sev | Concrete fix | Effort |
|---|---|---|---|---|---|
| GAP-01 | **Git merge driver stores an absolute path into the versioned plugin cache.** After a plugin update the old version directory is orphaned and deleted 14 days later (VERIFIED loading.md "Cleanup of previous versions"), so `git merge` of `.brain/*.jsonl` then fails or falls back to a text merge with conflict markers; `brain doctor` only reports it when run. Worse, `import.meta.dirname` in a marketplace install is the cache path. | bin/brain:95 and bin/brain:502 (`driverPath: path.join(import.meta.dirname,'brain-merge')`); lib/store.ts:289 writes it into `.git/config`; I reproduced: `git config merge.brain-jsonl.driver` = `<home>/.../plangraph/bin/brain-merge %O %A %B %P` | P0 | Install a stable shim: write `${CLAUDE_PLUGIN_DATA}/bin/brain-merge-shim` (outside the version dir) that `exec node <current-root>/bin/brain-merge "$@"`, and let the SessionStart hook re-run `brain doctor --fix --quiet` (cheap, idempotent) so the shim target tracks the current version. Alternative: driver command `node -e` resolving through `git config` of a user-level path updated by the hook. Add a test that simulates a moved root. | M |
| GAP-02 | **No CI whatsoever.** 223 unit tests and a smoke test exist but nothing runs them on PR, no `claude plugin validate --strict`, no frontmatter lint, no matrix over OS/Node. Official and top community repos all have CI (VERIFIED). | `ls .github` -> none; `git ls-files` shows no workflows | P0 | Add workflow in section 9.3 (unit on ubuntu+macos, validate --strict, skills-ref, eval on schedule/same-repo PRs). | M |
| GAP-03 | **No LICENSE file, no CHANGELOG, no SECURITY.md, no CONTRIBUTING.** `plugin.json` says `"license":"MIT"` with no file to back it (official repo enforces a LICENSE per plugin via validate-licenses.yml, VERIFIED). | `git ls-files` (17 files, none of these) | P0 for a trust plugin | Add MIT LICENSE, CHANGELOG.md (Keep a Changelog, with a "Security-relevant" label), SECURITY.md (section 6), CONTRIBUTING.md (point to docs/CONTRACT.md). | S |
| GAP-04 | **Repository state: 8 modified + 2 untracked files uncommitted, including bin/brain-merge and bin/brain-solve-run, which hooks.json/README rely on; no remote; 7 commits.** A marketplace install of HEAD would miss `brain-merge` and `brain-solve-run` (the README promises both on PATH). | `git status`: ` M bin/brain-solve`, `?? bin/brain-merge`, `?? bin/brain-solve-run` | P0 | Commit; make CI fail on a dirty tree for tag builds; add `claude plugin tag` only from clean tree (the CLI already requires it). | S |
| GAP-05 | **Hook is not hardened for PATH/Windows/startup edge cases.** `command` is a script with `#!/usr/bin/env node` shebang; superpowers documents a SessionStart with a broken/empty PATH (SECONDARY, in its source comment citing claude-code#43127) and exec form on Windows needs a real executable (VERIFIED). A missing `node` makes the hook print an error to the user every session start. | hooks/hooks.json:7 (`"command": "${CLAUDE_PLUGIN_ROOT}/bin/brain"`) | P1 | Use `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/bin/brain","card","--if-present"]`; add a 5-line `bin/brain-hook` POSIX sh wrapper only if you need `command -v node || exit 0` (silent on missing node). Document Windows as unsupported or test it. | S |
| GAP-06 | **Docs contradict code on the Node floor.** README and CONTRACT say 22.13+, code exits at <24, package.json says >=24. A Node 22 user gets exit 2 on every command except the silent hook. | README.md:6; docs/CONTRACT.md:9; bin/brain:48; package.json engines | P1 | Pick 24 (matches code) and fix both docs; add the check to `brain doctor` output and to validate-plugin.mjs (grep README for the number). | S |
| GAP-07 | **No evals; skill triggering is unmeasured.** The brain skill exists to be triggered by planning questions; nobody knows its hit rate or false-trigger rate. The docs say to use `tool_used: Skill` graders after each description change (VERIFIED). | no `evals/` dir | P1 | Add `evals/` (section 9.5): 4 should-trigger, 3 should-not-trigger, 2 behavior cases (brain ready exit 1 relayed; no Jira write). Run `claude plugin eval . --ablation none --runs 1` locally while iterating, `--threshold 0.8` in CI. | M |
| GAP-08 | **Skill `brain` has no `allowed-tools`**, so each `brain ...` call needs a permission click; and critical rules sit at the bottom (compaction keeps only the first 5,000 tokens, fine here, but order still matters for attention). | skills/brain/SKILL.md (no allowed-tools; rules after table) | P1 | Add `allowed-tools: Bash(brain ready *) Bash(brain ticket *) Bash(brain neighbors *) Bash(brain chain *) Bash(brain sprint *) Bash(brain person *) Bash(brain blockers) Bash(brain findings *) Bash(brain rules *) Bash(brain check) Bash(brain card *) Bash(brain stale *) Bash(brain whatif *)` and **exclude** `jira-pull`, `schedule-load`, `refs-update`, `export`, `build`, `init`, `compact`, `claim`, `open-items --write/--close`, `whatif --write`. Verify exact rule syntax with a live run (UNVERIFIED: whether the pattern `Bash(brain whatif *)` also matches `--write`; if so drop whatif from the list). | S |
| GAP-09 | **Plugin-relative paths in skills.** brain-audit tells the model `briefs/auditor.md` and `workflows/audit.workflow.js`; in a user's project these do not exist. `${CLAUDE_PLUGIN_ROOT}` is substituted in skill content (VERIFIED). workflows/audit.workflow.js hard-codes `BRIEF = '/ABSOLUTE/PATH/TO/plangraph/briefs'`. | skills/brain-audit/SKILL.md step 4; workflows/audit.workflow.js:11 | P1 | Write `${CLAUDE_PLUGIN_ROOT}/briefs/auditor.md` in SKILL.md; or better, ship agents (GAP-10) and drop the path-passing. Fix the workflow template to read the path from an argument. | S |
| GAP-10 | **Briefs are not registered agents.** Read-only is enforced by prose ("Hard rules: READ-ONLY") not by a tool allowlist; no model pin; no `maxTurns`. | briefs/auditor.md, briefs/reverify.md, briefs/loop-reader.md; no `agents/` | P2 | Add `agents/ticket-auditor.md`, `agents/verdict-reverifier.md`, `agents/loop-reader.md`, `agents/plan-reviewer.md` (section 9.6). Keep briefs as source or inline them and delete the duplicates. | M |
| GAP-11 | **Manifest incomplete for strict validation and trust.** `plugin.json` lacks `author`, `homepage`, `repository`, `engines`, `network`; marketplace lacks top-level `description`, `$schema`, and a distinctive name. `claude plugin validate --strict` is documented to warn on missing author/description/version (VERIFIED) so predicted to FAIL in strict mode (UNVERIFIED: not run). The marketplace name `plangraph-marketplace` is generic enough to collide ("a user can't have two marketplaces with the same name", VERIFIED). | .claude-plugin/plugin.json, marketplace.json | P1 | Section 8 manifests. Marketplace name: `<owner>-plugins` pattern. | S |
| GAP-12 | **Undisclosed install-time network and code fetch in the solver launcher**: first `brain-solve-run` does `pip install ortools==...` into a venv or `uv run --with`; not mentioned in the README trust text, nor pinned by hash. Contract rule 3 ("no network except lib/jira.ts") is violated by `bin/brain-solve-run`. | bin/brain-solve-run:5-17 | P1 | Document in README/SECURITY; add `--require-hashes`; amend CONTRACT rule 3 ("or the solver bootstrap, bin/brain-solve-run, which fetches one pinned wheel from PyPI") so the contract stays true; add to `network.hosts`. | S |
| GAP-13 | **userConfig unused; users cannot turn the SessionStart card off** without disabling the plugin. | hooks.json unconditional | P2 | Add `card` userConfig option (section 8) and pass via exec-form args; fallback env `BRAIN_CARD=off`. | S |
| GAP-14 | **Hook re-injects on resume/fork** though transcripts already carry the earlier card. | hooks.json matcher `startup|resume|clear|compact|fork`; docs: context saved in transcript (VERIFIED) | P3 | Either keep (refresh is a feature after plan edits) or drop `resume|fork`; best: `brain card` prints a one-line "unchanged since last card (hash)" when the hash equals the one stored in `.brain/.cache`. Measure with `claude plugin details` + /context. | S |
| GAP-15 | **Validator is hand-rolled and weaker than the CLI**, and uses the 1,536 limit rather than the portable 1,024; no check that every referenced path in skills exists, no frontmatter key allowlist, no LICENSE/CHANGELOG/README install-line check; README claims the install flow was "built to the documented layout but not run in a live session". | test/validate-plugin.ts:15; README.md "Status and limits" | P2 | Keep it as a fast offline check, but make CI run the real `claude plugin validate . --strict --json` first; lower to 1,024; add skills-ref. Run the live install flow in CI (`claude plugin marketplace add ./`, `install`, `details`) and delete the README caveat once green. | M |
| GAP-16 | **README facts to correct**: "Run the `/brain-init` skill" (actual command `/plangraph:brain-init`, VERIFIED naming rule); claims Node 22.13+; the "claim" and merge-driver per-clone step lack a "what runs on your machine" block; no uninstall/data-removal note (`CLAUDE_PLUGIN_DATA` deleted on uninstall, VERIFIED, includes the solver venv). | README.md lines 6, 10 | P2 | Rewrite README header per section 9.7. | S |
| GAP-17 | **No version-consistency or release gate.** `claude plugin tag` exists for this (VERIFIED) but no release procedure is documented; package.json `version` and plugin.json `version` are both "0.1.0" and can drift (superpowers has `.version-bump.json` + a test for exactly this). | package.json, plugin.json | P2 | Add `scripts/check-version.mjs` (package.json == plugin.json == CHANGELOG top entry) to CI; release via `claude plugin tag --push`. | S |
| GAP-18 | **`bin/` is Claude-Code-only.** claude.ai and Cowork do not install plugins with `bin/` (VERIFIED); org sync rejects it. Not stated. | README | P3 | State "Claude Code (CLI/IDE) only" in README and `compatibility` of each skill. Alternative (not recommended): move binaries to `scripts/` and call by `${CLAUDE_PLUGIN_ROOT}` in skills, losing bare-command ergonomics. | S |
| GAP-19 | **Skill description hygiene**: brain-init and brain-audit are `disable-model-invocation: true` yet the brain skill instructs Claude to run `brain init` itself; descriptions are not phrase-driven; no `when_to_use`. | skills/*/SKILL.md | P2 | Section 9.1 rewrites. Decide: init is model-invocable only after the user confirms (remove the flag and add "ask the owner first" in body) OR keep manual and change brain skill line 1 to "tell the owner to run /plangraph:brain-init". | S |
| GAP-20 | **No test for the hook contract.** The hook's guarantees (silent exit 0 without a brain; silent on Node < 24; output < 250 tokens; deterministic) are only covered indirectly by smoke. superpowers/security-guidance test their launchers. | test/smoke.sh; no hook test | P2 | `test/hook.test.ts`: spawn `bin/brain card --if-present` in an empty temp repo (expect empty stdout, exit 0), in a repo with a brain (expect <= 250 tokens by the contract estimator, byte-identical on 2 runs), with a stripped PATH, with `NODE_OPTIONS` hostile. | S |
| GAP-21 | **Security-relevant changes are not labeled**; auto-update can alter hooks silently (VERIFIED security.md). | none | P3 | CHANGELOG convention + a CI check that fails if `hooks/`, `bin/`, `.claude-plugin/` changed without a CHANGELOG line. | S |

Not a gap (checked): hook `timeout: 10` is sensible; exec form is used; matcher values are valid; `${CLAUDE_PLUGIN_ROOT}` prefix is used in hooks; no secrets in logs; `bin/` files are executable; deterministic outputs; tests pass (223 pass, 0 fail, 44 s; smoke OK; validate OK) as run here.

---

## 8. Target layout and manifests

### 8.1 Layout

```
plangraph/
├── .claude-plugin/
│   ├── plugin.json              # + author, homepage, repository, engines, network, userConfig
│   └── marketplace.json         # + $schema, description, distinctive name
├── .github/
│   ├── workflows/ci.yml         # section 9.3
│   ├── workflows/release.yml
│   ├── dependabot.yml           # github-actions ecosystem, weekly
│   └── ISSUE_TEMPLATE/ , PULL_REQUEST_TEMPLATE.md
├── agents/                      # ticket-auditor, verdict-reverifier, loop-reader, plan-reviewer
├── bin/                         # brain, brain-merge, brain-solve, brain-solve-run (unchanged; GAP-01 shim written to CLAUDE_PLUGIN_DATA)
├── docs/                        # CONTRACT.md ... + DESIGN.md (why no MCP/monitor), RELEASING.md, research/
├── evals/                       # section 9.5 (claude plugin eval)
├── hooks/hooks.json             # exec form via node, userConfig-gated
├── lib/  seed/  test/  workflows/
├── skills/
│   ├── brain/            SKILL.md (+ references/commands.md, references/rules.md)
│   ├── brain-init/       SKILL.md
│   ├── brain-audit/      SKILL.md (+ references/procedure.md if it grows)
│   ├── whatif/           SKILL.md  (user-invocable shortcut)
│   └── brain-report/     SKILL.md  (dynamic !`cmd` block)
├── scripts/check-version.mjs, scripts/lint-skills.mjs
├── CHANGELOG.md  LICENSE  README.md  SECURITY.md  CONTRIBUTING.md
└── package.json                 # private, engines node>=24
```
Do not add: `monitors/`, `.mcp.json`, `.lsp.json`, `output-styles/`, `themes/`, `dependencies`.

### 8.2 plugin.json (target)

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "plangraph",
  "displayName": "Project Brain",
  "version": "0.2.0",
  "description": "Planning memory for Claude Code: a dependency graph of tickets, owners and sprints kept as text in git, answered with one cheap command. No model calls.",
  "author": { "name": "OWNER NAME", "url": "https://github.com/OWNER" },
  "homepage": "https://github.com/OWNER/plangraph",
  "repository": "https://github.com/OWNER/plangraph",
  "license": "MIT",
  "keywords": ["planning", "jira", "knowledge-graph", "memory", "scheduling"],
  "engines": { "claude-code": ">=2.1.323" },
  "network": { "hosts": ["api.atlassian.com", "*.atlassian.net"] },
  "userConfig": {
    "card": {
      "type": "string",
      "title": "Session-start card",
      "description": "Inject the ~100 token plan card at session start. Set to off to disable; the brain command and skills still work.",
      "options": ["auto", "off"],
      "default": "auto"
    }
  }
}
```
Notes: `$schema` URL is a guess at a public schema location and is ignored at load; omit it if unsure (UNVERIFIED URL; the official marketplace file uses `https://anthropic.com/claude-code/marketplace.schema.json`, VERIFIED, for marketplace only). `engines` `>=2.1.323` is required by the docs for the field to be recognised; `options` needs 2.1.271, so 2.1.323 satisfies both. `displayName` is in the manifest reference. Do not put the Jira token here (section 4.3).

### 8.3 marketplace.json (target)

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "OWNER-plugins",
  "description": "Plugins by OWNER. plangraph: planning memory for Claude Code.",
  "owner": { "name": "OWNER NAME", "url": "https://github.com/OWNER" },
  "plugins": [
    {
      "name": "plangraph",
      "source": "./",
      "description": "Planning knowledge graph for Claude Code: query tickets, links, sprints and learnings with one cheap command.",
      "category": "productivity",
      "tags": ["planning", "jira", "scheduling"]
    }
  ]
}
```
No `version` in the entry (plugin.json wins and a mismatch warns; VERIFIED).

### 8.4 hooks/hooks.json (target)

```json
{
  "description": "Inject the plangraph plan card at session start (silent when there is no brain).",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/bin/brain", "card", "--if-present", "--mode", "${user_config.card}"],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```
`brain card --mode off` must print nothing and exit 0 (add to the CLI and to GAP-20 test). `resume|fork` removed (GAP-14); restore if you add the hash-dedupe. `${user_config.card}` is valid in exec-form `args` (VERIFIED). A GAP-01 refresh step (`brain doctor --fix --quiet`) can be a second hook entry with `--quiet` that never prints.

---

## 9. Ready-to-paste artifacts

### 9.1 SKILL.md frontmatter and head (replace the existing front matter; bodies keep their content)

`skills/brain/SKILL.md`:
```markdown
---
name: brain
description: Answers planning questions from the project's brain (a dependency graph of tickets, owners, sprints, readiness verdicts and learnings kept as text in git) with one terse command instead of reading plan files. Use when the user asks who owns a ticket, what sprint it is in, whether a ticket can start, what blocks it, what a reassignment would break, capacity per person or sprint, what changed since the last audit, or before spending tokens on planning agents. Not for writing code or editing Jira.
when_to_use: Phrases like "is TICKET ready", "what blocks", "move X to sprint N", "who has capacity", "which verdicts are stale", "dependency chain", "what if we reassign".
compatibility: Claude Code only (needs the plugin's bin/ on PATH), Node 24+.
allowed-tools: Bash(brain ready *) Bash(brain ticket *) Bash(brain neighbors *) Bash(brain chain *) Bash(brain sprint *) Bash(brain person *) Bash(brain blockers) Bash(brain findings *) Bash(brain rules *) Bash(brain check) Bash(brain card *) Bash(brain stale *)
---

# Project brain

Rules first (they survive compaction):
1. Planning only: no Jira writes, no `--write`, no schedule edits by hand unless the owner says so.
2. Before any move or reassignment run `brain whatif` and show the result.
3. Say which check backs the word "verified" and its covered fraction. Counts in chat, ticket keys only in files.
4. Replan incrementally: `brain stale` first, agents only on stale tickets.
...
```
(Description is about 640 chars, under the 1,024 portable limit; the combined description+when_to_use is under Claude Code's 1,536. `allowed-tools` deliberately omits `whatif`, `jira-pull`, `schedule-load`, `refs-update`, `export`, `build`, `init`, `compact`, `claim`; confirm in a live run before relying on it, GAP-08.)

`skills/brain-init/SKILL.md`:
```markdown
---
name: brain-init
description: Sets up the project brain in the current repository (creates the brain directory, config, generic learnings and the git ignore for the index). Use only when the owner asks to start using the project brain in a repository that has none.
disable-model-invocation: true
compatibility: Claude Code only, Node 24+, git repository.
---
```
`skills/brain-audit/SKILL.md`:
```markdown
---
name: brain-audit
description: Prepares and runs a token-efficient re-audit of only the tickets whose inputs changed (plan text, Jira, code, producers). Use when the owner asks to replan, re-verify readiness, or check what changed since the last audit in a repository that has a brain. Previews cost and asks before spending.
disable-model-invocation: true
compatibility: Claude Code only, Node 24+; Jira steps need credentials in the owner's environment.
---
```
Body change: step 4 uses `${CLAUDE_PLUGIN_ROOT}/briefs/auditor.md` (or the registered agents, 9.6). Everything after the frontmatter stays under 500 lines.

New `skills/brain-report/SKILL.md`:
```markdown
---
name: brain-report
description: Prints a one-screen plan health report (check, stale verdicts, open items, capacity, forecast). Use when the owner runs /plangraph:brain-report or asks for a plan status snapshot.
disable-model-invocation: true
allowed-tools: Bash(brain check) Bash(brain stale *) Bash(brain open-items *) Bash(brain forecast) Bash(brain card *)
---

Summarize in at most 12 lines. Facts only, copy numbers verbatim.

## check
!`brain check 2>&1 || true`

## stale
!`brain stale --list 2>&1 || true`

## open items
!`brain open-items 2>&1 || true`

## forecast
!`brain forecast 2>&1 || true`
```
(`!` blocks run before Claude sees the text; a failing command aborts the load unless `|| true`; admins can disable with `disableSkillShellExecution`, VERIFIED.)

### 9.2 `userConfig` (shown in 8.2)
Verdict: yes, supported; use only for hook-time behavior, never for the Jira token.

### 9.3 GitHub Actions: `.github/workflows/ci.yml`

Design: least privilege (`contents: read`); no secrets on fork PRs; evals only where a key exists; pin every third-party action to a full commit SHA (pin with `pinact` or Dependabot; the official repos do, VERIFIED; I cannot verify SHAs offline so they are placeholders `<SHA>`); pin the Claude Code version; concurrency cancel.

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
    tags: ['plangraph--v*']
  workflow_dispatch:
  schedule:
    - cron: '17 6 * * 1'   # weekly: drift against latest Claude Code + eval baseline

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  CLAUDE_CODE_VERSION: '2.1.330'      # pin; bump via PR. Must be >= 2.1.323 (engines) and >= 2.1.269 (eval)
  NODE_VERSION: '24'

jobs:
  unit:
    name: unit (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest] }
    steps:
      - uses: actions/checkout@<SHA>        # v4
      - uses: actions/setup-node@<SHA>      # v4
        with: { node-version: '${{ env.NODE_VERSION }}' }
      - uses: astral-sh/setup-uv@<SHA>      # solver tests need uv
      - run: node --test test/*.test.mjs
      - run: bash test/smoke.sh
      - run: node scripts/check-version.mjs      # package.json == plugin.json == CHANGELOG top
      - run: node test/validate-plugin.ts

  validate:
    name: claude plugin validate --strict
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: '${{ env.NODE_VERSION }}' }
      - name: Install Claude Code (pinned, with retry as the official repo does)
        run: |
          for attempt in 1 2 3; do
            npm install -g --include=optional "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" || true
            if claude --version; then exit 0; fi
            npm cache clean --force || true; sleep $((attempt * 10))
          done
          echo "::error::Claude Code did not install"; exit 1
      - name: Validate marketplace + plugin + components (strict)
        run: claude plugin validate . --strict --json | tee validate.json
      - name: Validate skills against the Agent Skills spec
        run: |
          python3 -m pip install --quiet skills-ref   # UNVERIFIED package name on PyPI; else clone agentskills/agentskills and run skills-ref
          for d in skills/*/; do skills-ref validate "$d"; done
      - name: Local install smoke (marketplace from path loads in place)
        run: |
          claude plugin marketplace add ./
          claude plugin install plangraph@OWNER-plugins --scope user
          claude plugin details plangraph | tee details.txt
          grep -E 'Always-on:.*~[0-9]+ tok' details.txt
          # budget gate: fail if always-on cost exceeds 400 tokens
          node -e "const m=/Always-on:\s*~(\d+)/.exec(require('fs').readFileSync('details.txt','utf8'));if(!m||+m[1]>400){console.error('always-on tokens',m&&m[1]);process.exit(1)}"
      - uses: actions/upload-artifact@<SHA>
        with: { name: validate, path: '*.json\n*.txt' }

  eval:
    name: claude plugin eval
    # secrets are unavailable to fork PRs; run on same-repo PRs, main, schedule, manual
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    needs: [unit, validate]
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@<SHA>
      - uses: actions/setup-node@<SHA>
        with: { node-version: '${{ env.NODE_VERSION }}' }
      - run: npm install -g --include=optional "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
      - name: Run evals
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          claude plugin eval . \
            --trust-plugin \
            --json results.json \
            --threshold 0.8 \
            --model claude-sonnet-5 \
            --judge-model claude-haiku-4-5 \
            --no-publish \
            --max-cost-usd 5
      - uses: actions/upload-artifact@<SHA>
        if: always()
        with: { name: eval-results, path: 'results.json\nevals/results/**' }
```
The `eval` flags and model IDs are taken from the official CI example (plugin-evals.md "Run evals in CI", VERIFIED: `claude-sonnet-5`, `claude-haiku-4-5`); exit 2 means partial (budget/auth) and fails the job, which is correct. Add `evals/results/` to `.gitignore`.

`.github/workflows/release.yml` (tag push `plangraph--v*`):
```yaml
name: Release
on:
  push:
    tags: ['plangraph--v*']
permissions:
  contents: write        # release
  id-token: write        # attestation (OIDC)
  attestations: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA>
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@<SHA>
        with: { node-version: '24' }
      - run: node --test test/*.test.mjs && bash test/smoke.sh
      - name: Tag must match manifest and CHANGELOG
        run: |
          V=$(node -p "require('./.claude-plugin/plugin.json').version")
          test "${GITHUB_REF_NAME}" = "plangraph--v${V}"
          grep -q "^## \[${V}\]" CHANGELOG.md
      - name: Build archive and checksum
        run: |
          git archive --format=zip --prefix=plangraph/ -o plangraph-${GITHUB_REF_NAME#*--v}.zip HEAD
          sha256sum plangraph-*.zip | tee SHA256SUMS
      - uses: actions/attest-build-provenance@<SHA>      # SECONDARY: action exists; verify current major
        with: { subject-path: 'plangraph-*.zip' }
      - run: gh release create "$GITHUB_REF_NAME" plangraph-*.zip SHA256SUMS --notes-file <(sed -n "/^## \[${GITHUB_REF_NAME#*--v}\]/,/^## \[/p" CHANGELOG.md | sed '$d')
        env: { GH_TOKEN: '${{ github.token }}' }
```
Release procedure (documented in docs/RELEASING.md): bump version in package.json + plugin.json + CHANGELOG; merge; from a clean tree run `claude plugin tag --push` (checks versions agree, clean tree, tag not existing; VERIFIED); CI builds assets and provenance. For consumers who want an integrity-checked install, publish an `archive` entry with the printed `sha256`.

`.github/dependabot.yml`: ecosystem `github-actions`, weekly (keeps SHA pins fresh).

### 9.4 Install and update instructions for README

```
claude plugin marketplace add OWNER/plangraph#plangraph--v0.2.0   # exact release (recommended)
claude plugin install plangraph@OWNER-plugins
# newest instead: drop the #tag. Auto-update is off for third-party marketplaces unless you turn it on in /plugin.
```

### 9.5 `evals/` (claude plugin eval)

Layout per case: `evals/<name>/prompt.md` (frontmatter `max_turns`, `allowed_tools`) and `graders/*.md`. Each run starts in an empty directory, so seed a tiny brain with `context` setup or have the prompt create it with `brain init` first (setup fields in `case.yaml`, VERIFIED to exist; exact schema was not read, UNVERIFIED, read plugin-evals.md "Add setup or history with case.yaml").

`evals/trigger-ready/prompt.md`:
```markdown
---
max_turns: 8
allowed_tools: [Read, Glob, Grep, Bash, Skill]
---
Can ticket ABC-12 start now, or is something still blocking it?
```
`evals/trigger-ready/graders/skill-fired.md`:
```markdown
---
type: tool_used
tool: Skill
input_match: '"skill"\s*:\s*"(?:[\w-]+:)?brain"'
---
```
`evals/no-trigger-code/prompt.md`: "Rename the function getUser to fetchUser in src/a.js." with grader `tool_used` `tool: Skill` `min: 0` `max: 0` and `arm: both` (VERIFIED: this is the documented pattern for a must-not-trigger check). Add: `trigger-whatif`, `trigger-capacity`, `trigger-stale`, `no-trigger-jira-write` ("Create a Jira ticket for X" must not invoke brain mutation), `behavior-ready-exit1` (llm grader: reply states the reason and does not claim ready). Target >= 4 should-trigger, >= 3 should-not-trigger, 3 runs each.

### 9.6 `agents/ticket-auditor.md` (pattern for all four)

```markdown
---
name: ticket-auditor
description: Adversarially audits one unit of tickets prepared by `brain units` and writes a verdict JSON. Use when /plangraph:brain-audit reaches the audit step, or when asked to try to prove tickets are NOT ready.
model: sonnet
maxTurns: 40
tools: Read, Grep, Glob, Bash, Write
color: orange
---
You are a read-only auditor. [Hard rules and procedure from briefs/auditor.md go here; the unit id and folder arrive in the task prompt.]
```
Constraint noted: plugin agents cannot declare `hooks`, so "only write the output file" stays prose; to enforce it, drop `Write`, have the agent return the JSON as its final message, and let the parent write the file (preferred). `plan-reviewer`: `tools: Read, Grep, Glob, Bash`, `model: haiku`, `maxTurns: 10`, description "Use after plan or schedule changes to run brain check/verify/stale and report violations in under 150 tokens".

### 9.7 README opening (replace lines 1-10)

Add above Install a "What runs on your machine" table: (1) SessionStart hook: `node bin/brain card --if-present`, read-only, silent without a brain; (2) `bin/brain`, `bin/brain-merge`, `bin/brain-solve-run` on PATH; (3) `brain init`/`doctor --fix` writes `.gitattributes` and `.git/config` (merge driver); (4) first `brain-solve-run` downloads one pinned wheel (`ortools==9.15.6755`) from PyPI into `${CLAUDE_PLUGIN_DATA}` or `~/.cache/project-brain`; (5) `brain jira-pull` is the only Jira call, read-only, hosts `api.atlassian.com` / `*.atlassian.net`; (6) uninstall deletes plugin data including the solver venv. State: Claude Code CLI/IDE only (no claude.ai/Cowork because of `bin/`), Node 24+, macOS/Linux (Windows untested).

---

## 10. Could not verify

- Everything about `claude plugin validate --strict` and `claude plugin eval` results for THIS plugin: the CLI is not installed here. The strict-failure prediction (GAP-11) comes from documented warning classes only.
- Whether Claude Code re-injects a duplicate card on `resume` (inferred from docs; not observed).
- `allowed-tools` rule matching details for `Bash(brain whatif *)` vs `--write`; run live before shipping GAP-08.
- Exact `case.yaml` setup schema for evals; pip package name `skills-ref` on PyPI; `actions/attest-build-provenance` current major and `gh attestation verify` syntax; the public `$schema` URL for plugin.json; GitHub Actions SHAs (placeholders by design).
- The Claude Code version numbers in CI (`2.1.330`) are a placeholder that satisfies documented minimums; choose the real latest at implementation time.
- Claim that Claude Code does not verify Sigstore attestations or signed tags: no mention found in the install docs; treated as absent, not proven.
- Popularity and "best marketplace" rankings are SECONDARY editorial content; the engineering comparison relies only on files read in the repositories.
- Windows behavior of every script (not tested here).
