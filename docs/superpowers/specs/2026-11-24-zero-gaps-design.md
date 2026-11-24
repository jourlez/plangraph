# Zero known issues, zero playbook gaps: design

Date: 2026-11-24 (revised after the 0.2.1 release). Status: draft for the owner's review. Base: the 0.2.4 tree (private `abad83c`; public `main` `da30467`, same tree; CI run 45354992186 green on all 7 jobs), which is 0.2.3 (private `89193c9`; public `3790b69`, run 45311642500) plus the solver-fallback hotfix of section 7. The measurements below were taken on the 0.2.1 tree (`afeabeb`) and re-checked on 0.2.3 where 0.2.2 and 0.2.3 changed files (only tests, CI, `scripts/baseline.ts`, `scripts/mutate.ts`, version strings and docs changed; `lib/`, `src/` and `mcp/` code did not).
Plans: `docs/superpowers/plans/2026-11-24-zero-gaps-0.3.0.md` (0.3.0) and `docs/superpowers/plans/2026-11-24-graph-model-v2.md` (0.4.0, 0.5.0).

Related specs:
- `docs/superpowers/specs/2026-11-23-tracker-provider-design.md` (tracker provider and tenant alias), refreshed in section 13.
- `docs/superpowers/specs/2026-11-23-graph-model-v2-design.md` (graph model v2), decided in section 14.

## 1. Purpose

Bring the plangraph plugin to a state where `KNOWN_ISSUES.md` lists nothing and every requirement of the owner's three playbooks
(`1-BULLETPROOF.md`, `2-MODERNIZE.md`, `3-AUDIT.md`) is either met or replaced by a named control that satisfies the same intent and is in
force. The plan's gap table is the item-by-item record; this document holds the designs and the decisions behind it.

## 2. Measured state (0.2.1, re-checked on 0.2.3)

Read-only commands run on a copy of `afeabeb` and, where noted, of `89193c9` (Node 24.18.0, 12 cores, `npm ci --ignore-scripts`):

| Check | Result |
|---|---|
| `npm audit --audit-level=high` | 0 vulnerabilities; 28 packages, all dev-only |
| `npx @biomejs/biome lint .` | 0 errors, 1 warning: `scripts/baseline.ts:159` `lint/suspicious/noTemplateCurlyInString` (0.2.3) |
| `npm run typecheck` | 0 errors in `tsconfig.json` and `tsconfig.prod.json` |
| `npx knip` | no findings |
| `npm outdated` | only `@types/node` 26 is newer; 24.x is correct (major equals the Node floor major) |
| Per-file branch coverage below 90 (re-measured on 0.2.3, coverage group with `mcp/**` included; global 99.69 / 96.04 / 98.84) | `src/commands/plan.ts` 80.71, `audit.ts` 86.21, `openitems.ts` 85.90, `shared.ts` 86.89, `integrations.ts` 89.80, `report.ts` 88.89 |
| `mcp/brain-mcp.ts` coverage (with `test/mcp.test.ts`, `test/floor.test.ts`) | lines 88.89, branches 66.67, functions 50.00 |
| `tsc --noUncheckedIndexedAccess` on `tsconfig.json` | 1256 errors on 0.2.3 (test 949, of which `test/bench-tokens.ts` 21 and `test/bench-mcp.ts` 2; scripts 174; evals 133; lib, src, mcp clean) |
| `tsc --noPropertyAccessFromIndexSignature` | 659 errors on `abad83c` (654 on `89193c9`) |
| `tsc --noUnusedParameters` / `--noUnusedLocals` | 51 / 0 errors |
| Biome with the Task 4 configuration | 238 files change with `evals/cases`, `evals/fixtures` and fixture JSON excluded (measured again; 310 when those 71 JSON files were included); 2 new lint warnings appear (`src/registry.ts:21` of the formatted file, `:13` before: a suppression the new layout detaches); Biome unquotes identifier-like property keys (`'x':` to `x:`, about 24 keys in 13 files) unless `quoteProperties` is `preserve`; organize-imports also reorders `export ... from` statements and sorts export specifiers; folder excludes written as `!dist/**` raise 5 `useBiomeIgnoreFolder` warnings; an unknown `"//"` key is refused by Biome 2.6.8; 198 files get import reordering; 50 double-quoted string tokens in 10 files change quotes; `knip.json` (comments) gives 10 parse errors; a git-ignored `.baseline/*.json` is checked without a `vcs` block |
| Lines over 100 characters in `lib`, `src`, `mcp` | 3032 of 8122; 142 of 249 equivalent entries (0.2.3) have a `line` over 100 characters |
| Exports without a block doc comment directly above (heuristic, `abad83c`; a line comment does not count) | 246 of 322 values and 46 of 173 types and interfaces in `lib/`, `src/`, `mcp/` |
| `throw new` inside a one-line `catch` without `cause` (0.2.0) | 5 (`lib/jsonl.ts`, `lib/store.ts`, `lib/jira.ts`, `src/db.ts` twice) |
| Mutation | gated list (`npm run mutate`) 74 mutants since 0.2.3 (four endless-lock mutants added, killed by an attempt count in `test/lock-bound.test.ts`; the quadratic ones killed by deterministic work counts); full generator 14,189 mutants, never run in full |
| Mutation sample (`--files lib/verify.ts --limit 48 --jobs 8`) | 36 decided in tier 1 within about 2.5 minutes including baselines; each survivor runs tier 2 over 70 test files whose single runs sum to 612 s; 12 survivors unfinished after 13 minutes |
| CI | red on the published 0.2.1 (`types.test.ts` without `npm ci`, `normalizeOutput` on Linux, three solver-launcher probes); fixed in 0.2.2; green on 0.2.3 (`3790b69`, run 45311642500, all 7 jobs) |
| CI Node versions | `24` only (latest 24.x), Linux and macOS; Python only uv's default |
| Remote tags | none: no release has a tag, so `release.yml` (attestation) never ran |
| Runtime warnings on Node 24.x (0.3.0 review) | 24.2.0: Type Stripping and SQLite `ExperimentalWarning` on every command, the session hook included; 24.3.0, 24.10.0, 24.14.0: SQLite only; 24.15.0, 24.16.0, 24.18.0: none |
| Old Node and the launcher | current `bin/brain` and an `import()` launcher both print the floor message on Node 20.20.2, 22.16.0, 22.23.1; Node 18 and 20.0 to 20.9 not available locally |

## 3. Release map

| Release | Content | Why it is separate |
|---|---|---|
| 0.2.4 (shipped, untagged; `da30467`) | the solver fallback passes an absolute `--python` found from `bin/` (section 7; decision D22) | a security patch, shipped before 0.3.0 |
| 0.2.2 and 0.2.3 (shipped, untagged; 0.2.3 is `3790b69`) | 0.2.2: CI fixes only (`npm ci` in `unit` and `macos`, `normalizeOutput`, solver-launcher probes); 0.2.3: test fixes only (deterministic work counts and attempt counts for the pinned mutation kills, 74 pinned mutants, known issue K13) | patches, no behavior change |
| 0.2.1 (shipped, `5e08928`, untagged) | the four product bugs, the empty-tenant credential order, the stale mutation equivalents, entry 195, the build-extra scan, uv preparation from `bin`, redaction of base64 at any offset, hex and percent forms | a patch |
| 0.3.0 | every playbook gap, every remaining known issue, the tracker provider and tenant alias | minor: new behavior (heal consent, hook launcher, uv fallback, alias, redaction residue), repository-wide formatting |
| 0.4.0 | graph model v2, expand step (separate plan) | additive data files and views, format version unchanged |
| 0.5.0 | graph model v2, migrate step (separate plan) | `docs/FORMAT.md` section 2 forbids expand and migrate in one release |

The contract step of graph v2 is a later major version (graph spec section 7).

## 4. Formatter adoption (decision D1)

Biome's formatter is disabled today. Turning it on rewrites most files. The mutation tooling pins source text exactly:
`scripts/mutate/equivalent.json` (249 entries on 0.2.3, keyed by file, trimmed line text and mutated line text) and the 74 `[file, from, to, tests]`
pins in `scripts/mutate.ts` (`from` must occur exactly once). A formatting commit therefore needs a tool that carries every pin across it.

Design of `scripts/repin.ts`:
- Significant token streams from `tokenize` (`scripts/mutate-all.ts`): `,` `;` `(` `)` are dropped; string tokens compare by cooked value
  (the formatter changes quote style); number tokens by numeric value (hex digit case); import declarations are grouped per module
  specifier and compared as the set of (name, type-only) specifiers (organize-imports reorders statements and specifiers and merges two
  imports from one module); bare side-effect imports compare as an ordered sequence; `export ... from` declarations and local export lists
  are normalized the same way; a leading `|` or `&` that opens a multi-line union or intersection type is dropped (the formatter adds it, also after `as` and `satisfies`: 6 of the 20 added bars on 0.2.3 follow `as`);
  a quoted identifier-like property key equals the bare name (a guard: the formatter is configured with `quoteProperties: "preserve"`).
  Comments are not tokens, but the leading comment block of each file is compared too (blank lines excluded), because `evals/run.ts` and
  `evals/run-p.ts` print theirs as usage text. Five files keep their header in place only with a blank line before the first import, and
  Biome then adds an empty line after the shebang, so the two usage readers skip empty lines first and are run after formatting.
  Any other difference is a meaning change: the tool stops with the file name.
- The formatter detaches the reason comment of wrapped `as` casts (71 cast lines without a comment become 491, heuristic); Task 4 restores
  them, and the source checklist (0.3.0 Task 10) tests that every cast in `lib`, `src`, `mcp` and `scripts` has its reason on its line, on the line above or on the statement's last line.
- A pin's `from` is located by exact text and occurrence; its new text is the after-source between the first and last mapped token. Its `to`
  is rebuilt by applying the same significant-token replacement to the new `from`.
- An equivalent's new `line` is the trimmed after-line holding the mutated token and its new `mutated` is that line with the same
  replacement. Because shorter lines can repeat (about 7 percent of the equivalents after formatting, measured), an equivalent gains an
  optional `occurrence` (1-based among the mutants with the same line and mutated text); without it, it must match exactly one generated
  mutant (`ambiguous` otherwise).
- Code moved byte-identically to other files (the `lib/jira` split) is re-pinned by `--moved`: the pin's file becomes the one new file holding its `from` exactly once.
- `--write` emits `equivalent.json` in Biome's two-space layout, so a re-pin never breaks `format:check`.
- Biome scope: `vcs.useIgnoreFile` on (git-ignored captures and eval results are never checked); JSON included except `package-lock.json`,
  `test/fixtures/**/*.json`, `test/golden`, `evals/cases`, `evals/fixtures` (their bytes are compared by tests, `test/evals-schema.test.ts:120`);
  `knip.json` becomes `knip.jsonc` and `biome.json` becomes `biome.jsonc` (comments; tests read both through one `readJsonc` helper); the
  fixture exclusion is `test/fixtures/**/*.json` (so `test/fixtures/gen.ts` stays linted); `!dist`, `!coverage`, `!**/*.d.ts`,
  `!**/*.d.cts`, `!**/*.map` excluded (folders without `/**`, which Biome 2.6.8 flags as `useBiomeIgnoreFolder`); `javascript.formatter.quoteProperties` is `preserve`; every rule left `off` carries its reason in a comment; tests call `node_modules/.bin/biome`, never
  `npx biome` (the unscoped package is not `@biomejs/biome`).
- The formatting commit is one mechanical commit (`biome check --write .` repeated until it applies no fix: two passes on 0.2.3),
  preceded by the header commit and followed by the re-pin commit. Lefthook then runs `biome check --write` with
  `stage_fixed: true`, and `assist.actions.source.organizeImports` is on. No `.git-blame-ignore-revs`: since 0.1.1 releases reach the public
  repository as one squashed commit each (earlier public commits are ordinary), so the formatting commit never exists there.
- Style: the playbook's (`space`, 2, `lf`, single quotes, trailing commas `all`, semicolons `always`, arrow parentheses `always`) at line
  width 100.

Recommendation: adopt at width 100, first in 0.3.0. Cost if overruled: B-02, B-04, B-05, B-19, B-25 stay open as owner-accepted deviations.

## 5. Strict flag completion (decision D2)

`noUncheckedIndexedAccess` moves from `tsconfig.prod.json` to `tsconfig.json` (all files, including the non-test files under `test/`);
`noPropertyAccessFromIndexSignature` and `noUnusedParameters` are turned on in both projects; Biome's `noUnusedFunctionParameters` goes to
`error`, and Biome's `useLiteralKeys` goes `off` with a reason comment (it reports every bracket access the flag forces as an info finding, measured with Biome 2.6.8). Ruling R23 of the 0.2.0 ledger declined the second flag because bracket access rewrites pinned lines. Section 4's tool does not remove that cost: it refuses to re-pin across a token change by design, so the pins and equivalents on lines with new bracket access or renamed parameters are re-pinned by hand (listed in the commit, checked by `test/equivalents.test.ts` and `npm run mutate`). The tool carries every other pin, and the hand edits are bounded by its `token-mismatch` list.

Rules for the fixes: prefer declaring a property on the type over `x['y']`; an unused parameter that a signature needs gets a leading `_`;
an index read is narrowed by a check, never by `!`; an assertion keeps its reason comment on its line or the line above (or on the last line of its statement when the formatter wraps it). Runtime tokens stay identical except bracket
access and renamed parameters.

## 6. Launchers for the extensionless entry points (known issue K4, extra item X7)

`bin/brain` must parse on any old Node, so its logic cannot be TypeScript. Every line of logic moves into checked files:

- `bin/brain` becomes exactly: `#!/usr/bin/env node`, one comment line, `import('../src/entry.js');`. `bin/brain-merge` likewise with
  `import('../src/merge-entry.js');`. `test/launchers.test.ts` pins both byte for byte.
- `src/entry.js` (plain JavaScript with JSDoc types, covered by `checkJs` and by Biome through `src/**/*.js`; moving today's body needs JSDoc on two parameters and, with the strict flags of section 5, bracket access on four `process.env` reads) holds today's floor check,
  compile-cache setup (unchanged, before the first `.ts` import) and the import of `src/cli.ts`. `src/merge-entry.js` runs the floor check
  (exit 2 with the floor message, which git treats as a failed merge) and then `src/merge-main.ts`.
- Loader limit: on Node 18 and 20.0 to 20.9 an extensionless file under `"type": "module"` is refused by the module loader
  (`ERR_UNKNOWN_FILE_EXTENSION`) before any code runs, so no extensionless launcher can print the floor message there. An extensioned
  `.js` file loads as an ES module on every Node with ES modules. Therefore the SessionStart hook runs `node <plugin>/src/entry.js card
  --if-present --heal` directly, so the hook is silent on every old Node. `bin/brain` on those versions fails loudly with the loader error;
  the README "Requirements" says so, and the CI floor job records it.

Floor (decision D20): `NODE_FLOOR` rises from 24.2 to 24.15 in the same task, because 24.2 to 24.14 print runtime warnings on every command (section 2); below the floor `src/entry.js` stops before any `.ts` or `node:sqlite` load, so the hook stays silent.

Behavior changes (versioned in 0.3.0): `bin/brain-merge` on a Node below the floor (20.10 and later) exits 2 with the floor message instead
of failing with `ERR_UNKNOWN_FILE_EXTENSION` on its first `.ts` import; the hook launcher path changes. Task 20 writes the README
"Requirements" sentence about old Node from its floor-job evidence (Node 18 and 20.0 to 20.9 are not available locally); Task 16 updates the `SECURITY.md` hook line.

`workflows/audit.workflow.js` stays outside Biome and tsc: it is a template for the Workflow tool, which runs it as a function body, so it
has a top-level `return` (a parse error for both tools) and uses the runtime globals `phase`, `pipeline` and `agent`. Its static check is a
test that replaces its one top-level `export const meta` with `const meta`, wraps the result in an `async function` and runs
`node --check`.

## 7. uv configuration isolation (known issue K1, extra item X2, decision D4)

The risk is configuration discovered from the user's working directory (a repository's `uv.toml` or `pyproject.toml` `[tool.uv]`). The
user's own configuration (`~/.config/uv/uv.toml`, the `UV_*` environment) is legitimate and must keep working.

Hotfix 0.2.4 (0.3.0 plan Task 0; published as `da30467`, private `abad83c`, CI run 45354992186 green on all 7 jobs): uv picks the interpreter of a `uv run` in the working directory from a committed `.venv`
(every version, measured on uv 0.8.8, also with `--no-config` and with `--python '>=3.10,<3.15'`) and from a `.python-version` (uv 0.4.30,
also with `--no-config`; uv 0.8.8 without it), so the published 0.2.3 fallback runs a repository-chosen executable (measured with marker
files). Both fallbacks therefore pass an absolute `--python` found by `uv python find` run from `bin/` (stops both on both versions,
measured); when none is found they exit 3 naming `uv python install 3.14` instead of letting `uv run` download one (decision D22;
`uv python install` itself is not run: on uv 0.8.8 it writes into `~/.local/bin`, measured). 0.3.0 keeps that `--python`.

State in 0.2.1: the two preparation calls (`uv sync --locked --script`, `uv python find --script`) already run from the plugin's `bin/`
directory, so the normal path reads no repository configuration. uv's directory walk from there reaches only user-owned parents (the
plugin cache and the home directory). Residue for 0.3.0:
- The `uv run` fallbacks (an older uv without `sync --script`, or `BRAIN_SOLVE_LAUNCH=uv-run`) must run in the caller's directory (relative
  solver arguments), so they pass `--no-config` (besides 0.2.4's absolute `--python`, which `--no-config` does not replace). `--no-config` also drops the user's own `~/.config/uv/uv.toml` (the cost named in the
  0.2.1 ruling of K1), so the launcher adds `--config-file ${XDG_CONFIG_HOME:-$HOME/.config}/uv/uv.toml` when that file exists and
  `UV_CONFIG_FILE` is unset (uv honors that variable even with `--no-config`; a command-line `--config-file` would override it); mirrors
  set through `UV_INDEX_URL` / `UV_DEFAULT_INDEX` keep working either way. If uv refuses that flag combination, the user file is not read
  on the fallback path and that becomes an owner-accepted limit (D4), documented in `docs/SOLVER.md`, `SECURITY.md` and the CHANGELOG.
- With `BRAIN_SOLVE_SCRIPT` set (tests, mutation checks) and the locked preparation failing, the launcher goes to the hash-verified venv
  path instead of today's unhashed `uv run --no-project --with ortools==...` (extra item X2).
- The venv base follows the `defaultDataDir` rule (`CLAUDE_PLUGIN_DATA` only when absolute) and must pass the data-directory trust rule
  before `rm -rf "$VENV"`; today a relative `CLAUDE_PLUGIN_DATA` puts the venv, and the `rm -rf`, under the caller's directory.
  A missing base is created with `umask 077` (today's `mkdir -p` creates it `775` under a `002` umask, which the trust rule would then
  refuse on every run); an existing group- or world-writable base exits 3 naming `chmod go-w <dir>` (versioned in 0.3.0). The check runs before the first use of `$VENV` (the probe and exec of an existing
  `$VENV/bin/python`, not only `rm -rf`). Claude Code creates `$CLAUDE_PLUGIN_DATA` with the default directory mode (measured `755` under
  umask 022), so under umask 002 it is refused until the user runs `chmod go-w` once, as the merge shim already requires (decision D19).

## 8. Heal only where the user opted in (known issue K2, decision D3)

- Consent: the key `plangraph.heal` (value: the plugin version) in the clone's local git config, the `config` file of the git common
  directory (`git rev-parse --git-common-dir` resolved against the working directory, then its real path; no `--path-format`, which needs git 2.31), so all worktrees of one clone share it. Not a file in the data directory: that directory is
  `$CLAUDE_PLUGIN_DATA` for the SessionStart hook but `~/.cache/project-brain` for `brain init` run from a terminal, so the hook would never
  see a marker written there. The local config cannot be committed, moves with the clone and is not inherited by a new repository cloned at
  the same path. Limit: a repository copied together with its `.git` directory (an archive or a disk copy) carries its consent
  (documented in `docs/ADOPT.md` and the `SECURITY.md` limits).
- Written by `brain init` and `brain doctor --fix` after a successful wiring (`wireMergeDriver(ctx, { consent: true })`).
- Only a version value (`^\d+\.\d+\.\d+`) counts as consent, so `false` or `off` never grants it; the value `never` declines: no heal
  and no nudge.
- `card --heal` repairs only with consent. Without it, and when `doctorMergeDriver` reports a problem, the card prints one line after the
  card, addressed to the user: `brain: merge driver not set up in this clone; the user can run brain doctor --fix`, and writes nothing.
- Grandfathering: when no consent is recorded but the local config already holds `merge.brain-jsonl.driver` (written by an earlier brain,
  whichever data directory its shim lives in), heal records `plangraph.heal` and repairs as before.
  Grandfathering applies only when `plangraph.heal` is unset: any existing value that is not a version, `never` included, disables it
  (`never`: silent; other values: the nudge), nothing is written and the value is left unchanged.

Behavior change (versioned in 0.3.0): a fresh clone with a committed brain directory is no longer wired at session start.

## 9. Redaction of case-changed and partial forms (known issue K3, decision D11)

State in 0.2.1: `registerSecret` stores each secret as is, its URI and JSON escapes, base64 and base64url (whole, and the cores that
match it at any byte offset inside a longer blob), hex in both cases and percent-encoded forms; regular expressions catch `Authorization`
values, `Basic`/`Bearer` values and the `AT?TT` prefix. The 0.2.1 ruling left case-changed and partial tokens out ("none for now; ...
risks redacting ordinary data").

Proposal (D11, overrules that ruling only if the owner agrees): for each registered raw token of 12 or more characters (the API token value only, registered as `registerSecret({ raw: token })`; the base64 Basic credential that `finishCreds` and `makeClient` also register is a derived form and is never windowed), `redact` also
matches it case-insensitively, and any substring of 16 or more characters of it, implemented as a set of the lower-cased 16-character
windows of the secret and a scan of the lower-cased text with extension to the longest match (a token of 12 to 15 characters has no window and is matched whole on the folded text; the `{ raw }` form keeps every whole form a plain string gets) (case folding maps ASCII `A`-`Z` only, so
offsets stay aligned; `toLowerCase()` can change a string's length); cost linear in the text length times the
number of secrets. Derived forms are not widened. False positives need 16 characters in common with a registered token. If D11 is
overruled, K3 becomes an owner-accepted limit documented in `SECURITY.md`.

## 10. Static analysis of every shipped executable (extra items X3, X4)

- Python (`bin/brain-solve`): `ruff check` and `ruff format --check` with `ruff@0.14.5` through `uvx` in CI and `npm run lint:py` locally
  (skips with a notice when uv is absent; exits 1 instead when `BRAIN_REQUIRE_TOOLS=1`, which the CI `static` job sets as step-level env on the `lint:py` and `lint:sh` steps only, with uv installed after its full-suite step, so the check is enforced in CI and the solver tests do not run there). No npm dependency is added.
- Shell (`bin/brain-solve-run`, `test/smoke.sh`): `shellcheck` 0.11.0 in CI (installed from its release tarball with a checked SHA-256, so the runner image's
  version never decides the result) and `npm run lint:sh` locally with the developer's shellcheck.
- Decision D9 records the tool choice.

## 11. Verification that cannot run on the owner's machine

All CI runs of unreleased work use a public snapshot branch (`ci/0.3.0`) made with `git commit-tree HEAD^{tree}` parented on the previous snapshot (on `origin/main` for the first one), so the branch only fast-forwards and the previous snapshot stays fetchable as `github.event.before`, under the owner's GitHub noreply identity (D17); a private branch is never pushed, because the private history holds personal paths and private project names. `ci.yml` gains a `push: branches: ['ci/**']` trigger and `workflow_dispatch` (0.3.0 Task 2), since it ran only on `main` pushes and pull requests.

- Private words: a dedicated `private-words` job holds the `BRAIN_PRIVATE_WORDS` secret and fails without it; every other job runs the
  generic rules only. Fork pull requests skip the job; the owner stores the value as a Dependabot secret too; `release.yml` passes
  `secrets: inherit` to `ci.yml`.

- Full suite matrix: `{ubuntu-24.04, macos-latest} x {24.15.0, 26}` (24.15 is the floor from 0.3.0, decision D20) in the new `compat` job (`portable` group); Node 24 stays covered by the `unit`, `slow` and `macos` jobs; the solver tests run in `slow` on 24.
- Floor job: `{ubuntu-24.04, macos-latest} x {18, 20.9.0, 20, 22, 24.14.0}`: `node src/entry.js card --if-present --heal` exits 0 silent
  and writes nothing; `node src/entry.js explain` exits 3 with the two floor lines; `node bin/brain explain` exits 3 on 20.10+ and is
  recorded on 18 and 20.9.0; `node src/merge-entry.js` on three files exits 2 with the floor message.
- Python matrix for the solver tests: `UV_PYTHON` in `{3.10, 3.14}`, plus one run of the `uv run` fallback with a hostile `uv.toml`.
- Coverage report: `scripts/test-coverage.ts` writes `coverage/lcov.info`, uploaded as an artifact; `mcp/**` joins the coverage include.
- Plugin validation: `npx @anthropic-ai/claude-code@2.1.329 plugin validate . --strict` in the static job (if it needs a login on runners,
  the step is dropped and the owner decides: accepted, X15 leaves `KNOWN_ISSUES.md` and is listed `Accepted (owner, D16)` in the audit
  report with M-07 left Partial; not accepted, X15 blocks the release).
- Package contents: `scripts/check-package.ts` lists `git archive HEAD` and fails on forbidden paths (`.baseline/`, `.superpowers/`,
  `node_modules/`, `*.sqlite*`, `.env*`, `coverage/`) and on a missing required path (`.claude-plugin/plugin.json`, `bin/brain`,
  `src/entry.js`, `hooks/hooks.json`, `LICENSE`, `README.md`). Run in CI and in the release job before the tarball is attested.
- Release dry run on `main` and on the `ci/*` snapshot branches (so the release tree is proven before public `main` is pushed): the tarball, its checksum and the contents check, without `gh release`.
- First tag: decision D13: no tag before 0.3.0, because every earlier tree holds the private-word pieces; Task 24 (tag 0.3.0) produces the first attested release.

## 12. Timing isolation, coverage, mutation and the final gate

- Timing tests (8 files import `test/helpers/perf.ts`) move into `test/*-timing.test.ts` files, run as their own serial group
  (`--test-concurrency=1`) and assert size ratios, never absolute times. 0.2.3 already made every pinned mutation kill deterministic
  (`workScaling`/`builtinWork`, `test/lock-bound.test.ts`); 0.3.0 retires the remaining `budget()` wall-clock gates (K13 (2)), makes
  `npm run mutate` print the failing test on a red baseline (X16), reports `mutate-all` timeouts apart from kills and bounds each one
  by a count (K13 (1)).
- Per-file floor (`scripts/coverage-floor.ts` over `coverage/lcov.info` and the `git ls-files` source list, so a file no test loads, which
  Node's report leaves out, counts as 0): every file under `lib/`, `src/` and `mcp/` at 90 percent branches
  and 95 percent lines, besides the global floors (99 lines, 95 branches, 98 functions); every `throw` line and `catch` body under those
  folders has an lcov hit, except allow-listed sites with a reason (`ERROR_SITE_ALLOW`). `scripts/test-coverage.ts` sets
  `NODE_V8_COVERAGE` so subprocesses spawned by tests (`bin/brain`, `src/entry.js`) are covered. Tests, not exclusions, close the gaps.
- Mutation speed (decision D14): the runner already reuses one copy per worker, restores each mutant in place, runs only mapped test
  files and kills a run at the first failure. The cost is tier 2 for survivors and equivalents. 0.3.0 adds a per-test coverage map (each
  test file run alone under `NODE_V8_COVERAGE`, child processes included, V8 offsets (UTF-16 code units, not bytes) converted to lines) that prunes tier 2 to the test
  files covering the mutated line; a line with no entry runs the current tiers (never reported survived without a run); equivalents are
  counted without running; timeouts are listed separately and excluded from the score. Goal: full run in 15 minutes (sharded) and
  `--changed` in 2 minutes (on a snapshot push its base is the previous snapshot, `github.event.before`, an ancestor because snapshots fast-forward, not `origin/main`, whose diff
  holds the whole release; every run passes `--budget 100`, except the first push of a branch, which falls back to `origin/main` with `--budget 540` and reports an overrun as a
  warning, not a failure; the `changed` job fails only on a survivor or timeout in a security file, a stale equivalent or a spent budget, and a diff without source files exits 0); after measuring, the owner decides (D14) if the goal is missed.
- Mutation bar (decision D6): one `full` job in `mutation.yml` (dispatch and weekly), sharded per D14, plus a `score` job. Zero surviving
  non-equivalent mutants in the security modules (trust roots only: code that executes programs, handles credentials, confines paths or sanitizes output; parsers of committed data are held by the overall floor and the hostile-input fuzz tests) (`lib/jira/*`, `lib/tracker.ts`, `lib/fsafe.ts`, `lib/gitsafe.ts`, `lib/sanitize.ts`,
  `lib/driver.ts`, `src/jira-tenant.ts`, `src/tracker-factory.ts`, `src/entry.js`, `src/merge-entry.js`, `src/merge-main.ts`; the generator's targets include `lib/jira/*` and `src/*.js`, and the `score` job fails when any security file has zero generated mutants); elsewhere no survivor must be resolved (a ratchet, not 100 percent: survivors a test kills cheaply may be killed or recorded as reviewed equivalents), and the measured score becomes the floor
  in `scripts/mutate/score-floor.json`, together with a timeout ceiling (0 for the security files), because timeouts are excluded from the score.
- Zero known issues (decision D8): `test/known-issues.test.ts` compares `KNOWN_ISSUES.md`'s preamble byte for byte; at a release version
  nothing may follow it; between releases (a `-dev` version, which the branch carries from right after each release until the next
  release commit) each entry must name a target release at or above the next release, and the test fails once the version reaches it.
  Recording a new issue during development therefore does not turn CI red, but no release can ship with an entry. An owner-accepted
  limit (for example K3 if D11 is overruled) moves to `SECURITY.md` and is listed as accepted in the audit report, never silently dropped.
- Final audit report: `docs/audit/0.3.0-audit.md` in the `3-AUDIT.md` output format, run with `HAS_CRYPTO: true` (the code hashes fence
  nonces, fingerprints and the index digest, and handles credentials).

## 13. Tracker provider: refresh against 0.2.1

The 2026-11-23 spec stands, with these changes:

- `lib/jira.ts` is 722 lines and exports more (`AUTH_MODES`, `isAuthMode`, `KEY_RE`, `parseSiteRegistry`, `siteTag`, the `Raw*` and option
  types). The module table gains `lib/jira/types.ts` (types, `AuthMode`, `AUTH_MODES`, `isAuthMode`, `KEY_RE`, `JiraErrorCode`) and
  `lib/jira/error.ts` (`JiraError`, importing only `redact`). Import order: `types`, `redact` are leaves; `error` imports `redact`; `host`,
  `registry` import `types`, `error`; `credentials` imports those, `redact` (it calls `registerSecret`) and `host`; `client` imports `types`, `error`, `redact`, `host`; `render` imports `types`, `error` and `snapshot` (the shared helper `str`, exported by
  `snapshot.ts` and not re-exported by `index.ts`); only `snapshot`, `render`, `index` and `provider` import `client`. `registerSecret` is exported by `redact.ts` to `credentials` and `client` (both call it) but not re-exported by
  `index.ts` (explicit named re-exports); `secrets`, `base64Cores`, `defaultExec`, `finishCreds` stay module-private.
- `credentials(trust): Promise<JiraCredentials>`: the minted `Trust` carries its `tenant`, so a trust cannot be paired with another site; `pull(trust, opts: PullOptions): Promise<PullResult>`,
  `importIssues(previous, input): ImportResult`, `renderIssue(key, raw, opts?: { maxChars?: number }): string` (synchronous, as in the code) and `fetchIssueText(trust, key, opts?): Promise<string>` (the networked fetch); `importIssues` keeps its options (`sprintField`, `now`). Every networked member takes the trust and builds its client only for `trust.tenant`.
- `Trust` is minted only by `resolveTenant`: a type-only `unique symbol` brand (a hand-built object fails `tsc` without a cast, pinned by `test/types-fixtures/trust-bad.ts`) and a
  module-private `WeakMap` from each minted trust to its `TenantResolution`; the provider refuses, with `bad_config`, any `Trust` the `verifyTrust` function rejects.
  `createTracker` lives in `src/tracker-factory.ts` and passes `ProviderDeps` (`verifyTrust: isMintedTrust`, `credentialsFor`, `clientBaseFor`, which read the registry and settings in `src/jira-tenant.ts`) into the provider, so no `lib/` module (neither `lib/jira/*` nor `lib/tracker.ts`) has a value import from `src/`.
- Commands import Jira types and the values `siteTag`, `KEY_RE`, `parseSnapshotJsonl`, `snapshotToJsonl` only through `lib/tracker.ts`; a test asserts no `src/commands/*.ts` imports `lib/jira`, statically or dynamically.
- The 0.2.0 and 0.2.1 rules hold through the seam and are re-tested there: unknown `auth.mode` throws before any credential helper runs;
  an empty tenant runs no helper; generic credentials only on the positive list; Data Center with one allowlisted host only; outputs 0600.
- Provider selection: `tracker.kind` is looked up with `Object.hasOwn` in a frozen null-prototype map, so `__proto__` or `constructor` is
  an unknown kind (exit 2). No environment variable selects a provider; a fake comes only from `makeContext({ tracker })`.
- Alias names match `^[a-z][a-z0-9_-]{0,31}$`; anything else in a committed `jira.tenant` is a data error (exit 2) naming the rule. The
  alias map is a null-prototype object filled from the user file only. A resolved alias decides the whole tenant: committed `base_url`,
  `cloud_id` and `auth` are dropped, as for a `projects` entry since 0.2.0. Alias `credentials` are validated as a `SiteEntry`. An alias resolves only for repositories the user approved: `repos` holds the SHA-256 of each approved git common directory, written by `brain doctor --fix --alias <name>` only after an interactive confirmation on a TTY that shows the alias host and the repository path (without a TTY it refuses); an unapproved repository gets exit 3 telling the user to approve it in a terminal, without printing a runnable command, so an agent following a hint in a hostile repository does not grant it by accident (a committed alias name is a request, not a grant). Limit, documented in `docs/JIRA.md` and `SECURITY.md`: a prompt-injected agent with shell access can fake a terminal (`script(1)`) or edit the user file directly; the check is not a barrier against it. Approval is keyed by path, so a new repository cloned at the same path inherits it and a moved clone must be approved again (unlike the heal consent of section 8, which moves with the clone); `doctor --fix --alias` also wires the merge driver and records `plangraph.heal`, as any `doctor --fix` does (all documented).

## 14. Graph model v2: decisions and compatibility proof

Decisions on the spec's open questions (decision D7):

1. Person stays a display-name node (`id`, `name`, `active`) without tracker account ids (personal data must not be committed).
2. Sprint dates stay optional. When at least one `sprints.jsonl` row has both dates and another row lacks one, `brain build`, `brain check` and `brain doctor` report the warning `UNDATED_SPRINT` (sprints that exist only in `schedule.jsonl` are implicit nodes and never warned about; graph plan Task 3), and the
   forecast uses the calendar only when every sprint in its window has both dates; otherwise it keeps today's output, byte for byte.
3. `implements` points from PlanTask to Ticket and is many-to-many, without a share-of-work attribute.

Storage rule (no fact stored twice): `needs` stays in `edges.jsonl`; `assigned_to` and `scheduled_in` in `schedule.jsonl`; `belongs_to` in
`tickets.epic`; `implements` in `refs.plans`; `held_by` in `open-items.jsonl`. All six are derived views and are never written to
`links.jsonl` (a `links.jsonl` row with one of them is a data error naming its v1 file). `links.jsonl` holds only hand-authored links with
no v1 source, in the closed set of decision D18 (recommended: `relates_to`, informational only). Node files (`people`, `sprints`, `epics`, `plantasks`, `capacity`) have
primary keys and merge by key through `schemaFor`; `links.jsonl` is the only new set-merged file.

Protocol (`docs/FORMAT.md` section 2): 0.4.0 expands (new files read when present; every view derivable from v1 data; `format_version` and
`min_reader` stay 1); 0.5.0 migrates (`brain migrate --write` writes the node files only, no `links.jsonl`; `format_version` 2,
`min_reader` 1 because v2 only adds files and the v1 files stay authoritative). The format guard of 0.3.0 and older runs `checkFormat` in write mode for every command (`src/cli.ts:84`, measured on 0.2.3: `brain ticket` exits 2 on a format-2 directory), so only 0.4.0 and later, whose guard reads a directory whose `min_reader` it meets (graph plan Task 2A, `docs/FORMAT.md` section 2 amended), use a migrated directory; every team member upgrades to 0.4.0 before anyone runs `brain migrate --write`.

Mixed versions: a 0.3.0 merge driver treats the new files as unknown files and merges them as sets, so a two-sided edit of one person id can
yield two rows. The graph plan records this with a frozen 0.3.0 fixture (`scripts/freeze-release.ts`); 0.4.0 refuses duplicate node ids
with a named fix, and the 0.4.0 CHANGELOG tells teams to upgrade every member before anyone commits node files.

Amendments with the graph plan: people and sprints that appear only in v1 data are implicit nodes (no integrity violation); integrity adds no code for a `needs` cycle (`check` and `verify` already report it) or for two placements of one ticket in one schedule version (impossible: `schedule.jsonl` is keyed by version and key); capacity rows are advisory in `whatif` and `--relieve` only and can only lower the capacity they decide with (`min(row, config)`; solver and `verify` keep the config capacity, so `whatif` never accepts a move `verify` rejects); the forecast uses dates only when every sprint in its window is dated (graph plan Task 6A); `edges.jsonl` kinds stay free strings.

Compatibility proof: the differential baseline captured on the 0.3.0 release, on the synthetic fixtures and on a real brain directory when
the owner supplies one, compares `differing: 0` over common ids after every graph task; new probes cover `brain graph`, the integrity
messages and capacity rows.

## 15. Naming conventions (decision D5)

`2-MODERNIZE.md` asks for `I`-prefixed interfaces, `T`-prefixed type aliases (its example `TPair`), `_`-prefixed private methods, `*.spec.ts` test files and UPPER_SNAKE_CASE constants. The
repository's convention (`docs/superpowers/typing-conventions.md`) uses unprefixed interfaces and type aliases, no `_` on private members (module scope
already hides them), `*.test.ts` (Node's test runner default), and UPPER_SNAKE_CASE only for configuration-like constants (limits, patterns),
not for every `const`. Recommendation: record the five as explicit exceptions with the reason and pin them in `test/governance.test.ts`. The
`_` prefix is adopted for unused parameters (section 5).

## 16. Decisions for the owner

The plan executes each recommendation unless the owner overrules it; each dependent task records the answer it used in its commit body. D14 has no recommendation and therefore blocks its step until the owner answers.

| # | Question | Recommendation | Cost if overruled |
|---|---|---|---|
| D1 | Adopt the Biome formatter and import organization | yes, width 100, first in 0.3.0 | five gap rows stay open as deviations |
| D2 | Adopt `noPropertyAccessFromIndexSignature` and `noUnusedParameters` (overrules R23) | yes | two gap rows stay open |
| D3 | Heal consent in the clone's local git config (`plangraph.heal`), with grandfathering of already-wired clones | yes | without grandfathering, existing users must run `brain doctor --fix` once |
| D4 | `--no-config` on the `uv run` fallbacks (plus `--config-file` for the user's `uv.toml`, or an accepted limit if uv refuses it); preparation from `bin` as in 0.2.1 | yes | the fallbacks keep reading the repository's uv configuration |
| D5 | Keep the five naming conventions as recorded exceptions | yes | one mechanical rename task in Wave 0 |
| D6 | Mutation bar: zero survivors in security modules, ratchet elsewhere | yes | 100 percent everywhere costs an unbounded number of test-writing hours |
| D7 | Graph v2 open questions as in section 14 | yes | each changes the graph plan's file shapes before it starts |
| D8 | Zero-known-issues test: always on, blocking only at a release version; development runs on `-dev` versions so recording an issue never blocks | yes | release-only manual check |
| D9 | Ruff through `uvx` and shellcheck, CI and local scripts only | yes | Python and shell stay unlinted |
| D10 | Release split 0.3.0, 0.4.0, 0.5.0 | yes | merging 0.4.0 and 0.5.0 breaks the expand/migrate rule |
| D11 | Redact case-changed and partial (16+ characters) forms of registered secrets, overruling the 0.2.1 ruling | yes | K3 becomes an owner-accepted limit in `SECURITY.md` |
| D12 | SECURITY response timeline: the playbook's values (acknowledgement 48 hours, assessment 5 business days, critical fix 14 days, lower severity 30 days) | yes | a single-maintainer timeline (7 days, 14 days, 30 days, next release) recorded as an owner-accepted deviation on M-23 |
| D13 | Tag a published release before 0.3.0? | no: do not tag before 0.3.0; the first attested release comes after the private words are removed from the tree | a `v0.2.4` tag republishes the private-word pieces in a GitHub release and an attested tarball |
| D15 | Private names already in the public tree and history: rewrite history, or move the words out of the repository and drop the pieces in 0.3.0 | move them out (local file plus CI secret in a dedicated job, HMAC if hashed); no history rewrite; no tag before the pieces are gone (D13); public commits use the noreply identity (D17) | a separate history-rewrite plan |
| D16 | Run tools fetched outside the lockfile without an integrity pin: `npx @anthropic-ai/claude-code@2.1.329` (`claude plugin validate`, CI), `uvx ruff@0.14.5` (CI and local), `npx jscpd@4.0.5` (audit only); exact versions, scripts off, no secrets in those steps | yes, as an accepted risk | plugin validation stays local and X15 blocks the release unless the owner accepts it as `Accepted (owner, D16)` in the audit report; ruff and jscpd checks are dropped |
| D17 | Existing public commits carry the owner's real e-mail address in their author and committer fields | no rewrite needed; from 0.3.0 on every public commit (snapshot and release) uses the GitHub noreply identity | a history rewrite (see D15's cost) |
| D18 | Which hand-authored relations `links.jsonl` may hold, now that all six graph relations are derived from their v1 homes | `relates_to` only (any node to any node, informational: never read by blockers, capacity, the solver or `verify`) | `links.jsonl` is dropped from v2 (no hand-authored links), or another closed set changes graph plan Task 1 before it starts |
| D19 | A `$CLAUDE_PLUGIN_DATA` created group-writable (default mode under umask 002) | refuse with exit 3 and the one-line `chmod go-w <dir>` fix, as the merge shim already does (`lib/driver.ts:53`); README and CHANGELOG say so | the launcher and the driver `chmod go-w` a data directory the user owns themselves, which changes the trust rule that they never chmod |
| D20 | Node 24.2.0, the floor of 0.2.x, prints `ExperimentalWarning: Type Stripping ...` and `ExperimentalWarning: SQLite ...` on stderr for every command, the session hook included; 24.3.0 to 24.14.0 print the SQLite one; 24.15.0 and later print none (measured on 24.2.0, 24.3.0, 24.10.0, 24.14.0, 24.15.0, 24.16.0, 24.18.0) | raise `NODE_FLOOR` to 24.15, a versioned 0.3.0 change in Task 11 (`src/floor.js` and the files that state the floor; `package.json` `engines` applied by the controller); a user-visible warning is never allow-listed. Filtering the warning in `src/entry.js` does not work: every `.ts` child the test runner spawns prints the same text, so a clean compat job would need an allow entry that also hides the user path | users on Node 24.2 to 24.14 keep a warning in every session (not allowed by the zero-warnings rule), or a filter plus an allow entry that cannot tell the user path from the test path |
| D14 | If the measured full mutation run misses 15 minutes (sharded), accept the measured time for the weekly `full` job or raise the shard count | decide after Task 22A step 6 | n/a (the owner picks one) |
| D21 | Dependabot commit-message prefixes: the playbook's `chore(deps):` (npm) and `ci:` (github-actions), which are not the owner's plain-subject rule | yes, as a recorded exception: Dependabot authors those commits and every release reaches public `main` as one squashed commit with a plain subject | Dependabot uses a plain prefix the owner names, and gap row M-20 records that deviation instead |
| D22 | The 0.2.4 fallback finds no Python 3.10-3.14 through `uv python find` run from `bin/` (before, `uv run` in the caller's directory could download one) | exit 3 with the one line `run: uv python install 3.14`; no download from the launcher (`uv python install` writes into `~/.local/bin` on uv 0.8.8) | the launcher runs `uv python install` itself, with that side effect, or falls back to an unpinned interpreter request, which brings back the repository-chosen interpreter |
