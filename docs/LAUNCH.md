# Public launch checklist

What must be true before the repository is made public and 1.0 is announced. Each item is marked **done** or **open**, with the evidence found in the repository when this page was written. "Done" means the repository shows it; it does not mean the item was run on a clean machine or on the public service unless it says so. Re-check every line at release time (Task 35 of the 1.0 plan).

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | `LICENSE` present | done | `LICENSE` is the MIT text, "Copyright (c) 2026 plangraph authors"; `test/packaging.test.ts` pins both lines. |
| 2 | `SECURITY.md` with a reporting address that is not personal | done | `SECURITY.md` names GitHub private vulnerability reporting, no personal address. The setting is switched on for the public repository (checked through the repository settings API on 2026-11-27). |
| 3 | Supported platforms stated: macOS and Linux, Windows unsupported, hooks use Node not `sh` | done | README "Requirements" and "Troubleshooting", `docs/GETTING-STARTED.md`, `SECURITY.md`. The plugin hooks in `hooks/hooks.json` run `node` directly. The optional git hook scripts in `templates/githooks/` are `sh` wrappers and the docs say so. CI runs on Linux (`ubuntu-24.04`) and macOS (`macos-latest`); nothing was run on Windows. |
| 4 | Prerequisites stated: Node 24.15 or newer, git, Python 3 and OR-Tools for the solver, optional `gh` | done | README "Requirements" table; `test/readme.test.ts` pins the Node and Claude Code minimums to `package.json` and `plugin.json`. |
| 5 | Telemetry stance: none, verified by reading the code | done | A search of `src/`, `lib/`, `bin/`, `mcp/` and `hooks/` for network access finds one HTTP client (`lib/jira/client.ts`, `globalThis.fetch`), reached only by the fetchers; GitHub goes through the user's own `gh` (`src/fetch-runners.ts`, GET only). Recorded in README "Requirements" and `docs/audit/1.0-audit.md`. It is a source search, not a network capture: a capture on a clean machine is open (item 7). |
| 6 | Install steps from a clean machine (`claude plugin marketplace add`, then `claude plugin install`) on macOS and Linux | done for macOS, open for Linux | Run on 2026-11-27 with Claude Code 2.1.332 in an isolated configuration and a clean home directory, from the public repository: `claude plugin marketplace add jourlez/plangraph` and `claude plugin install plangraph@plangraph-marketplace` installed v1.0.0 (11 skills, 2 hooks, 1 MCP server); `claude plugin validate` passed; the installed SessionStart hook is silent by default and prints the card with the option on; a live Haiku session used the installed plugin on a real repository, once through the CLI and once through the MCP tool (switched on by the plugin option `mcp`, and by a shell `PLANGRAPH_MCP=on`). The live runs found two defects, both fixed before the tag: a solver budget that included the first OR-Tools import, and a plugin `.mcp.json` that overrode the shell variable. Not run on a clean Linux account; CI covers Linux for the tests only. |
| 7 | Clean-machine run of `docs/GETTING-STARTED.md` and of `plangraph takeover` on a public sample repository | done on macOS | A fresh clone of the public repository in a clean home directory, run with `env -i`: `plangraph init` and `plangraph takeover --no-fetch` finished with exit 0 on `octocat/Hello-World` (3 commits) and on `expressjs/cors` (351 commits, about 5 s); `plangraph map` and `plangraph check` followed; only `.plangraph/` and the documented `.gitignore` line were written. The solver ran from a cold `uv` cache through `plangraph-solve-run` (about 54 s including the OR-Tools install) and `plangraph verify` accepted the schedule. Not run with tracker access (`--no-fetch`). |
| 8 | Release artifacts: source tarball, SHA-256 checksum, build attestation | open | `.github/workflows/release.yml` builds `plangraph-<version>.tar.gz`, writes `plangraph-<version>.tar.gz.sha256`, attests the tarball with `actions/attest` and creates the release. No `v1.0.0` tag exists (the tags in the repository are `v0.3.0`, `v0.4.0` and `v0.5.0`) and the workflow has not produced a release; the README says so. Open until the workflow is green on the release tag and `gh attestation verify` succeeds on the published tarball. |
| 9 | Demo transcript from the synthetic project | done | `docs/GETTING-STARTED.md` is the transcript: each `# runs` block is real output, compared by `test/docs-examples.test.ts`. There is no recorded terminal session or screenshot. |
| 10 | The public repository is built from a freshly created history | done | The public repository is a new repository that carries the `main` history only (398 commits, all authored and committed with the GitHub noreply identity). Branches, pull-request refs and the early tags of the previous repository were not carried over; that repository was renamed and made private. |
| 11 | No secret, personal data, home path or company name in the tree | done for the checks that exist | `test/public-clean.test.ts` scans every tracked file for home paths, scratch paths, Atlassian cloud ids, token shapes and private-key headers and passes; the CI job `gitleaks` scans on every pull request. Company and personal names are not covered by a committed rule: a grep list kept outside the repository is still to be written and run (open, item 12). |
| 12 | No secret, personal data, home path or company name in the history | done | The full history of the public repository was scanned: no company name, no home or scratch path and no personal email address in any commit author, committer or message; gitleaks reports only synthetic test tokens (`tok-` placeholders and a `SENTINEL` string, allowlisted for the current tree in `.gitleaks.toml`). |
| 13 | A repository setting check: secret scanning and push protection on, Dependabot on | done | Secret scanning, push protection, Dependabot alerts and Dependabot security updates are enabled through the repository settings API (2026-11-27); `.github/dependabot.yml` covers version updates. |
| 14 | `KNOWN_ISSUES.md` empty at release | done | `KNOWN_ISSUES.md` holds its header and no entries at the 1.0.0 tag. |
| 15 | Benchmark ruling recorded | done | `docs/BENCHMARK.md` records the ruling (section "Ruling"): the card, the prompt hook and the MCP server are strictly opt-in, and the README claims no token or accuracy benefit (`results pending`). |

## Order of work

1. Close items 6, 7 and 8 on the release candidate (Task 35).
2. Create the fresh-history repository (item 10), then run items 11 and 12 on it, and the settings checks (items 2 and 13).
3. Tag and let the release workflow publish; verify the checksum and the attestation on the published tarball (item 8) and repeat the install of item 6 from the published artifact.
4. Announce only after step 3.

## Commands for the checks

```bash
node --test test/public-clean.test.ts
gitleaks detect --no-banner --redact
git log --all -S'<a string from your own grep list>' --format='%h %s'
sha256sum -c plangraph-<version>.tar.gz.sha256
gh attestation verify plangraph-<version>.tar.gz --repo <owner>/plangraph
```
