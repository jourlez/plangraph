# Audit B: plangraph 1.0 spec and plan versus goals, research and risks

Spec, plan and reports 01-09 checked. Ran a real git merge test on canonical entity files and the repo's biome formatter on one node file.

## BLOCKER

**B1. "Edits to different fields merge cleanly" is false.** Spec 4.0 rule 2 and plan Task 4 step 1 make this claim. Tested with git 2.54 on a sorted, one-field-per-line JSON file:
- Edits to adjacent fields (`sprint`, `status`) conflict.
- Two branches each appending a link to `links` conflict: the comma on the previous element changes, and both branches insert at the same spot.
- Two branches adding different new keys that sort next to each other (`epic`, `estimate`) conflict.

Only fields that are not adjacent merge. Report 07 section 6 marks the claim `[claimed/unverified]`; the spec states it as fact. The Task 4 test passes with fields that are not adjacent, so it gives false assurance. Links are the most-edited data, so conflicts will be routine.

Fix: store edges as one file per edge (`links/<src-shard>/<src>/<rel>~<to>.json`), or as an append-only edge-event log. Add merge tests for adjacent fields and for concurrent link adds.

**B2. Event storage gives one file per command, and ordering by wall clock.** Task 4 runs `newSession()` "once per process", and every `flow` write is a new CLI process. So every event is its own file and `seq` is always 0. Order is `(at to the second, seq, random session)`: ties break at random. No observed-max rule or logical counter exists, so this is not a hybrid clock, and a clone with a fast clock wins every race. `TaskEvent` (Task 12) and spec 4.3 omit `seq` and `session`. Two agents can claim one task and both succeed. Fix: key the session on the Claude session id or (actor, day). Use a real HLC (`at = max(now, max seen) + counter`). Refuse a claim already held by someone else, and add a `DOUBLE_CLAIM` finding.

**B3. Auto-docs make the hooks write tracked files.** Spec 5.5 layer 1 says the hook writes "only the index and cache". The next bullet makes `refresh` rebuild every stale doc region (`auto_docs` true). Results: a dirty tree after every session, checkout or rebase. Marker-line conflicts on almost every PR. Jira summaries, names and bus-factor flags committed in Markdown, which leaks private Jira data into public repos (D24 checks only URLs and emails). This breaks goal 1. Fix: hooks never write tracked files; auto-docs run in CI or on `docs build`; add a data-class policy whose default excludes names and tracker text.

**B4. The incremental index misses unstaged edits.** Spec 4.0 rule 4 and Task 4 use `git ls-files -s`. That command reports the staged blob hash, not the working-tree file. A hand edit or a fresh `writeNode` (not staged, or untracked) leaves the hash unchanged, so the index is stale with no warning.

Fix: combine `ls-files -s` with `git status --porcelain=v2 -z` (or size and mtime for every dirty or untracked path). Test an unstaged edit and an untracked new file.

**B5. The id scheme contradicts itself and breaks on default macOS and Windows file systems.**
- Spec 4.0 rule 1 says new ids are content hashes and "never a sequence number".
- The spec 4.1 table says `R-<n>` / `D-<n>`.
- Task 9 says "`R-<n>` assigned in file order". Two branches that ingest different documents both create `R-1`.
- `encodeId` keeps case, and APFS and NTFS are case-insensitive by default. `Ana` and `ana`, or a `sp:` slug differing only in case, collide silently. Review Focus 4's "ids cannot duplicate because they are file names" is false there.

Fix: hash ids everywhere (state what the seed is: creation input, never edited content). Lower-case the encoding, or add a case-fold collision check to `checkStore`.

**B6. It is undecided whether tracker tickets are committed nodes.** Spec 5.1 keeps Jira data in the cache. Task 4B moves `tickets.jsonl` into committed nodes with `jira_updated` and `audited_at`. Those are timestamps (rule 2 bans them), and every sync rewrites thousands of files. Task 10 adds `sp:slug/2` `tracked_by ABC-9` next to a possible imported `ABC-9`: two nodes for one ticket. Fix: decide committed or cache-only, move volatile fields to the cache, define one canonical node per ticket.

## MAJOR

**M1. Scale at 20k tickets.** Sharding by project prefix puts 20k files in one directory, and GitHub stops listing a directory at 1,000 entries. A takeover commit of about 20k files exceeds GitHub's PR diff limits (300 files, 20,000 lines / 1 MB per diff). Spec 4.0 "yearly packs" puts many entities back in one file, undoing rule 1, and no task implements it. Fix: two-level hash shard, a bulk-import mode with a documented review path, drop or specify packs.

**M2. It fights the team's formatters and hook managers.** Biome's default formatter (run here) rewrites a canonical node with tabs and collapses `["ana","bo"]` onto one line; Prettier behaves similarly. Every node then fails as `NOT_CANONICAL`. `hooks install --set-path` overrides `core.hooksPath`, which disables lefthook and husky; this repo uses lefthook. Fix: `init` writes formatter ignore entries and ships hook-manager snippets.

**M3. A wrong hand edit can take the whole tool down.** `parseNode` throws, so one bad file or leftover conflict markers can break every reader. Hooks hide the error. Fix: skip the invalid node and record a finding, print one line in the card, add a `CONFLICT_MARKERS` code.

**M4. Delete, rename and invalidate are only partly designed.** `valid_to` and `superseded_by` have no reader. `deleteNode` has no caller, and links to a deleted node have no cascade rule. A Jira project move (`ABC-12` to `XYZ-40`) has no rename path. "Invalidate, never delete" plus git history rules out erasing a person's data (GDPR). Fix: alias/rename command, cascade rules, erase procedure, tests.

**M5. Compaction and schedule races.** Two clones compacting one month from different event sets give add/add conflicts. Late events for a compacted month have no rule. Schedule version naming is unspecified, so two branches both making v5 collide. Fix: compact only in CI on the default branch, put content hashes in sealed and schedule file names.

**M6. Defaults contradict the "context files hurt" finding (report 01 section 3, report 02 section 4).** `map` leads with stack and commands, which `package.json` already shows. `onboarding`, `architecture` and `repo-page` are the repo overviews the study found unhelpful, and the AGENTS snippet adds a permanent context file. Fix: only facts an agent cannot discover by default; ship the snippet only if measured.

**M7. The benchmark measures the wrong risk.** Task 22 asks graph-native questions on a synthetic fixture where the baseline can only grep, so the graph wins by construction. It never tests whether the default injections lower coding success or raise cost. The wave 0 "early pass" runs before the wave 6 harness exists, and step 3 waits for an approval already given. Fix: add a coding-task arm on real repos, plugin on versus off, and build the harness in wave 0.

**M8. Token bounds are estimated and only partly tested.** `estTokens` is `ceil(chars/4)`, and `lib/render.ts:16` itself says "UNVERIFIED". The `context` 400 bound has no test in Task 17. `hook prompt` re-injects up to 200 tokens on every prompt that mentions a key, with no dedup. MCP default-on and `UserPromptSubmit` start Node in every repo, even with no plan directory. Fix: calibrate with `count_tokens`, test every bound, dedup per session, exit early when no plan directory exists.

**M9. Security gaps.** Committed config picks the fetch targets, the user's credentials fetch, and auto-docs commit the results: a read-and-exfiltrate path for a malicious repo. `flow brief` hands subagents the repo's `test` and `build` commands as instructions, so a hostile `package.json` script reaches an agent that runs it. Spec 7's "read-only scopes" is false for `gh`, which uses the user's full token. New hosts are missing from `network.hosts`. Fix: confirm fetch targets locally, label commands in the brief as data, restate the scope claim, update `plugin.json`.

**M10. "Whole history" takeover is hand-waved.** There is no Jira changelog ingest, so no historical task events. Caps of 8 MiB and 50,000 items truncate a 20k-ticket Jira. No task produces `cache/digest` or the inferred decisions from PRs. Report 03 says blobless clones suit numstat mining; that is wrong, because `--numstat` and `-M` lazily fetch every historical blob. The CI template does not set `fetch-depth: 0`. There is no `.mailmap` support.

**M11. "One document to the end" is hand-waved.** The `link` command (spec 5.2 step 4) is defined nowhere. Report 05 B6's status mapping table is missing. Brainstorming asks the human questions, which conflicts with "no human". Nobody owns merging PRs. Confluence requirements cannot satisfy "`source` is a repo path, never a URL". A plan-level `Ticket`/`Repo` has no node to attach to (report 06 section 12d).

**M12. The plan is not realistic for sonnet implementers.** Task 4 is about five tasks. Task 4B rewires 15 commands under byte-identical goldens. Task 11 needs a live Jira and Confluence test site that no subagent has. Task 15 has eight generators, and Task 18 adopts the stateless MCP revision. New wall-clock bounds (20k nodes in 3 s, 100 ms BFS, 300 ms map) bring back the flakiness Task 1 removes. Likely first failure: Task 4's merge and index tests (B1, B4) fail or get weakened until they pass.

**M13. Spec features with no task:** Linear provider, provider contract pack, narrative blocks, pre-commit hook, yearly packs, LLM digests, and Backstage relation names (the plan uses `member_of` and `part_of`). Each violates the spec's own "every feature has a caller".

**M14. Missing launch basics.** No Windows stance (keychain, sh hooks, mode 0600). No `uninstall`, no data deletion procedure, and no format stability policy after 1.0 (`schema_version` is never used). No test of two agents in one clone. Multi-file writes (sp-ingest, takeover) are not atomic as a set. No Python/OR-Tools prerequisite in the clean-machine check.

## MINOR

- m1. The spec says "six reports" and the plan cites "01 to 06", but the storage design rests on 07-09. The plan's "2.3 times the spec" is really 3.3 (11,455 / 3,459 words).
- m2. A plan-header `Assignee` writes the schedule, while spec 5.3 says the tracker owns the assignee.
- m3. Skill descriptions use the 1,536-character limit. The Agent Skills spec (report 04 section 5) caps them at 1,024.
- m4. The spec says beads "left this model". Report 07 records that Beads Classic was restored in April 2026.
- m5. A Jira project keyed `R` or `D` collides with `R-<n>`/`D-<n>` ids in the linker and the prompt hook.
- m6. When the SessionStart budget runs out, nothing tests that the index stays valid. The card prints before the refresh, so it can be stale.
- m7. Spec 2.1's "repeat what the repo says" is report 01's inference, not the study's finding.
