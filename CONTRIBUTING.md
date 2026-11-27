# Contributing

Contribute through issues and pull requests on the project's GitHub repository (jourlez/plangraph): open an issue first for anything larger than a small fix, then send a pull request that passes the checks below.

## Setup
- Node 24.15 or newer (see the README for nvm and fnm). There are no runtime dependencies and nothing to install to run the tests.
- Dev-only tooling (never needed at run time, never shipped: `node_modules/` is git-ignored): `npm ci` installs the exact-pinned `typescript`, `@types/node`, `@biomejs/biome`, `knip` and `lefthook` from `package-lock.json`. `.ts` files run directly on Node 24 (type stripping, no build step).
- The plan is stored as entity files (`docs/FORMAT.md`). There is no merge driver and no `.gitattributes` entry; do not add one. Test fixtures write a plan through `test/helpers/plan-dir.ts`.
- Native ES modules only (`import`, `import.meta.dirname`); no `require`.

## Before you send a change
1. Check `docs/REUSE.md` first. Jira writes, publishing, notifications and session memory are deliberately not built here.
2. Start with a failing test. Every behavior change begins with a test that fails for the right reason; every security fix is proven by reverting the fix and watching the test fail.
3. Run these checks and make sure they pass:
   - `node --test $(ls test/*.test.ts | grep -v solver)` (the solver suite is slow and run separately)
   - `node --test test/docs-examples.test.ts test/readme.test.ts` after any change to a command's output or to the README or `docs/GETTING-STARTED.md`: every command marked `# runs` in those two documents is executed and its output compared with the block that follows (update the block, never the test)
   - `bash test/smoke.sh`
   - `npm run validate:plugin` (`node test/validate-plugin.ts`)
   - after `npm ci`, the development scripts:
     - `npm run bulletproof`: the whole gate in one command (lint with autofix, typecheck, full test suite)
     - `npm run bulletproof:check`: the same without autofix; this is what CI runs
     - `npm run typecheck`: `tsc --noEmit` over `tsconfig.json` (every `.ts` file except `test/types-fixtures`, which only `test/types.test.ts` checks, plus `src/floor.js`: `allowJs` and `checkJs` stay on so the plain-JavaScript Node-version guard is type-checked through JSDoc; `strict`, `noImplicitAny`, `exactOptionalPropertyTypes`) and `tsconfig.prod.json` (`lib`, `src` and `mcp`, adding `noUncheckedIndexedAccess`); any error fails
     - `npm run lint:check`: Biome checks, lint rules only (the formatter and import assist are off); `npm run lint` and `npm run lint:fix` apply the safe fixes
     - `npm run test:coverage`: the suite under V8 coverage over `lib`, `src` and `mcp` with the floors in `scripts/test-coverage.ts`
     - `npm run validate` is the full pipeline (lint, typecheck, coverage, assurance tests, plugin layout, knip, `npm audit --audit-level=high`). The audit needs the registry, so `validate` fails offline by design: the audit is part of the gate
     - `npm run knip`: unused files, exports and dependencies; any finding fails
     - `npm run test:related`: while you work, runs only the tests that touch the files you changed
4. Keep `version` only in `plugin.json` and `package.json` (they must match). Add a line to `CHANGELOG.md` for user-visible changes.

## Rules the code follows
- No network or model calls outside the read-only Jira client (`lib/jira/`) and the GET-only `gh` runner (`src/fetch-runners.ts`); no telemetry, ever; never write, log or accept a credential.
- Library modules do no I/O beyond what they are handed and never print or exit.
- State files are written atomically and refuse symlink targets.
- Text from tickets, Jira, plans or people is untrusted: sanitize it and fence it before it reaches output.
- Do not make claims in docs that the code and tests do not prove; mark what is unverified.

## How CI works
`.github/workflows/ci.yml` runs on every pull request and on `main`: unit tests with coverage, the slow solver and eval tests, typecheck, lint and plugin layout, a macOS test shard, the mutation gate and secret scanning. All of them must be green before a squash merge. `npm run bulletproof:check` is the quick local version of the lint, typecheck and test part; run `npm run validate` before a larger change (it needs the network for the audit).

## Commits
Plain imperative subject, lower case, no trailing period, for example `add license, changelog, security policy and complete manifests`. Say why in the body when it is not obvious. Commit only the files your change needs. Dependabot pull requests keep Dependabot's default messages.

## Identity and secrets
Commit with your GitHub noreply address (turn on "Keep my email private" in your GitHub settings). Never commit a token, a credential, a private email address, a company name or host, or a home path. The secret scan catches credentials, and `test/public-clean.test.ts` checks author addresses; review catches the rest. Do not add an AI tool as a co-author or contributor.

## Pull request flow
1. Branch from `main`, one change per branch.
2. Open the pull request with the template's checklist filled in.
3. Wait for CI. Fix a red job with a new commit, not by weakening the check.
4. The maintainer squash-merges with a plain subject. Releases are annotated `vX.Y.Z` tags on `main`.

## Conduct
Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security issues
Do not put them in a public report. See `SECURITY.md`.
