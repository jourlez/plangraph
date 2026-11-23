# Tracker Provider and Tenant Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Jira module by responsibility, put a `TrackerProvider` seam under the commands, and add a neutral tenant alias so public repositories commit no company data.

**Architecture:** `lib/jira.ts` becomes `lib/jira/*.ts` behind an index that re-exports today's exact export list. A `TrackerProvider` interface with a `JiraProvider` adapter is injected through `Ctx`. `resolveTenant` gains alias resolution and stays the only place that decides trust.

**Tech Stack:** TypeScript (native strip, `tsc --noEmit`), `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-tracker-provider-design.md`. **Prerequisite:** the TypeScript migration plan is complete and released (0.2.0); every file below is `.ts`.

## Global Constraints

- Behavior for every existing configuration is unchanged; the differential baseline (`scripts/baseline.ts`) compares equal after every task (`differing: 0`), with new probes added only in Task 3 and Task 4.
- A site named only in a committed config never receives the generic credentials (trust rule of `resolveTenant`).
- No `any`, no `enum`, no new dependency, no company name, host, cloud id or personal path in any file; `test/public-clean.test.ts` stays green.
- `brain` stays read-only: no Jira write path is added.
- **The Gate** (end of every task): `npm run bulletproof:check` passes and the baseline compare prints `differing: 0`.
- Commit subjects are short imperative lines, no co-author trailer, no AI attribution. Do not push before Task 5.

## Review Focus

1. An alias that exists in the committed config but not in the user's file, for a command that needs no Jira (`brain ticket`, `brain check`). Expected: the command runs and prints nothing about Jira. Pinned in Task 4.
2. An alias whose target site equals a site named in a committed config. Expected: the alias wins and the trust is the user's. Pinned in Task 4.
3. A circular import between the new modules. Expected: none; a test imports each module alone. Pinned in Task 2.
4. A fake provider that returns a snapshot with an unknown field. Expected: the command ignores the field and does not crash. Pinned in Task 3.
5. A `tracker.kind` that is not `jira`. Expected: exit 2 and a line naming the known kinds. Pinned in Task 3.

---

### Task 1: Freeze the public surface

**Files:**
- Create: `test/jira-exports.test.ts`

**Interfaces:**
- Produces: the committed list `JIRA_EXPORTS: readonly string[]` inside the test, equal to `Object.keys(await import('../lib/jira.ts')).sort()` at the start of this task.

- [ ] **Step 0: Capture the baseline** on the released 0.2.0 tree: `node scripts/baseline.ts capture --out .baseline/pre` (add `--data <real brain directory>` as `.baseline/pre-real` if the owner supplies one). Every later compare in this plan is against this capture.
- [ ] **Step 1: Write the test** `the module exports exactly the frozen list`: import `lib/jira.ts`, sort `Object.keys`, assert deep equal to the constant list (copy the real list from a one-off `node -e` run, do not retype it).
- [ ] **Step 2: Run** `node --test test/jira-exports.test.ts`. Expected: PASS (it freezes today's list).
- [ ] **Step 3: Run the Gate and commit**

```bash
git add test/jira-exports.test.ts
git commit -m "freeze the Jira module exports"
```

### Task 2: Split `lib/jira` by responsibility

**Files:**
- Create: `lib/jira/redact.ts`, `host.ts`, `credentials.ts`, `registry.ts`, `client.ts`, `snapshot.ts`, `render.ts`, `index.ts`, `test/jira-modules.test.ts`
- Delete: `lib/jira.ts` (replaced by `lib/jira/index.ts`)
- Modify: nothing else; every importer already says `lib/jira.ts` and now resolves `lib/jira/index.ts` through a one-line shim `lib/jira.ts`: `export * from './jira/index.ts';` (keep this file; it is the compatibility seam and the frozen-exports test targets it).

**Interfaces:**
- Produces: the module table of spec section 3, same function names and signatures as today; `lib/jira/index.ts` re-exports all of them.
- Consumes: Task 1's frozen list.

- [ ] **Step 1: Write the failing test** `test/jira-modules.test.ts`: each of the seven modules imports alone in a child process (`node --no-warnings -e "await import('./lib/jira/<m>.ts')"`) with exit 0; `redact` and `host` import nothing from the other jira modules (read the file text and assert no `./` import of a sibling); `lib/jira.ts` re-exports the frozen list. Expected: FAIL (modules missing).
- [ ] **Step 2: Move the code** into the seven modules by responsibility (spec section 3 table). This is a move: function bodies, regular expressions, limits and error messages stay byte-identical; review the diff with `git diff --color-moved=dimmed-zebra` and confirm every moved block is reported as moved.
- [ ] **Step 3: Run** the frozen-exports test, the Jira tests and `test/jira-modules.test.ts`. Expected: PASS.
- [ ] **Step 4: Run the Gate and commit**

```bash
git add -A
git commit -m "split lib/jira into modules by responsibility"
```

### Task 3: TrackerProvider seam

**Files:**
- Create: `lib/tracker.ts`, `lib/jira/provider.ts`, `test/tracker.test.ts`
- Modify: `src/context.ts`, `src/commands/audit.ts`, `src/commands/plan.ts`, `scripts/baseline.ts` (new probes), `docs/JIRA.md`

**Interfaces:**
- Produces in `lib/tracker.ts`:
  - `interface TrackerSettings { kind?: string; tenant?: string; auth?: { mode: AuthMode }; base_url?: string; cloud_id?: string; jql?: string; sprint_field?: string }`
  - `interface Trust { allowGeneric: boolean; pinned: boolean; userTenant: boolean }`
  - `interface TrackerProvider { readonly kind: string; tenantId(s: TrackerSettings): string; credentials(tenant: string, trust: Trust): Promise<JiraCredentials>; pull(opts: PullOptions): Promise<SnapshotResult>; importIssues(previous: Snapshot | null, input: unknown): Snapshot; renderIssue(key: string, opts?: RenderOptions): Promise<string> }`
  - `const PROVIDERS: Readonly<Record<string, (ctx: Ctx) => TrackerProvider>>` containing exactly `jira`
  - `createTracker(ctx: Ctx): TrackerProvider`, which reads `tracker.kind` (default `'jira'`) and throws the existing data error (exit 2) naming the known kinds for an unknown kind.
- Produces in `src/context.ts`: `Ctx.tracker(): TrackerProvider`, memoized, overridable by the context factory's options (`opts.tracker`) for tests.
- Consumes: Task 2's modules; `resolveTenant` from `src/jira-tenant.ts` (it builds the `Trust`).

- [ ] **Step 1: Write the failing tests** in `test/tracker.test.ts`: `createTracker returns the jira provider by default`; `an unknown tracker.kind is exit 2 and names jira`; `jira-pull uses an injected fake provider and never touches the network` (inject `opts.tracker` with a fake whose `pull` returns a fixed snapshot; run `jira-pull --out <tmp>`; assert the output file equals the fixed snapshot and no `fetch` call happened); `a fake snapshot with an unknown field does not crash jira-import`; `the generic credentials are refused for a committed-only site even through the provider` (call `provider.credentials('x.example.net', { allowGeneric: false, pinned: false, userTenant: false })` with generic env set and expect `no_credentials`).
- [ ] **Step 2: Run** `node --test test/tracker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib/tracker.ts`, `lib/jira/provider.ts` (`JiraProvider` composing `credentials`, `snapshot` and `render` with a client built from the settings) and the `Ctx.tracker` member. Change `jiraClient` and the three Jira commands in `src/commands/audit.ts` and the `doctor` helper in `src/commands/plan.ts` to call `ctx.tracker()`; the command output and exit codes stay identical.
- [ ] **Step 4: Add baseline probes** `provider-default`, `provider-unknown-kind`, `provider-fake-pull` to `scripts/baseline.ts`; new probes are compared against the same `.baseline/pre`: capture them once on the Task 2 commit and store them as `.baseline/pre-provider` (the seam must not change behavior, so the pre-seam tree defines the expected output).
- [ ] **Step 5: Run the Gate** (compare prints `differing: 0` on all old entries). Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "add the tracker provider seam, inject it through the context"
```

### Task 4: Tenant alias

**Files:**
- Modify: `lib/jira/registry.ts`, `src/jira-tenant.ts`, `src/commands/plan.ts` (doctor line), `docs/JIRA.md`, `test/jira-project-config.test.ts`, `test/doctor-jira.test.ts`
- Create: `test/jira-alias.test.ts`

**Interfaces:**
- Produces: `interface AliasEntry extends ProjectEntry { credentials?: SiteEntry }`; `LoadedRegistry.aliases: Record<string, AliasEntry>`; `parseSiteRegistry` returns `aliases` (known fields only, same validation as `projects`, `credentials` validated like a site entry); `TenantResolution` gains `alias: string | null` and `aliasMissing: boolean`; `resolveTenant` order: `projects[root]`, then `aliases[committed.tenant]`, then committed fields. A site from an alias or a project entry sets `userTenant: true`.
- Consumes: Task 3's `Trust` (built from `resolveTenant`).

- [ ] **Step 1: Write the failing tests** `test/jira-alias.test.ts`: `an alias supplies site, jql and credentials names`; `projects[root] wins over the alias, the alias wins over committed fields`; `an alias equal to a committed site is trusted` (Review Focus 2); `a missing alias is not an error for brain ticket and brain check, and is exit 3 with one line naming the alias for jira-pull` (Review Focus 1); `parseSiteRegistry drops unknown alias fields and reports a bad credentials name`; `doctor prints "(alias work)" and warns for an unresolved alias`.
- [ ] **Step 2: Run** `node --test test/jira-alias.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** alias parsing in `lib/jira/registry.ts`, resolution in `resolveTenant`, the doctor wording in `src/commands/plan.ts`. The trust rule code path stays in `resolveTenant` only; the doctor and the provider read its result.
- [ ] **Step 4: Update `docs/JIRA.md`:** a section "Keep the tenant out of the repository, portably" with the alias file example from the spec and the resolution order; mark the path-keyed `projects` entry as the machine-local alternative.
- [ ] **Step 5: Add baseline probes** `alias-resolved`, `alias-missing-ticket`, `alias-missing-pull`; run the Gate. Expected: PASS, `differing: 0` on every pre-existing entry.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "add the neutral tenant alias"
```

### Task 5: Docs, audit and release 0.3.0

**Files:** modify `CHANGELOG.md`, `README.md`, `docs/JIRA.md`, `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `src/mcp.ts` (`SERVER_VERSION`), `test/golden/mutation-kills/src-core.json` (version string only).

**Interfaces:** none.

- [ ] **Step 1: Run the applicable audit checks** (dependencies, `npm run knip`, lint, typecheck, review of `lib/jira/credentials.ts`, `lib/jira/host.ts`, `lib/jira/redact.ts` and `src/jira-tenant.ts` for secrets in errors, HTTPS only, no `==`, no generic credentials to committed-only hosts). Fix every finding at its cause; a behavior change needs the owner's approval first.
- [ ] **Step 2: Write the CHANGELOG entry** `## 0.3.0`: module split, provider seam, tenant alias, no change for existing configurations.
- [ ] **Step 3: Bump the version** to `0.3.0` in the four places and update the README Jira paragraph.
- [ ] **Step 4: Run the Gate and `npm run smoke`.** Expected: PASS.
- [ ] **Step 5: Commit** `release 0.3.0`.
- [ ] **Step 6: Publish** after the owner's go-ahead: `git fetch origin`, `C=$(git commit-tree 'HEAD^{tree}' -p origin/main -m "release 0.3.0: tracker provider, tenant alias")`, `git push origin "${C}:refs/heads/main"`; then `claude plugin marketplace update project-brain-marketplace` and `claude plugin update project-brain@project-brain-marketplace`; tell the owner to restart and run `brain doctor --fix`.
