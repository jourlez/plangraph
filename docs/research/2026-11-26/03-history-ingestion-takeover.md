# Research 03: history ingestion for project takeover
Date: 2026-11-26. Tags: [verified: URL] = read on that page this session; [claimed/unverified] = my knowledge or secondary summary.

## 1. Git history mining
- code-maat analyses: summary, authors, coupling (co-change %), age, abs-churn (git only), author-churn, entity-churn, entity-ownership, entity-effort. [verified: https://github.com/adamtornhill/code-maat]
- Input is a `git log --numstat --no-renames --pretty=format:'--%h--%ad--%aN'` file (git2 format); restrict with `--after` date and pathspec excludes (vendor). Window matters: old data distorts current results. [verified: https://github.com/adamtornhill/code-maat]
- code-maat holds everything in memory (suggests ~4g heap); its README calls metrics heuristics, ownership shares churn bias; analyses evolved into commercial CodeScene. [verified: https://github.com/adamtornhill/code-maat]
- Temporal coupling: files changing together imply hidden coupling, but give no direction; some links are copy-paste. [verified: https://accu.org/journals/overload/21/117/tornhill_1835 via search snippet]
- Hotspot = churn x complexity. Tornhill case study: 4% of code gave 72% of defects; hotspots hit 7 of top 8 defect-dense parts. Book expects false positives. 2nd edition 2024. [verified: https://www.oreilly.com/library/view/your-code-as/9781680500813/ via search snippet; numbers are Tornhill's own claim]
- Ownership/bus factor: derive from entity-ownership/entity-effort (lines or revisions per author per file). Bus-factor threshold choices are [claimed/unverified].
- git-of-theseus: line survival (Kaplan-Meier), cohort/author/extension stacks; slow on big repos; needs `.mailmap` to merge duplicate identities. [verified: https://github.com/erikbern/git-of-theseus]
- PyDriller: `Repository(...).traverse_commits()`, commit and modified_files access. Metric/perf details not confirmed. [verified: https://github.com/ishepard/pydriller] Dependency is optional; plain `git log` parsing is enough.
- git blame follows whole-file renames automatically (cannot be turned off); `-M` finds moved lines in a file (20 alnum chars), `-C` up to three levels across files (40 chars). `--ignore-revs-file` skips mass-reformat commits (`.git-blame-ignore-revs`). `--first-parent` exists. `--follow` is a `git log` option, not blame. [verified: https://git-scm.com/docs/git-blame]
- Rename gap: code-maat recommends `--no-renames`, so path identity across renames is lost; a graph needs its own rename map (`git log -M --name-status`). [claimed/unverified, inferred from the log command above]
- Large repos: `git commit-graph write --changed-paths` (Bloom filters) speeds `git log -- <path>`; `--split` gives incremental updates. Grafts/replace objects disable it. [verified: https://git-scm.com/docs/git-commit-graph]
- Shallow vs partial: `--depth` truncates history (implies single-branch); `--shallow-since` limits by date; `--filter=blob:none` keeps full commits/trees, fetches blobs on demand, so blame/diff on old content needs the network. Shallow clones are wrong for churn/coupling/ownership; blobless clones are fine for numstat-level mining. [verified: https://git-scm.com/docs/git-clone]
- Squash merges: one commit per PR hides inner commits, per-author credit and ticket keys; recover via the PR API (PR number in squash subject, `Co-authored-by` trailers). [claimed/unverified]
- post-merge hook receives a squash flag. [verified: https://git-scm.com/docs/githooks]

## 2. Tracker and PR history
- GitHub REST primary limits: 60/h unauthenticated, 5,000/h with token, `GITHUB_TOKEN` in Actions 1,000/h per repo. Secondary: max 100 concurrent, 900 REST points/min, GET = 1 point. [verified: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api]
- Issues list: `since` filters by last-updated; `per_page` max 100 (default 30); `sort=updated&direction=asc` supports cursors; endpoint also returns PRs (check `pull_request` key); set `state=all` explicitly. [verified: https://docs.github.com/en/rest/issues/issues#list-repository-issues]
- Conditional requests: store `etag`, send `if-none-match`; authenticated 304s do not count against primary limit. Keep params and sort stable or the etag changes. Serial requests, honor `retry-after`, `x-ratelimit-reset`. Prefer webhooks over polling; if polling, honor `x-poll-interval`. [verified: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api]
- Webhooks: respond 2xx within 10 s, queue work; `X-GitHub-Delivery` is unique, reused on redelivery (dedupe key); missed deliveries must be redelivered by you. Retry policy not stated on page. [verified: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks]
- Webhooks need a public endpoint; a local CLI plugin cannot receive them, so polling with `since` plus a periodic full reconcile is the realistic default. [claimed/unverified, inference]
- Jira Cloud: points-based hourly quotas enforced from 2026-03-02 for Forge/Connect/OAuth 3LO apps (global pool 65,000 pts/h; per-tenant up to 500,000); API-token traffic not affected; 429 with `RateLimit-Reason` and `Retry-After`; use backoff with jitter, ETags, webhooks. [verified: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/]
- Linking: GitHub closing keywords (close/fix/resolve variants) in PR body or commit link issues only when the PR targets the default branch; commit-keyword links do not show the PR as linked. [verified: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue]
- Jira key-in-branch/commit/PR-title matching (regex `[A-Z][A-Z0-9]+-\d+`) is common Atlassian practice. [claimed/unverified] Treat key matches as evidence with confidence levels (branch name > PR title > commit message > body mention), and record which source produced each link.
- Review comments: carry rationale ("why not X") but are noisy; filter by resolved threads and length. [claimed/unverified]

## 3. Decision knowledge
- Nygard ADR (2011-11-15): Title, Context, Decision, Status (proposed/accepted/deprecated/superseded), Consequences; one or two pages. [verified: https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions]
- MADR 4.0.0 (2024-09-17): front matter status, date, decision-makers, consulted, informed; sections Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome (Consequences, Confirmation), Pros/Cons, More Information. [verified: https://adr.github.io/madr/]
- ADRs are meant to be immutable: supersede rather than edit; teams often keep them living. [verified: https://github.com/joelparkerhenderson/architecture-decision-record]
- arc42 has 12 sections; #9 Architecture Decisions, #11 Risks and Technical Debt, #4 Solution Strategy. [verified: https://docs.arc42.org/home/]
- Extracting "why" from non-ADR sources (commit bodies, PR descriptions, RFC folders, `docs/`): tag each candidate `decision`/`rationale`/`alternative-rejected` with source span and a `inferred` flag; never promote to "accepted ADR" without a human. [claimed/unverified, design advice]
- Keeping linked to code: ADR front-matter `affects:` paths/globs plus commit/PR references; validate globs exist on each rebuild and flag dangling ones. [claimed/unverified]

## 4. Hierarchical summarization
- RAPTOR: chunk, embed, cluster, summarize clusters recursively, retrieve across tree levels; +20 pts absolute on QuALITY with GPT-4 (paper abstract). [verified: https://arxiv.org/abs/2401.18059]
- GraphRAG: entities/relations extracted, Leiden hierarchical clustering, bottom-up community summaries; text units give fine-grained provenance. Page says nothing about incremental indexing. [verified: https://microsoft.github.io/graphrag/]
- Practical scheme for history (design advice, [claimed/unverified]): tier 0 facts (deterministic, no LLM: counts, churn, owners); tier 1 per-commit/PR one-liners; tier 2 per-file or per-module digest by map-reduce over time windows (quarter/release); tier 3 per-subsystem and project digest. Cap each tier by token budget; summarize only deltas when children change (hash of child inputs).
- Anti-hallucination: LLM summaries must cite source ids (commit SHA, PR/issue number); a verifier checks every cited id exists and every date/name is in the cited records; store `provenance[]`, `confidence` (derived|extracted|inferred), `model`, `input_hash`. Facts that deterministic code can compute must never come from an LLM. [claimed/unverified]

## 5. Legacy onboarding method
- Feathers: legacy code = code without tests; characterization tests record actual behavior, not intended behavior; recipe: call code in a harness, assert something wrong, read actual output. [verified: https://en.wikipedia.org/wiki/Characterization_test and https://www.infoq.com/news/2007/03/characterization-testing via search; "code without tests" is Feathers' definition]
- arc42 skeleton gives target structure for a first-pass architecture doc (see section 3). [verified: https://docs.arc42.org/home/]
- "Software archaeology" as a term for reading history to recover intent: [claimed/unverified, not fetched].
- Agent first pass (proposal, [claimed/unverified]): (a) inventory: languages, build, entry points, tests present; (b) hotspot + churn + ownership table; (c) coupling clusters not matching directory structure; (d) bus-factor risks (files with one recent author); (e) decision candidates with sources; (f) open questions list; (g) explicit "unknown" markers rather than guesses; (h) suggested characterization-test targets = hotspots without tests.

## 6. Incremental updating
- Hooks: post-commit (no args, cannot affect outcome), post-merge (squash flag; not run on conflict), post-checkout (prev, new, branch flag; exit status propagates, so always `exit 0`), post-rewrite (amend/rebase, old->new SHA pairs on stdin; not fired by filter-repo/fast-import). Hooks are per-repo, not cloned; use a tracked `core.hooksPath`. [verified: https://git-scm.com/docs/githooks]
- Rewrite hazard: rebase/amend/force-push invalidate stored SHAs; keep a cursor of last-indexed SHA and verify with `git merge-base --is-ancestor`; on failure fall back to rebuild or use post-rewrite mapping. [claimed/unverified]
- Content fingerprints: key derived nodes by hash of inputs (blob/tree SHA, PR `updated_at`, prompt version); skip unchanged. Git's own blob/tree SHAs make this cheap. [claimed/unverified]
- Idempotent, deterministic outputs for clean merges: sorted keys, stable ordering, one record per line (JSONL) or one file per entity, no timestamps of the build run, no absolute paths, LF endings; derived caches in gitignored dir or `.gitattributes merge=union`/`-diff` markers. [claimed/unverified]
- CI job as the authoritative rebuilder (full reconcile nightly) with hooks/watchers only as local freshness hints. [claimed/unverified]
- Note `GITHUB_TOKEN` in Actions is 1,000 req/h per repo, so large backfills need a PAT or App token. [verified: rate-limits page, section 2]

## Implications for a project-graph plugin
1. Split the graph into deterministic facts (git/tracker derived, no LLM) and LLM-derived digests; never mix them in one record without a `derivation` field.
2. Mine git with `log --numstat -M` plus an own rename map; do not rely on `--no-renames` or on `blame --follow`; blame only with `-M -C` and `.git-blame-ignore-revs` where cheap.
3. Require full (or blobless) history for churn/coupling; detect shallow via `git rev-parse --is-shallow-repository` and refuse or warn, emitting a low-confidence flag.
4. Compute churn, coupling (time-windowed), ownership, hotspots, bus-factor as tier-0 facts with the window and thresholds recorded in the output.
5. Ingest GitHub/Jira incrementally with `since` + etag cursor, serial requests, backoff on `retry-after`; polling by default, webhooks only when a public receiver exists; periodic full reconcile.
6. Link commit/PR/ticket by ranked evidence (branch, PR title, commit message, closing keywords); store link source and confidence; handle squash merges via the PR number.
7. Parse ADR/MADR/RFC files into decision nodes with status and `affects` globs; supersede chains explicit; inferred decisions from PRs/commits marked `inferred`, never "accepted".
8. Tiered digests (fact, commit/PR line, module-period, subsystem, project) with token budgets per tier; regenerate only when `input_hash` changes; every claim cites ids and is verified post hoc.
9. Make output byte-deterministic and sorted, one entity per file or per line, no run timestamps, so git merges cleanly and rebuilds are idempotent; keep volatile caches ignored.
10. Use a cursor SHA plus ancestor check and post-rewrite/CI full rebuild for rebases and force-pushes; hooks are hints only (never block git, always `exit 0`), CI is authoritative; first-pass output follows arc42 headings with explicit unknowns and a hotspots-without-tests list.
