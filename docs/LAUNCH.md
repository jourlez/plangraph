# Public launch checklist

What must be true before the repository is made public and 1.0 is announced. Each item is marked **done** or **open**, with the evidence found in the repository when this page was written. "Done" means the repository shows it; it does not mean the item was run on a clean machine or on the public service unless it says so. Re-check every line at release time (Task 35 of the 1.0 plan).

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | `LICENSE` present | done | `LICENSE` is the MIT text, "Copyright (c) 2026 plangraph authors"; `test/packaging.test.ts` pins both lines. |
| 2 | `SECURITY.md` with a reporting address that is not personal | done in the file, open on the service | `SECURITY.md` names GitHub private vulnerability reporting, so no personal email is published. Whether the setting is switched on for the public repository cannot be seen from the tree: open until someone opens Settings, Code security, Private vulnerability reporting on the public repository and sees it enabled. |
| 3 | Supported platforms stated: macOS and Linux, Windows unsupported, hooks use Node not `sh` | done | README "Requirements" and "Troubleshooting", `docs/GETTING-STARTED.md`, `SECURITY.md`. The plugin hooks in `hooks/hooks.json` run `node` directly. The optional git hook scripts in `templates/githooks/` are `sh` wrappers and the docs say so. CI runs on Linux (`ubuntu-24.04`) and macOS (`macos-latest`); nothing was run on Windows. |
| 4 | Prerequisites stated: Node 24.15 or newer, git, Python 3 and OR-Tools for the solver, optional `gh` | done | README "Requirements" table; `test/readme.test.ts` pins the Node and Claude Code minimums to `package.json` and `plugin.json`. |
| 5 | Telemetry stance: none, verified by reading the code | done | A search of `src/`, `lib/`, `bin/`, `mcp/` and `hooks/` for network access finds one HTTP client (`lib/jira/client.ts`, `globalThis.fetch`), reached only by the fetchers; GitHub goes through the user's own `gh` (`src/fetch-runners.ts`, GET only). Recorded in README "Requirements" and `docs/audit/1.0-audit.md`. It is a source search, not a network capture: a capture on a clean machine is open (item 7). |
| 6 | Install steps from a clean machine (`claude plugin marketplace add`, then `claude plugin install`) on macOS and Linux | open | The commands are in the README and were run with Claude Code 2.1.329 for the 0.5.0 plugin in an isolated configuration. They were not run for the 1.0 tree, and not on a clean Linux or macOS user account with Python and OR-Tools installed by the documented steps. This is Task 35, step 2. |
| 7 | Clean-machine run of `docs/GETTING-STARTED.md` and of `plangraph takeover` on a public sample repository | open | `docs/GETTING-STARTED.md` is executed by `test/docs-examples.test.ts` on a synthetic project in a temp directory. No public sample repository has been taken over. |
| 8 | Release artifacts: source tarball, SHA-256 checksum, build attestation | open | `.github/workflows/release.yml` builds `plangraph-<version>.tar.gz`, writes `plangraph-<version>.tar.gz.sha256`, attests the tarball with `actions/attest` and creates the release. No `v1.0.0` tag exists (the tags in the repository are `v0.3.0`, `v0.4.0` and `v0.5.0`) and the workflow has not produced a release; the README says so. Open until the workflow is green on the release tag and `gh attestation verify` succeeds on the published tarball. |
| 9 | Demo transcript from the synthetic project | done | `docs/GETTING-STARTED.md` is the transcript: each `# runs` block is real output, compared by `test/docs-examples.test.ts`. There is no recorded terminal session or screenshot. |
| 10 | The public repository is built from a freshly created history | open | The public repository must be a new repository with an orphan branch holding the final tree and a few curated commits, authored with a GitHub noreply identity. Not created. |
| 11 | No secret, personal data, home path or company name in the tree | done for the checks that exist | `test/public-clean.test.ts` scans every tracked file for home paths, scratch paths, Atlassian cloud ids, token shapes and private-key headers and passes; the CI job `gitleaks` scans on every pull request. Company and personal names are not covered by a committed rule: a grep list kept outside the repository is still to be written and run (open, item 12). |
| 12 | No secret, personal data, home path or company name in the history | open | Not checked for the history that will be published. Run the secret scan over the full history of the new repository and the custom word list from item 11 on the orphan branch, once it exists. |
| 13 | A repository setting check: secret scanning and push protection on, Dependabot on | open | `.github/dependabot.yml` exists; the settings live on the service and cannot be seen from the tree. |
| 14 | `KNOWN_ISSUES.md` empty at release | open | Checked by the controller at Task 35, step 3. |
| 15 | Benchmark ruling recorded | open | `docs/BENCHMARK.md` says "Pending the early pass". The README says `results pending` and claims no token or accuracy benefit. The release can ship with the ruling pending only if the plugin defaults it leaves on (the MCP server, the hooks) are accepted as placeholders. |

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
