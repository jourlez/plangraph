# Contributing

Contribute through issues and pull requests on the project's GitHub repository (jourlez/OpenBrain): open an issue first for anything larger than a small fix, then send a pull request that passes the checks below.

## Setup
- Node 24.2 or newer. There are no runtime dependencies and nothing to install to run the tests.
- Dev-only tooling (never needed at run time, never shipped: `node_modules/` is git-ignored): `npm ci` installs the exact-pinned `typescript`, `@types/node` and `@biomejs/biome` from `package-lock.json` for `npm run typecheck` (tsc ratchet, `scripts/typecheck.mjs`) and `npm run lint` (Biome, lint rules only, no formatter).
- Native ES modules only (`import`, `import.meta.dirname`); no `require`.

## Before you send a change
1. Check `docs/REUSE.md` first. Jira writes, publishing, notifications and session memory are deliberately not built here.
2. Start with a failing test. Every behavior change begins with a test that fails for the right reason; every security fix is proven by reverting the fix and watching the test fail.
3. Run these checks and make sure they pass:
   - `node --test $(ls test/*.test.mjs | grep -v solver)` (the solver suite is slow and run separately)
   - `bash test/smoke.sh`
   - `node test/validate-plugin.mjs`
   - after `npm ci`: `npm run typecheck` (fails when a tsc error count rises above `scripts/typecheck-baseline.json`) and `npm run lint`
4. Keep `version` only in `plugin.json` and `package.json` (they must match). Add a line to `CHANGELOG.md` for user-visible changes.

## Rules the code follows
- No network or model calls outside `lib/jira.mjs`; never write, log or accept a credential.
- Library modules do no I/O beyond what they are handed and never print or exit.
- State files are written atomically and refuse symlink targets.
- Text from tickets, Jira, plans or people is untrusted: sanitize it and fence it before it reaches output.
- Do not make claims in docs that the code and tests do not prove; mark what is unverified.

## Commits
Lowercase imperative subject, for example `add license, changelog, security policy and complete manifests`. Commit only the files your change needs.

## Security issues
Do not put them in a public report. See `SECURITY.md`.
