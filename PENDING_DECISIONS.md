> Historical document: the owner's decision log, written before the 0.3.0 rename to plangraph. It names the tool, its commands, files and variables as they were called then (`brain`, `.brain/`, `BRAIN_*`); the text is unchanged.

# Pending decisions

Decisions the owner has to make before or during the zero-gaps work (plan `docs/superpowers/plans/2026-11-24-zero-gaps-0.3.0.md`, graph plan `docs/superpowers/plans/2026-11-24-graph-model-v2.md`, design `docs/superpowers/specs/2026-11-24-zero-gaps-design.md` section 16). Each entry gives the question, the recommendation, the cost of overruling it and the tasks that depend on it.

Rule (the same as the plans' Global Constraints and Definition of done): the plan executes the recommendation unless the owner has overruled it before the dependent task starts (a decision without a recommendation, such as D14, blocks its step until the owner answers), and every dependent task records `Decision Dn: <answer used>` in its commit body. When the owner decides, move the entry to "Decided" with the date and the answer; an overruling answer changes the named tasks before they start. The plan's controller owns this file and moves each entry when its dependent task merges; the 0.3.0 release keeps under "Open" only the graph-plan decisions (D7, D10, D18), and the 0.4.0 release moves those.

> 2026-11-25: decisions D1 to D24 are re-answered in `docs/superpowers/plans/2026-11-25-plangraph-0.3.0-revised.md` section 2, which wins over every entry below (D15 and D17 done by history rewrite; D14 dropped; D1, D2, D5, D21 deferred; D19 changed; D23 and D24 added).

## Open

### D1: Adopt the Biome formatter and import organization

- Question: turn on the formatter (line width 100) and import sorting, which rewrites 238 files (measured with the Task 4 configuration).
- Recommendation: yes, first in 0.3.0. The plan adds a token-based tool that re-pins the mutation pins across the formatting commit.
- Cost if overruled: five playbook gap rows stay open as recorded deviations.
- Tasks: 0.3.0 Tasks 3, 4.

### D2: Adopt `noPropertyAccessFromIndexSignature` and `noUnusedParameters`

- Question: enable both strict flags. This overrules ruling R23 from the 0.2.0 migration.
- Recommendation: yes.
- Cost if overruled: two playbook gap rows stay open.
- Tasks: 0.3.0 Tasks 5 to 9.

### D3: Merge-driver healing only with consent, with grandfathering

- Question: heal the merge driver only in clones the user wired, recorded as `plangraph.heal` in the clone's local git config by `brain init` or `brain doctor --fix`, and keep healing automatically in clones wired before 0.3.0. (A file in the plugin data directory does not work: the session hook sees `$CLAUDE_PLUGIN_DATA`, a terminal sees `~/.cache/project-brain`.)
- Recommendation: yes, with grandfathering. Only a version value counts as consent (`false` or `off` does not); `plangraph.heal=never` declines and silences the nudge. Grandfathering applies only when `plangraph.heal` is unset, so a non-version value set on an already-wired clone (an opt-out) is never overwritten or healed. Limit: a repository copied together with its `.git` directory carries its consent (documented).
- Cost if overruled: without grandfathering, existing users run `brain doctor --fix` once.
- Tasks: 0.3.0 Tasks 13, 16.

### D4: uv fallback isolation

- Question: 0.2.1 already runs the uv preparation calls from the plugin's `bin/` folder. Should the `uv run` fallbacks (older uv, or `BRAIN_SOLVE_LAUNCH=uv-run`) pass `--no-config`, so a repository's uv config is never read? `--no-config` also drops the user's own `~/.config/uv/uv.toml` (a private index or corporate mirror set there); the plan passes that file back with `--config-file` when it exists. Mirrors set through `UV_INDEX_URL`/`UV_DEFAULT_INDEX` keep working either way.
- Recommendation: yes.
- Cost of the recommendation: if uv refuses `--no-config` together with `--config-file` (checked in Task 12 Step 4), the fallback path ignores the user's `uv.toml`; that becomes an owner-accepted limit documented in `docs/SOLVER.md`, `SECURITY.md` and the CHANGELOG (set the mirror through `UV_INDEX_URL` instead).
- Cost if overruled: the fallbacks keep reading the repository's uv configuration (known issue K1 stays open as an accepted limit).
- Tasks: 0.3.0 Tasks 12, 16, 24 (Task 0, the 0.2.4 hotfix, already passes an absolute `--python` on the fallbacks: `--no-config` alone does not stop a committed `.venv` or `.python-version` interpreter, measured).

### D5: Naming conventions

- Question: keep unprefixed interface names and type aliases without a `T` prefix (the playbook's example `TPair`), no `_` on private members, `*.test.ts` file names and UPPER_SNAKE_CASE only for configuration-like constants, as recorded exceptions to 2-MODERNIZE.
- Recommendation: yes.
- Cost if overruled: one mechanical rename task in Wave 0.
- Tasks: 0.3.0 Task 16.

### D6: Mutation bar

- Question: zero surviving mutants in the security modules, and a recorded score floor that can only rise everywhere else.
- Recommendation: yes.
- Cost if overruled: 100 percent everywhere costs an unbounded number of test-writing hours.
- Tasks: 0.3.0 Task 22.

### D7: Graph v2 open questions

- Question: (a) does Person hold a tracker account id, (b) are Sprint dates required, (c) is `implements` many-to-many with a share of work?
- Recommendation: (a) no, people stay display names and no account ids are committed; (b) no, dates stay optional; (c) many-to-many with no share-of-work attribute.
- Storage (amended 2026-11-24): all six relations (`needs`, `assigned_to`, `scheduled_in`, `belongs_to`, `implements`, `held_by`) are derived views of their v1 homes (`edges.jsonl`, `schedule.jsonl`, `tickets.epic`, `refs.plans`, `open-items.jsonl`); none is written to `links.jsonl`, and `brain migrate --write` writes the node files only. `links.jsonl` holds only hand-authored links with no v1 source (D18).
- Cost if overruled: each answer changes the file shapes of the graph v2 work before it starts.
- Tasks: graph plan Tasks 1 to 8.

### D8: Zero-known-issues test

- Question: run `test/known-issues.test.ts` in the normal suite, blocking at a release version (nothing may follow the preamble) and, between releases, requiring each entry to name a target release at or above the next release. Between releases means a `-dev` version: right after each release the branch moves to the next `-dev` version (0.3.0 Task 2 opens `0.3.0-dev`; Task 24 Step 6 opens `0.4.0-dev`), because the repository otherwise always carries a release version.
- Recommendation: yes. Recording a newly found issue during development then never turns CI red, but no release ships with an entry; an owner-accepted limit is moved to `SECURITY.md` and listed as accepted in the audit report.
- Cost if overruled: a stricter always-blocking test discourages recording issues; a looser one is a manual release check.
- Tasks: 0.3.0 Task 23.

### D9: Python and shell linting

- Question: lint Python with ruff (through `uvx`) and shell with shellcheck, in CI and local scripts only, with nothing added to `devDependencies`.
- Recommendation: yes.
- Cost if overruled: Python and shell stay unlinted.
- Tasks: 0.3.0 Task 15.

### D10: Release split

- Question: ship 0.3.0 (zero gaps), then 0.4.0 (graph v2 expand) and 0.5.0 (graph v2 migrate) from a separate plan.
- Recommendation: yes.
- Cost if overruled: merging 0.4.0 and 0.5.0 breaks the expand, migrate, contract rule in `docs/FORMAT.md`.
- Tasks: both plans (0.3.0 Task 24 release commit; graph plan Tasks 1 to 8).

### D11: Redaction of case-changed and partial tokens

- Question: the 0.2.1 ruling on known issue K3 was "none for now; matching case-changed or partial forms risks redacting ordinary data". Should 0.3.0 overrule it and redact, for each registered API token of 12 or more characters (not the derived base64 Basic credential), its case-changed forms and any substring of 16 or more characters?
- Recommendation: yes. Only material derived from an actual registered secret is matched, so ordinary text is redacted only if it shares 16 characters with a token.
- Cost if overruled: no code change; K3 becomes an owner-accepted limit documented in `SECURITY.md`.
- Tasks: 0.3.0 Task 14.

### D12: SECURITY response timeline

- Question: adopt the playbook's timeline (acknowledgement 48 hours, assessment 5 business days, critical fix 14 days, lower severity 30 days).
- Recommendation: yes.
- Cost if overruled: a single-maintainer timeline (7 days, 14 days, 30 days, next release), recorded as an owner-accepted deviation on gap row M-23.
- Tasks: 0.3.0 Task 16.

### D13: No tag before 0.3.0

- Question: no release has a tag. CI on 0.2.4, the latest release (`da30467`), is green on all 7 jobs (run 45354992186), but every tree up to 0.2.4 holds the concatenated private-word pieces of `test/public-clean.test.ts`. Tag a release before 0.3.0?
- Recommendation: do not tag before 0.3.0; the first attested release comes after the private words are removed from the tree (0.3.0 Task 2), as `v0.3.0` (Task 24). A `v0.2.4` tag would attach the pieces to a GitHub release and an attested tarball, a new distribution channel.
- Cost if overruled: a `v0.2.4` release republishes the pieces; the owner records that acceptance.
- Tasks: 0.3.0 Task 1.

### D14: Mutation run time

- Question: after Task 22A measures the full mutation run with the per-test coverage map, if it still misses 15 minutes (sharded) or the changed-files run misses 2 minutes: accept the measured time for the weekly `full` job, or raise the shard count?
- Recommendation: none; decide on the measured numbers. This decision blocks 0.3.0 Task 22A Step 7 until answered.
- Cost if overruled: n/a.
- Tasks: 0.3.0 Tasks 22A, 22.

### D15: Private names already in the public repository

- Question: the published `test/public-clean.test.ts` (0.2.3 and every earlier public commit) spells the host project name, the client name and the personal handle as two concatenated string pieces each, and older public commits carry them too. Rewrite the public history to remove them, or accept that they are already published and stop adding them?
- Recommendation: rewriting the public history is out of scope (it breaks every clone and marketplace install, and copies already exist). Move the private words to an out-of-repository list (local file plus a CI secret held only by the dedicated `private-words` job; HMAC-SHA-256 if hashes are ever committed) and remove the concatenated names from the tree in 0.3.0 (Task 2). Create no tag before then (D13), and publish every new public commit with the GitHub noreply identity (D17).
- Cost if overruled: a history rewrite needs its own plan (force-push of `main`, every release commit re-created, tags re-made, marketplace users told to reinstall).
- Tasks: 0.3.0 Task 2.

### D16: Tools fetched outside the lockfile

- Question: three tools run at an exact version but without a lockfile integrity hash, because none is a dev dependency (zero new `devDependencies`): `npx @anthropic-ai/claude-code@2.1.329` (`claude plugin validate . --strict` in CI, closing X15), `uvx ruff@0.14.5` (Python lint, CI and local) and `npx jscpd@4.0.5` (duplicate-code review in the audit only). Accept that, with install scripts off and no secrets in those steps?
- Recommendation: yes; the steps read only the repository and run with `contents: read`.
- Cost if overruled: plugin validation runs only on the owner's machine and X15 blocks the 0.3.0 release unless the owner accepts it (then X15 leaves `KNOWN_ISSUES.md`, the audit report lists it as `Accepted (owner, D16)` and gap row M-07 stays Partial); Python lint and the duplicate-code review are dropped or run by hand.
- The same acceptance path applies if `claude plugin validate` needs a login on the CI runner (0.3.0 Task 20).
- Tasks: 0.3.0 Tasks 15, 20, 23.

### D17: The owner's real e-mail address in existing public commits

- Question: the author and committer fields of the existing public commits carry the owner's real e-mail address (git metadata, not file content, so the privacy scan does not see it). Rewrite them?
- Recommendation: no rewrite needed; from 0.3.0 on every public commit (CI snapshots and release commits) is made with the owner's GitHub noreply identity (`<id>+<login>@users.noreply.github.com`, set in the owner's shell as `PB_NOREPLY`, never written to a file), and tags are lightweight.
- Cost if overruled: a history rewrite with the costs listed under D15.
- Tasks: 0.3.0 Global Constraints, the snapshot command, Task 24; graph plan Tasks 7 and 8.

### D18: Hand-authored links in `links.jsonl`

- Question: all six graph relations are derived from their v1 homes, so `links.jsonl` can hold only links that have no v1 source. Which relations may it hold?
- Recommendation: `relates_to` only: any node to any node, informational; never read by blockers, capacity, the solver or `verify`.
- Cost if overruled: dropping `links.jsonl` from v2 removes hand-authored links entirely; another closed set changes the graph plan's Task 1 schema before it starts.
- Tasks: graph plan Tasks 1, 2, 3, 4 (`blockersOf` never reads `relates_to`), 5 (the `--rel` known set), 6 (capacity never reads `relates_to`), 8 (the migration writes no `links.jsonl`).

### D19: Group-writable plugin data directory

- Question: Claude Code creates `$CLAUDE_PLUGIN_DATA` with the default directory mode (measured `drwxr-xr-x` for every plugin data directory under umask 022), so under umask 002 (Ubuntu users with a private group) it is presumably `775`. The merge shim already refuses such a directory (`lib/driver.ts:53`); from 0.3.0 the solver launcher refuses it too (Task 12). Refuse, or fix the mode?
- Recommendation: refuse with exit 3 and the one-line `chmod go-w <dir>` fix; README "Requirements" and the 0.3.0 CHANGELOG say so. The trust rule stays "never chmod".
- Cost if overruled: the launcher and the driver chmod a data directory owned by the user, which weakens the rule that a trust root is refused, never repaired silently.
- Tasks: 0.3.0 Tasks 12, 16, 24.

### D20: Runtime warnings on the Node floor

- Question: Node 24.2.0, the floor since 0.2.0, prints `ExperimentalWarning: Type Stripping is an experimental feature ...` and `ExperimentalWarning: SQLite is an experimental feature ...` on stderr for every command, the SessionStart hook (`card --if-present --heal`) included; 24.3.0 to 24.14.0 still print the SQLite one; 24.15.0, 24.16.0 and 24.18.0 print none (measured). Raise `NODE_FLOOR` to 24.15, or filter the warning in `src/entry.js`?
- Recommendation: raise `NODE_FLOOR` to 24.15 in 0.3.0 Task 11, a versioned change (`src/floor.js` and every file that states the floor; `package.json` `engines` applied by the controller at merge; CHANGELOG and README say that Node 24.2 to 24.14 is no longer supported). A user-visible warning is never allow-listed in `RUNTIME_WARNING_ALLOW`. Filtering in `src/entry.js` is not recommended: every `.ts` child the test runner spawns prints the same warning text, so the compat job could only pass with an allow entry that also hides the user path.
- Cost if overruled: users on Node 24.2 to 24.14 see a warning in every session, against the zero-warnings rule (A-30), or the compat check needs an allow entry that cannot tell the user path from a test child.
- Tasks: 0.3.0 Tasks 11, 20, 23.

### D21: Dependabot commit-message prefixes

- Question: the playbook's Dependabot template sets the commit-message prefixes `chore(deps):` (npm) and `ci:` (github-actions); the owner's rule is plain imperative subjects without Conventional Commits prefixes (gap row B-24). Use the playbook's values?
- Recommendation: yes, as a recorded exception: Dependabot, not a person, authors those commits, and every release reaches public `main` as one squashed commit with a plain subject; `docs/superpowers/typing-conventions.md` records the exception.
- Cost if overruled: Dependabot uses a plain prefix the owner names, and gap row M-20 records that deviation from the playbook instead.
- Tasks: 0.3.0 Task 16.

## Decided

### D22: No Python found for the hotfixed uv fallback

- Question: from 0.2.4 (0.3.0 plan Task 0) the `uv run` fallbacks of `bin/brain-solve-run` pass an absolute `--python` found by `uv python find` run from the plugin's `bin/` directory, because uv otherwise picks the interpreter from a `.venv` or `.python-version` committed in the caller's directory (measured: code execution on uv 0.8.8 and 0.4.30). When no Python 3.10-3.14 is found, should the launcher refuse, or provision one?
- Recommendation: refuse with exit 3 and the one line `brain-solve: no Python 3.10-3.14 found by uv; run: uv python install 3.14`. Before 0.2.4, `uv run` could download a Python on its own in that case; the CHANGELOG of 0.2.4 names the change.
- Cost if overruled: the launcher runs `uv python install` itself, which on uv 0.8.8 also writes executables into `~/.local/bin` (measured), or passes an unpinned interpreter request, which brings back the repository-chosen interpreter.
- Tasks: 0.3.0 Task 0 (0.2.4), Task 12 (keeps it).
- Decided 2026-11-24: refuse (exit 3), the recommendation, shipped in 0.2.4 (`da30467`, published with the owner's go-ahead). An overruling answer later becomes a 0.3.0 change in Task 12.
