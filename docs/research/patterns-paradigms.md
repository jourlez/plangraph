# Patterns and paradigms for open-brain: research and architecture review

Date 2026-11-22. Scope: read `docs/CONTRACT.md`, `FORMAT.md`, `STALE.md`, `SOLVER.md`, `bin/brain`, `bin/brain-merge`, `bin/brain-solve`, `lib/*.mjs`. No project file was modified. Counterexamples were run from the scratchpad (`.../scratchpad/ce/t1.mjs`..`t5.mjs`) against the real `lib/` code.

Evidence tags: VERIFIED = I fetched or ran it; SECONDARY = search-result summary of a primary source, not read in full; UNVERIFIED = from memory, check before relying.

Short verdict: the library layer (`lib/*.mjs`) is already close to a functional core. The weak spots are (a) `bin/brain` (global state, 29 commands in one file, output capture by monkey-patching), (b) the merge function's treatment of `null` vs absent and of inherited properties, (c) the claim protocol's failure modes, (d) non-atomic writes outside `writeAtomic`, (e) the solver's weak dual bound in the owner-change stage. Most "advanced paradigms" are not worth adopting; a handful are (section 12).

---

## 0. Bugs and counterexamples found (all reproduced)

| # | Where | Finding | Severity |
|---|---|---|---|
| B1 | `lib/merge.mjs:18-26` (`mergeField`, `canonValue` maps `undefined` to `'null'`) | Field absent vs `null` are the same value, so a `null` added on one side is dropped or kept depending on which side is "ours". Merge is NOT commutative. | Medium: `git merge` and `git rebase` swap ours/theirs, so the same inputs give different bytes. |
| B2 | `lib/merge.mjs:31` (`b[f]`, `o[f]`, `t[f]` on plain objects) | Inherited properties are read as values when a side lacks the field: `__proto__` yields `Object.prototype`, `constructor` yields a function. Output contains `"constructor":undefined`, which is invalid JSON (corrupt canonical file). FORMAT.md claims `__proto__` is safe. | Medium (hostile or odd data), easy fix |
| B3 | `lib/store.mjs:216` (`cmpAt`) | Mixed number/string `claimed_at` makes the order intransitive, so `resolveClaims` winner depends on input order. | Low (format says ISO or number), but it is a determinism hole |
| B4 | `lib/store.mjs:258-261` (`claimTicketGit`) | `git pull --rebase` refuses on a dirty tree ("cannot pull with rebase: You have unstaged changes"). Claim fails in any working checkout with unrelated edits. | High for the real use case |
| B5 | `lib/store.mjs:261` (`if (!c.ok \|\| c.already) return c`) | After a crash or retry exhaustion the claim is committed locally but unpushed. Re-running `brain claim` sees its own claim (`already`) and reports success WITHOUT pushing. Other clones never see the claim. | High (silent lost claim) |
| B6 | `lib/store.mjs:102` (`withLock`) | Stale-lock break is check-then-remove (TOCTOU): two waiters can both delete and both enter; `finally` removes a lock another process now owns. | Medium |
| B7 | `lib/store.mjs:18,25` (evidence id = hash of 5 named fields) | A record that gains an unknown field (the documented expand phase) has the same id as its old self, so merging reports a false "duplicate key" conflict. | Low-medium |
| B8 | `lib/compact.mjs` via `bin/brain:481` | `compact --apply` writes `evidence.jsonl` (with summaries) before the archive files, with plain `writeFileSync`. A crash in between loses the archived rows from the working tree (hash check then fails on restore). | Medium |
| B9 | `bin/brain:282,453,481,488,489,133,409` | State-bearing writes use `fs.writeFileSync` (truncate-then-write), not `writeAtomic`. A crash leaves a truncated source-of-truth file. | Medium |
| B10 | `lib/store.mjs:94-99` and `bin/brain-solve atomic_write` | fsync of the file, but no fsync of the parent directory after rename: rename may be lost on power failure. | Low (git is the backup) |
| B11 | `lib/openitems.mjs:69` (`parseItems`) | Unguarded `JSON.parse`: a bad line throws a bare `SyntaxError` with no file:line. `lib/jsonl.mjs` and `store.parseJsonlText` do it right, so there are three parsers with three behaviors. | Low |
| B12 | `bin/brain:138` | Index staleness = `mtime > dbmtime + 1000`. Misses an edit within 1 s of a build and any restore of old content with an old mtime. The `stale` module already proves fingerprints are the right tool. | Low |
| B13 | everywhere (`execFileSync` with no `timeout`; no `AbortSignal` outside `jira.mjs`) | A hung `git push` (credential helper, network) hangs the CLI, and the claim lock path never learns. | Medium |

Exact reproductions (run them with `node`, merge API as in `lib/merge.mjs`):

```js
// B1: ours adds null, theirs edits another field. Swap sides, get different bytes.
base   {"key":"K","epic":null}
ours   {"key":"K","epic":null,"sp":null}
theirs {"key":"K","epic":null,"z":[1]}
merge(base, ours, theirs) -> {"key":"K","epic":null,"sp":null,"z":[1]}
merge(base, theirs, ours) -> {"key":"K","epic":null,"z":[1]}          // sp:null lost
// Fuzz (20000 random 3-way cases, 5 fields, null in the value pool): 1106 non-commutative results.
// Same fuzz WITHOUT null: 0 non-commutative, 0 idempotence failures. So the algebra is sound except null/absent.

// B2
base   {"key":"A","constructor":"x"}   ours {"key":"A","v":1}   theirs {"key":"A","w":2}
merge -> {"key":"A","constructor":undefined,"v":1,"w":2}            // not JSON
base   {"key":"A","__proto__":{"a":1}} ours {"key":"A","v":1}   theirs {"key":"A","__proto__":{"a":1},"w":2}
merge -> {"key":"A","__proto__":{},"v":1,"w":2}                     // ours' deletion reverted, value corrupted

// B3
claims for T: {claim_id:a, claimed_at:9}, {claim_id:b, claimed_at:10}, {claim_id:c, claimed_at:"5"}
9 < 10 < "5" < 9 under cmpAt; resolveClaims winner is a, b or c depending on input order (all 3 observed in 6 permutations).

// B4 (real git, bare remote + 2 clones, driver installed)
append a line to an unrelated tracked file, then claimTicketGit(...) ->
  "git pull --rebase failed: error: cannot pull with rebase: You have unstaged changes."

// B7
evidence e1 = {key,source,verdict,resolution,needs}; e2 = e1 + {extra:1}
merge(base:e1, ours:e1+e2-as-two-lines...) -> "duplicate key in the result"; merge('', e1, e2) -> "added differently on both sides"
```

Claim protocol, happy path and race: verified OK. With alice's `beforePush` hook running bob's full claim (bob has the EARLIER `claimed_at`, simulating skew), alice's push is rejected, she pulls, reads `@{u}`, sees bob, resets her commit and returns `lost`. Final history has exactly bob's claim. Good: using `@{u}` (push order) rather than the timestamp rule is the right call; keep it.

Not bugs but unspecified (document them): (1) delete-vs-unchanged and add-vs-add rules are fine; (2) a key delete followed by re-add in a later merge is not tombstoned, so a stale branch can resurrect a deleted record only if git's merge base is wrong (criss-cross): git's recursive/ort strategy builds a virtual base, which is acceptable; (3) numbers beyond 2^53 are silently rounded on any merge that rewrites the record (`9007199254740993` becomes `...992`, reproduced), documented as "first parse only" but it also happens inside the merge driver; (4) `mergeJsonl` sort comparator (`merge.mjs:62`) returns 1 for equal elements (inconsistent comparator; harmless today because equal elements are identical lines).

---

## 1. Functional core, imperative shell; ports and adapters; capabilities

Sources: Bernhardt "Functional Core, Imperative Shell" (SECONDARY, via commentary: side-effecting code calls pure code; same idea as Ports and Adapters one level down) and Cockburn "Ports and Adapters" (SECONDARY: renamed from "hexagonal" in 2005; a port is a purpose-named interface, an adapter binds it to a technology).

Assessment of this repo: CONTRACT.md rule 4 ("pure core") already states FCIS. `lib/store.mjs` is the exception (fs, git, locks, clock, entropy in one file), and `bin/brain` is a 547-line shell that owns parsing, I/O, SQL, formatting and process lifecycle. The problems are concrete:

- `bin/brain:34-38,59-65` read `process.argv`, `process.cwd`, env, and run `git` at import time; every command closes over `argv`, `opt`, `DIR`, `DB`.
- `bin/brain:533-541` captures output by overwriting `console.log` and `process.exit`; `console.error` bypasses the capture, so stdout and stderr interleave differently under `--json`. Commands cannot be unit-tested without spawning a process.
- Bounded output (`R.bound`, limit 40) is applied after the fact to a joined string; commands that exceed the limit have already done the work.
- 29 commands, no registry: usage text, `NO_GUARD`, `WRITES_TEXT`, `NO_INDEX` and `table` are four parallel lists that must be edited together (`bin/brain:517-523,545`).

Proposed structure (no dependencies, same Node >= 24):

```
bin/brain                      # 15 lines: build Context from the real world, call run()
src/cli/run.mjs                # parse argv -> command -> Result -> render -> exit code
src/cli/parse-args.mjs         # pure: argv -> {cmd, positionals, flags}; unknown flag = error
src/cli/context.mjs            # makeContext(env) (shell); makeTestContext(overrides)
src/cli/render.mjs             # Result -> text | json envelope; bounding lives here
src/commands/<name>.mjs        # one file per command: export const spec, export async function run(ctx, args)
src/commands/index.mjs         # the registry (array of specs); usage text is derived from it
src/ports/                     # interfaces by JSDoc typedef + default adapters
  fs.mjs  git.mjs  clock.mjs  entropy.mjs  index-db.mjs  lock.mjs  process.mjs
lib/                           # unchanged: pure functions over plain data
```

Command spec (declarative, so guard sets disappear):

```js
// src/commands/claim.mjs
export const spec = {
  name: 'claim', args: [{ name: 'key', type: 'ticketKey' }], flags: { owner: { type: 'string', required: true } },
  needs: { index: false, formatGuard: 'write', writesText: true },
  summary: 'atomically claim a ticket (git compare-and-swap)',
};
export async function run(ctx, { key, owner }) {
  const r = await ctx.claims.claim(key, { owner, signal: ctx.signal });   // capability, not a global
  return r.ok ? ok({ line: `claimed ${key}` }) : fail('CLAIM_LOST', { holder: r.holder });
}
```

Context = capabilities, not globals (capability-based design: a function can only do what its parameters allow):

```js
// src/cli/context.mjs
export function makeContext({ argv, env, cwd, stdout, stderr, signal }) {
  const fs = nodeFs(); const git = gitPort({ cwd, timeoutMs: 30_000, signal });
  const root = git.topLevel() ?? cwd;
  const dir = resolveBrainDir({ flags, env, fs, root });
  return Object.freeze({
    root, dir, env, signal,
    now: () => new Date(), random: (n) => crypto.randomBytes(n),
    store: makeStore({ fs, dir }),            // readRecords/writeRecords, ALWAYS atomic
    index: lazy(() => openIndex({ fs, dir })), // node:sqlite loaded on first use (keeps the "old Node" guarantee)
    claims: makeClaims({ fs, git, dir, now, random, lock: fsLock(fs) }),
    log: { out: (s) => stdout.write(s), err: (s) => stderr.write(s) },
  });
}
```

Result and typed errors (no thrown strings, no `process.exit` in commands):

```js
// src/result.mjs  — tagged plain objects, exhaustively matched
export const ok   = (data, meta = {}) => ({ tag: 'ok', data, meta });
export const fail = (code, detail = {}, exit = 1) => ({ tag: 'fail', code, detail, exit });
export class BrainError extends Error { constructor(code, detail, exit = 1) { super(code); this.code = code; this.detail = detail; this.exit = exit; } }
// src/cli/run.mjs
export async function run(ctx, argv) {
  const parsed = parseArgs(argv, registry);            // Result
  if (parsed.tag === 'fail') return render(ctx, parsed);
  const cmd = registry.get(parsed.data.cmd);
  let res;
  try { res = await cmd.run(ctx, parsed.data.args); }
  catch (e) { res = e instanceof BrainError ? fail(e.code, e.detail, e.exit) : fail('INTERNAL', { message: e.message }, 70); }
  return render(ctx, res, parsed.data.flags);          // renders, returns exit code; ONLY bin/brain calls process.exit
}
// bin/brain
#!/usr/bin/env node
import { run } from '../src/cli/run.mjs'; import { makeContext } from '../src/cli/context.mjs';
const ac = new AbortController(); process.once('SIGINT', () => ac.abort());
process.exitCode = await run(makeContext({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, signal: ac.signal }), process.argv.slice(2));
```

Renderer owns bounding: commands return structured data (`{ lines | rows, total }`), the renderer applies `limit` and the `... N more` marker uniformly, and `--json` becomes a pure projection instead of `lines: all`. This also lets `--json` return real fields (today it wraps text lines). Keep the terse default untouched; the token contract (rule 2) is enforced in ONE place.

Migration path (low risk, each step ships): (1) extract `src/cli/render.mjs` and make the 3 existing `console.log` capture lines use it; (2) move commands one at a time into `src/commands/` behind the registry, keeping the old `table` as fallback; (3) introduce `Context` and replace `DIR/DB/ROOT` globals; (4) delete the monkey-patching. Verify each step with a golden test per command (section 3.6).

Worth it? Yes for the CLI (it is where the global state lives and where a regression is silent). Not worth: classes, DI containers, `fp-ts`/Effect-style libraries (violates the no-dependency rule and the code is small enough that plain objects carry it). SECONDARY/UNVERIFIED that Node's `util.parseArgs` is adequate for `parse-args.mjs`; it is built in and strict-mode rejects unknown flags, which fixes the current silent-ignore of typos (`opt()` just returns the default).

Also split `lib/store.mjs` (307 lines, five concerns) into `canon.mjs` (pure serialization), `format.mjs` + `migrations.mjs` (pure plans plus a thin apply), `ids.mjs`, `claims.mjs` (pure `resolveClaims` + effectful `claimTicket*`), `atomic.mjs` (writeAtomic, withLock), `git-driver.mjs`. This honors the CONTRACT's "no fs in library" rule: the pure halves stay in `lib/`, the effects move behind ports.

---

## 2. Data modelling in JS: parse, do not validate

Sources: King, "Parse, don't validate" (SECONDARY: a parser returns a more precise type or fails; "shotgun parsing" is validation scattered through the code). Branded types in JS are conventions, not enforcement (SECONDARY), so use them as documentation plus one constructor.

Current state: three JSONL parsers (`jsonl.mjs`, `store.parseJsonlText`, `openitems.parseItems`) plus `forecast.parseHistory`; they check "is an object" only. Field validation is scattered (`forecast` is the only careful one; `brain-solve` re-validates in Python with try/except, `bin/brain schedule-load` does not validate `sprint`). A bad `sp: "3"` is caught late, or never (SQLite happily stores it).

Proposal: one hand-written schema DSL, about 80 lines, no dependency. A schema is a plain tagged object; `parse(schema, raw, where)` returns `{ ok, value }` or a list of `file:line:field` errors, collects ALL errors per file (up to a cap), and strips nothing (unknown fields are preserved per FORMAT.md).

```js
// lib/schema.mjs
const t = {
  str:  (o = {}) => ({ tag: 'str', ...o }),  int: (o = {}) => ({ tag: 'int', ...o }),
  oneOf: (...v) => ({ tag: 'enum', v }),     optional: (s, dflt) => ({ tag: 'opt', s, dflt }),
  nullable: (s) => ({ tag: 'nullable', s }), arr: (s) => ({ tag: 'arr', s }), rec: (s) => ({ tag: 'map', s }),
  id: (re, brand) => ({ tag: 'id', re, brand }), iso: () => ({ tag: 'iso' }),
};
export function parseRecord(schema, raw, at) {              // at = 'tickets.jsonl:17'
  const errs = [], out = Object.create(null);
  for (const [k, s] of Object.entries(schema.fields)) check(s, Object.hasOwn(raw, k) ? raw[k] : MISSING, `${at}: ${k}`, errs, out, k);
  for (const k of Object.keys(raw)) if (!(k in schema.fields)) out[k] = raw[k];   // preserved, never validated
  return errs.length ? { ok: false, errors: errs } : { ok: true, value: out };
}
```

Schemas for each record type (field, type, rule). The "must not be silently accepted" rules are in bold:

| file | fields |
|---|---|
| tickets | `key` TicketKey `/^[A-Z][A-Z0-9]*-\d+$/` (Jira) or hash id; `summary` str (default ""); `epic` str; **`sp` int >= 0 (reject strings and floats)**; `jira_status` str; `v2_owner` str; **`v2_sprint` int or null**; `verdict` enum READY or the project's set (config), else warn; `verdict_source`, `first_verdict` str |
| edges | `consumer`, `producer` TicketKey; **`consumer !== producer`**; `kind` str default `plan_need`; `note` str. File-level: no duplicate (consumer, producer); referential: both keys exist in tickets (warning, not error: Done tickets get compacted) |
| schedule | `version` str default `current`; `key` TicketKey; `owner` str non-empty; **`sprint` int >= 1** |
| refs | `key`; `plans` set of `{plan:str, task:str}`; `files` map path to blob id (hex 40/64); `fp_files`, `jira_updated`, `audited_at` str/ISO; `fp_prods`: map TicketKey to hex16; `fp_links`, `rules` |
| open-items | `key`, `kind`, `status` enum `open`/`done`, `owner` str, `due_sprint` int or null, `text` str, optional `closed_at` ISO, `closed_by`, `close_note`, `source` |
| claims | `key`; `owner` non-empty; `claim_id` `/^c[0-9a-hjkmnp-tv-z]{6,}$/`; **`claimed_at` ISO-8601 UTC string only** (drop "or a number": it is the cause of B3; migrate numbers on read) |
| history | `sprint` int; `planned` number > 0; `done` number or null; `added`, `carried` numbers >= 0; `team`, `length` optional |
| evidence | `key` TicketKey; `source` str; `verdict` str; `resolution` str; `needs` str |
| findings | `key`, `kind`, `text` str |

Discriminated unions: model "kinds of things" as tagged objects and match exhaustively. Candidates in this codebase: (1) the `whatif`/`proposeMove` `reasons` (already `{code, key, detail}`; make `code` a closed set and add `assertNever`), (2) `status` of the solver and the staleness reasons (`plan files jira links rules full producer_changed`), (3) command Results (section 1), (4) claim outcomes `{tag:'claimed'|'already'|'held'|'lost'|'unpushed'}` instead of `{ok, already, lost, holder}` (the boolean soup is exactly what hid B5).

```js
export const assertNever = (x) => { throw new Error(`unhandled variant ${JSON.stringify(x)}`); };
const describe = (c) => { switch (c.tag) { case 'claimed': ...; case 'lost': ...; case 'unpushed': ...; default: assertNever(c); } };
```

JS has no compile-time exhaustiveness; get it two ways: a runtime `assertNever` default, and a test that iterates `Object.keys(VARIANTS)` against every `switch` via a table (`const handlers = { claimed, already, held, lost, unpushed }; handlers[c.tag]` and a test that `Object.keys(handlers)` equals the union). JSDoc + `// @ts-check` + `tsc --noEmit` (a devDependency) would give real exhaustiveness checking with zero build step; UNVERIFIED cost/benefit here, optional.

Branded IDs: `TicketKey`, `ClaimId`, `PersonName`, `Sprint` (int) constructed ONLY by the schema layer (`TicketKey.parse(s)`), passed around as plain strings. Value: stop `claim 'T 1'` and confusing a hash id with a Jira key (FORMAT.md already says the human key is never derived from the id). Cost: a few lines.

Immutability: `buildModel` returns Maps and arrays that callers could mutate; `whatif/proposeMove` work on `model.sched`. Freeze at the boundary in tests only (`deepFreeze(model)` in the test helper catches accidental mutation for free), rather than adopting persistent data structures (no library; workloads are 1.4k tickets). Make-illegal-states-unrepresentable, concretely: the claim record (one `claimed_at` representation), the `model` (`sched` entry always `{owner:string, sprint:int}` after parse), and `hash id vs key` separation.

---

## 3. Correctness methods beyond unit tests

Honest triage for THIS repo (single maintainer, no-dependency rule, ~3.7k lines of JS, numerical/graph core, git protocol at the edge):

| method | worth it? | why / first test |
|---|---|---|
| 3.1 property-based testing | YES, hand-rolled generators already exist (`test/fixtures/gen.mjs`, `rng`); adding `fast-check` as a devDependency is justified ONLY for shrinking and model-based commands | see below |
| 3.2 model-based / stateful testing | YES for the claim + merge protocols | see below |
| 3.3 mutation testing | PARTLY: custom mutators on 3 modules beat Stryker here | see below |
| 3.4 deterministic simulation | YES, small and cheap for the claim race, via an in-process fake git remote | see below |
| 3.5 metamorphic testing | YES for solver and whatif (strongest oracle-free tool you have) | see below |
| 3.6 golden/approval | YES for CLI output (token contract) | see below |
| 3.7 fuzzing | YES for `parseJsonlText`/`mergeJsonl` (structure-aware, in plain node) | see below |
| 3.8 contract tests lib/CLI | YES once the CLI is split | see below |
| differential testing | already done for stale; add for `mergeJsonl` vs a 40-line reference (below) | |

### 3.1 Property-based testing
fast-check (VERIFIED docs exist: `fast-check.dev`): arbitraries, shrinking, `commands` + `modelRun`/`asyncModelRun` for stateful testing, `scheduler`/`scheduledModelRun` for race conditions (SECONDARY from the docs listing). The contract says "no dependencies"; the text says nothing against devDependencies, and `node --test` still runs. Decision: allow `fast-check` as a devDependency (it ships no code to users). If the owner refuses, the hand-rolled route is `rng` + a 25-line shrinker for arrays of records (drop one element, re-run, repeat).

First property to write (this one finds B1 in seconds):
```js
import fc from 'fast-check';
const val = fc.oneof(fc.constant(null), fc.integer({min:0,max:3}), fc.constantFrom('a','b'), fc.constant(undefined));
const rec = fc.record({ key: fc.constant('K'), summary: val, sp: val, epic: val }, { requiredKeys: ['key'] });
test('merge is commutative when it does not conflict', () => fc.assert(fc.property(rec, rec, rec, (b, o, t) => {
  const ab = mergeJsonl({ base: J(b), ours: J(o), theirs: J(t) }, tickets), ba = mergeJsonl({ base: J(b), ours: J(t), theirs: J(o) }, tickets);
  fc.pre(!ab.conflicts.length && !ba.conflicts.length);
  assert.equal(ab.text, ba.text);
})));
```
Further laws worth stating (all cheap): `merge(b,o,o) = canon(o)`; `merge(b,b,t) = canon(t)`; `canon(parse(canon(x))) = canon(x)`; `merge(b,o,t)` contains no key that is in none of b,o,t; claims: `resolveClaims` result is invariant under permutation of the input (finds B3).

### 3.2 Model-based testing of claims and merges
Model = a pure Map `key -> claim_id` plus a "pushed order" list. Commands: `Claim(clone, key)`, `Pull(clone)`, `CrashAfterCommit(clone)`, `Retry(clone)`. Invariants after every command: at most one claimant per key on the remote; every `ok` return corresponds to a claim visible on the remote (this one fails today because of B5); no clone's working tree differs from `origin` except pending claim commits. Implement the git remote as a real temp bare repo (cheap, 20 ms per clone) for the integration test and as the in-memory model for the oracle. With fast-check: `fc.commands([...])` + `modelRun` (VERIFIED API names). Without it: a seeded random walk of 200 steps x 500 seeds.

### 3.3 Mutation testing
Stryker has no `node:test` runner; the documented route is the TAP runner (it runs any TAP-producing test files, including node's built-in runner) or the generic command runner (SECONDARY: stryker-mutator.io tap-runner page and the Stryker 7 announcement; I did not run it). Cost: ~100 MB of devDependencies and slow runs because the solver test takes ~45 s. Recommendation: a 60-line custom mutator script (`test/mutate.mjs`) applying a fixed list of regex mutations (`<` to `<=`, `===` to `!==`, `+ 1` to `+ 0`, delete a `continue`, swap `&&`/`||`) to ONLY `lib/merge.mjs`, `lib/store.mjs` (claims, canon), `lib/stale.mjs`, `lib/verify.mjs`, running just the matching test file with a timeout; fail CI under a mutation-score floor (start at what the manual run achieved). Reason: the mutants that matter are in 4 files and the matching tests run in seconds; Stryker's value (incremental, HTML report) is not needed for one maintainer. Revisit Stryker if the module count grows.

### 3.4 Deterministic simulation testing (FoundationDB style)
Source: Wilson, Strange Loop 2014 and Apple's FoundationDB testing docs (SECONDARY): run the whole system in one thread with simulated disk/network/time, seeded randomness, fault injection (BUGGIFY-style hooks), failing seeds replayable exactly.
Scale-down for this repo: you do not need a simulated network; you need a simulated `git remote` and a scheduler that interleaves the five steps of `claimTicketGit`. After the section 1 refactor `claimTicketGit` takes `git`, `fs`, `now`, `random` as ports, so a test can supply `FakeGit` (an in-memory remote: a list of commits, `push` fails with "rejected" if the clone's base is not the tip, `pull --rebase` replays through the real `mergeJsonl`) and a generator-based scheduler that yields at every port call. Run N clones x K tickets under a seeded random interleaving with crash points (throw at port call i), assert the invariants of 3.2. A failing seed is the repro. Value: high for B5/B4-class bugs, cost: about 150 lines plus the port refactor. Do it after section 1, not before.

### 3.5 Metamorphic testing (solver, whatif, simulate)
No oracle needed; relations between runs. Concrete, all runnable with `--deterministic`:
1. Relabel tickets and people (permute keys, rename owners): the optimal objective values are identical (not the schedule).
2. Add capacity (raise `caps.default`) : end sprint non-increasing.
3. Remove an edge: end sprint non-increasing; `owner_changes` bound non-increasing at fixed end.
4. Add a ticket with sp 0 and no edges: all objectives unchanged.
5. Duplicate the whole plan as two disjoint components: end sprint equals the max of the two solved separately.
6. Run with `--no-reduce` (already tested) and with edges shuffled (determinism of canonical order).
7. `whatif` : a move accepted by `whatif` must pass `verifyPlan` (already), and a move to the SAME owner and sprint is a no-op; moving then moving back restores the schedule when no other ticket shifted.
First one to write: relation 1 on `genPlan(seed)` with ~30 tickets, `--deterministic`, compare `meta.objective`.

### 3.6 Golden tests
`test/golden/<command>.txt` per CLI command on a fixed generated plan (`genPlan(1)`), with `UPDATE_GOLDEN=1` to rewrite. This enforces the "stable ordering, stable field names, under 250 tokens" contract and is the safety net for the section 1 refactor. First test: `brain ticket`, `neighbors`, `chain`, `sprint`, `check`, `verify` on the same fixture. Add `estTokens(out) <= budget` assertion per golden file.

### 3.7 Fuzzing in Node
Node has no built-in coverage-guided fuzzer; UNVERIFIED but standard options: `jsfuzz` or Jazzer.js (dependencies). Cheaper and sufficient: structure-aware random fuzz in a normal test. (a) Parser: mutate valid canonical lines (flip a byte, insert `\r`, BOM, a lone surrogate, a duplicate key, `__proto__`, huge numbers, deeply nested arrays) and assert `parseJsonlText` either returns records or throws with a `file:N` message (never a generic exception, never hangs); `canon(parse(canon(x))) === canon(x)` for every accepted line. (b) Merge driver: generate base then two divergent edit sequences, run `bin/brain-merge` as a subprocess (exit codes 0/1/2 only; `%A` untouched on 2), and check the output is valid JSONL or has markers. (c) Crash fuzz for `runMigration`: it already has `onWrite` hooks; throw at every index and assert re-run converges (the doc says tested).

### 3.8 Contract tests lib/CLI
After the refactor: every command's `run(ctx, args)` is tested in-process against a `makeTestContext` with in-memory ports; plus ONE end-to-end subprocess smoke per command (`test/smoke.sh` today). The envelope `{v, cmd, data, fresh}` gets a JSON-schema-like check (use the section 2 DSL) so the `--json` consumers (skills, hooks) cannot break silently.

### 3.9 Differential testing for the merge
Add a 40-line reference merger written the obvious way (per key, a lookup table over `(b?,o?,t?)` presence and equality, then fields) with Maps instead of objects, and compare with `mergeJsonl` over random inputs. This is also the natural place where B2 (prototype keys) is found, since the reference uses Maps.

---

## 4. Formal methods where cheap

Sources: TLC is an explicit-state model checker; Alloy is a bounded relational solver better for structural properties (SECONDARY: "Alloy meets TLA+" arXiv 1603.03599 and the 2024 "Designing Software with Complex Configurations" arXiv 2407.13633 which recommends TLA+/TLC for concurrent algorithms where only the node count varies).

Argument: the claim protocol is small, concurrent, and has a safety property ("at most one claimant is ever acknowledged"), so TLA+/TLC is a fit and costs about 80 lines. The three-way merge is a pure function over finite data; property tests (3.1) plus the differential reference (3.9) cover it with less tooling, and Alloy adds little over a 20000-case fuzz (which already found B1). Recommendation: write ONE TLA+ spec, for the claim protocol, including the failure actions that matter (crash after local commit, push rejected, pull). It would have flagged B5 as a violation of "every acknowledged claim is eventually on the remote" (a liveness-flavored property; as a safety property: "if the CLI reported success then the remote contains the claim").

Spec sketch (runnable shape; TLC needs a `.cfg` with `CONSTANTS Clones = {a,b}, Keys = {k1}` and `INVARIANT AtMostOne AckedImpliesRemote`):

```tla
---- MODULE Claim ----
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS Clones, Keys
VARIABLES remote,   \* set of <<key, claimant>> pairs on origin (set: the merge driver unions claims)
          local,    \* [Clones -> set of <<key, claimant>> in the working tree, pushed or not]
          pc,       \* [Clones -> "idle" | "committed" | "acked" | "lost"]
          acked     \* set of <<clone,key>> the CLI reported as success
vars == <<remote, local, pc, acked>>

Init == remote = {} /\ local = [c \in Clones |-> {}] /\ pc = [c \in Clones |-> "idle"] /\ acked = {}

Pull(c) == pc[c] = "idle" /\ local' = [local EXCEPT ![c] = remote] /\ UNCHANGED <<remote, pc, acked>>
Claim(c, k) == pc[c] = "idle" /\ \A x \in local[c] : x[1] # k   \* nobody holds k in my pulled view
               /\ local' = [local EXCEPT ![c] = @ \cup {<<k, c>>}] /\ pc' = [pc EXCEPT ![c] = "committed"]
               /\ UNCHANGED <<remote, acked>>
\* push = CAS: succeeds iff the clone's view of the remote is the remote (modelled by: remote subset local[c])
Push(c, k) == pc[c] = "committed" /\ <<k,c>> \in local[c] /\ remote \subseteq local[c]
              /\ remote' = remote \cup {<<k,c>>}
              /\ acked' = acked \cup {<<c,k>>} /\ pc' = [pc EXCEPT ![c] = "acked"] /\ UNCHANGED local
Reject(c, k) == pc[c] = "committed" /\ ~(remote \subseteq local[c])
                /\ local' = [local EXCEPT ![c] = @ \cup remote]            \* pull --rebase: union
                /\ IF \E x \in remote : x[1] = k /\ x[2] # c
                   THEN pc' = [pc EXCEPT ![c] = "lost"] /\ local' = [local EXCEPT ![c] = remote]
                   ELSE UNCHANGED pc /\ UNCHANGED <<remote, acked>>
Crash(c) == pc[c] = "committed" /\ pc' = [pc EXCEPT ![c] = "idle"] /\ UNCHANGED <<remote, local, acked>>   \* BUG B5: local keeps the claim
\* The tool as written: a retry sees its own local claim and acks without pushing.
BuggyRetry(c, k) == pc[c] = "idle" /\ <<k,c>> \in local[c] /\ acked' = acked \cup {<<c,k>>} /\ pc' = [pc EXCEPT ![c] = "acked"] /\ UNCHANGED <<remote, local>>

AtMostOne == \A k \in Keys : Cardinality({x \in remote : x[1] = k}) <= 1
AckedImpliesRemote == \A a \in acked : <<a[2], a[1]>> \in remote
Next == \E c \in Clones, k \in Keys : Pull(c) \/ Claim(c,k) \/ Push(c,k) \/ Reject(c,k) \/ Crash(c) \/ BuggyRetry(c,k)
Spec == Init /\ [][Next]_vars
====
```
With `BuggyRetry` enabled TLC reports a counterexample trace violating `AckedImpliesRemote` (Claim, Crash, BuggyRetry); removing it (retry must `Push`) makes both invariants hold for 2 clones x 1 key (my reasoning; I did not install TLC here, so treat the exact spec as UNVERIFIED until run). Effort half a day, mostly installing TLA+ Toolbox/`tla2tools.jar`. I would do it AFTER fixing B4/B5 by test, because the Node-level model-based test (3.2) catches the same bugs without a new toolchain; the spec's extra value is documenting the invariant for a future change to the protocol (adding release/tombstone). Priority: low-medium.

Merge/convergence in Alloy: not justified (above).

---

## 5. CRDT and merge theory

Sources: Shapiro et al. 2011 (SECONDARY): state-based CRDT = join-semilattice, merge is the least upper bound, every mutator an inflation; convergence needs the join to be commutative, associative, idempotent. LWW-register keeps the greatest-timestamp write; OR-Set gives add-wins using unique tags per add. git-bug (SECONDARY, its model doc): per-bug chain of operation packs, Lamport clocks, tie-break by pack id, "UnixTime for display only". beads (SECONDARY): JSONL in git, a custom merge driver, hash ids to avoid collisions.

Our merge is NOT a CRDT and does not try to be: it is a 3-way merge function `m(base, ours, theirs)`, parameterized by a common ancestor that git supplies. Properties, tested by fuzz (20000 cases, 5 fields, mixed types, deletes and adds):

- Idempotent in the useful sense (`m(b,o,o) = o`, `m(b,b,t) = t`): holds, 0 failures.
- Commutative (`m(b,o,t) = m(b,t,o)`) when there is no conflict: holds, 0 failures EXCEPT the null/absent case B1 (1106 failures when `null` is in the value pool). Since `git rebase` swaps the roles, this matters in practice.
- Associative: not a meaningful property for a 3-way merge (each application needs its own base). The relevant property is convergence of replicas after merging in different orders with the correct bases; git's `ort` strategy provides a merge base per merge and handles criss-cross by a virtual base. Known failure class for any 3-way merge: record deleted on one branch and independently re-added identically on the other loses nothing; "edit vs delete" is a conflict by design (good, loud).
- Set fields (`refs.plans`) merge as 3-way set difference (union minus removals): correct for "removed on one side and untouched on the other", gives add-wins on concurrent remove/add of the SAME element only if the element is in base (remove wins) and add-wins if not in base. That is OR-Set-like in the cases that occur; element identity is the canonical value, so a re-add after remove is indistinguishable (no tags): acceptable at this scale.
- Unknown files = set semantics with removals: fine.

Comparison and recommendation. A state-based design (LWW-register per field with a hybrid logical clock) would make merge conflict-free by construction but would silently pick a winner for the cases you currently surface as conflicts (both sides edit the same field differently). For planning data, a loud conflict is the correct product behavior; clock skew would also make LWW wrong exactly when two humans edit the same field. Keep 3-way, keep conflicts. Where a CRDT shape IS right: the claims file. It is an append-only grow-only set (G-Set) of `(key, claim_id, owner)` plus a deterministic projection `resolveClaims`; the join is union, which is trivially commutative/associative/idempotent. The only fragility is the arbiter: `resolveClaims` uses wall-clock `claimed_at` (skew) while the protocol's real arbiter is push order. Make the arbiter independent of clocks: git-bug's answer is a logical clock that follows the DAG. For you the cheapest sound option is to record in each claim the observed remote tip (`base_commit`) at claim time and arbitrate offline merges by `(topological position of the commit that added it, claim_id)`, or simply treat any multi-holder state as a `CLAIM_CONFLICT` finding and have `brain doctor` print it. Do not invest in more until a release/tombstone operation exists.

Fixes for the real bugs: B1: represent absence distinctly (`const MISSING = Symbol()`; `mergeField` receives `Object.hasOwn(x,f) ? x[f] : MISSING`, and compare canonical forms of present values only; absent is a value). B2: the same change (`Object.hasOwn`) removes inherited reads; also build `out` with `Object.create(null)` semantics (already uses `defineProperty`). Add the property test of 3.1 first; it fails today and passes after the fix.

---

## 6. Incremental computation; event sourcing / CQRS

Sources: Salsa (VERIFIED via rust-analyzer blog and rustc-dev-guide pages in search results): global revision counter, red-green validation, early cutoff, backdating, durability levels (a revision that changes only low-durability inputs skips validating queries that depend only on higher-durability inputs). Adapton, differential dataflow, Bazel/Nx: UNVERIFIED beyond common knowledge (demand-driven / delta-driven / content-addressed action caches).

Your `stale` module already is a content-addressed (Bazel-like) design with Merkle producer-cone digests, SCC condensation and a differential test: that is the right, minimal answer. What Salsa adds that you do not have, and whether it is worth it:
- Early cutoff / backdating: you get it implicitly because fingerprints are of normalized text; a whitespace-only change does not change the digest (decision recorded in STALE.md). Already covered.
- Durability: `rules` version and config change rarely vs plan text; not needed at 1.4k tickets (full recompute is fast, the cost is git `show`, which is already cached per instance).
- Demand-driven queries (Adapton/Salsa memo tables): would only pay if `brain` became a long-running server/watcher. It is a one-shot CLI. Not worth it.
- Differential dataflow: for continuously maintained derived data over streams; overkill.
Recommendation: keep `stale` as is. Two small improvements: (1) replace the mtime freshness check (B12) with a stored fingerprint of the source files in the index `meta` table (sha of each source file, compare at open); (2) expose `brain build` as a fingerprint-guarded no-op (skip when sources are unchanged).

Event sourcing / CQRS: the current design is already "state in text + derived read model (SQLite)", i.e. CQRS with snapshots as the source of truth, which is the right trade for diff-ability and `git merge`. Full event sourcing (git-bug style op log) buys per-operation history and merge-by-replay but costs the human-readable, canonical, per-key diff that the owner values and the contract mandates (rule 7). Adopt event sourcing only for one thing: `history.jsonl`/actuals-like facts that are already append-only (claims are the same). Do not event-source tickets. One cheap improvement that gets most of the audit value: a `log` command that derives "who changed what" from `git log -p` of the canonical files, which works today because they are sorted and canonical.

---

## 7. Scheduler (bin/brain-solve): modelling for large and tight instances

Sources: CP-SAT Primer (VERIFIED by fetch): `num_workers` default all cores, 8-worker portfolio includes LNS subsolvers, `use_lns_only` needs a time limit, `subsolvers`/`extra_subsolvers`/`ignore_subsolvers`, `fix_variables_to_their_hinted_value` (used to test hint feasibility), "presolve can be time-consuming, particularly for large models", custom LNS (destroy/repair, adapt neighborhood size by solve time, ALNS) preferred when you understand the structure. OR-Tools issue/discussion threads (SECONDARY): hints can be lost in presolve when the time limit hits there; not all workers follow the hint; symmetry: a maintainer advises more workers instead of manual symmetry breaking for interchangeable vehicles. No source found on lexicographic objectives; the staging below is my analysis.

What the current model does (read `bin/brain-solve`, `build`, `solve_all`): one-hot `x[i][p][k]` per free ticket (`tickets x people x horizon` booleans), `spr` and `oi` channeled by weighted sums, per link a `d` bool with `oi[c]==oi[p]` enforced when `d` is false and `spr[c] >= spr[p] + d`; transitive reduction; lexicographic stages (end, shortfall, load_of or peak, owner_changes) each re-solving the SAME model with a new objective, hinted from the previous result and a `<= obj` constraint. Each stage re-presolves (about 12 s at 1400 tickets, per SOLVER.md).

Why the owner-change stage does not converge (gap 78-100%): its objective `sum(1 - x[i][base_owner[i]])` has an LP relaxation near 0 (fractional assignments keep everyone at their base owner with tiny capacity violations spread out), so the best bound stays near 0 while any integer solution has dozens of changes; the "gap" is mostly bound weakness, not search failure. Same mechanism for the end-sprint stage on tight instances: the bound is the capacity bound `ceil(sum sp / sum cap)` and the true end is higher because of chains plus handoffs plus bin-packing; a 15.6% gap there is likely the proof difficulty, not a poor schedule.

Ranked improvements:
1. Stop using the weak CP bound as the gap you report; compute combinatorial lower bounds outside the solver and feed them in as constraints. End sprint: `max(capacity bound, longest chain length where every hop is forced same-owner = 0 handoff, so 1, per-person bound)`. Better: per-person bound: with `oc_p` = SP the baseline gives person p, and `K = end - lo + 1` sprints, tickets of p beyond `cap_p * K` must move, so `owner_changes >= sum_p max(0, ceil((sp_p - cap_p*K)/max_sp))` (each moved ticket frees at most its own SP; use the sorted-SP greedy for a sharper bound). Add it as `m.Add(expr >= LB)`: the solver then prunes and the reported gap becomes honest (`gap = (obj - LB)/obj`). Cheap, high impact for reporting, medium for solving.
2. Decompose stage 4 (owner changes) by connected components of the dependency graph (union-find on `edges`): components share only capacity. With few people and one shared capacity per person-sprint they are coupled, but you can solve components sequentially in a decreasing-size order with already placed components as fixed load (`const[p][k]`, which `build` already supports via `frozen`), then polish. Most real plans are one giant component plus many singletons; singletons should be solved last by a greedy or tiny model (they only fill capacity), which removes most of the 1400 x P x K booleans from the hard part.
3. Custom LNS for stages 3 and 4 (VERIFIED pattern from the Primer: destroy a neighborhood, re-solve, adapt size to solve time, accept improvements, tabu): neighborhoods natural here: (a) all tickets of one person pair (swap work), (b) all tickets in a sprint window `[s, s+w]`, (c) a ticket and its transitive producers/consumers up to depth 2, (d) the current top-load person-sprints. Implement by creating the model ONCE and passing neighborhoods as `Add(x[i] == hint)` assumptions via `AddAssumptions` or by fixing with `m.Add(...)` on a cloned model; each iteration has a 2-5 s limit. This also removes the repeated 12 s presolve per stage because the neighborhood is tiny. Expected effect: owner changes drop where built-in LNS stalls; deterministic mode keeps working with `max_deterministic_time` per iteration.
4. Merge the cheap stages into one weighted objective with big-M-free lexicographic weights: `E * W3 + shortfall * W2 + load * W1 + changes` where each W exceeds the max range of the lower terms (all small integers here). One solve instead of four removes three presolves; the stage structure is kept only for the proof report. Risk: weighted-sum bound is weaker; keep staged mode as `--staged`.
5. Tighten domains to shrink the booleans: after stage 1 fixes `E`, rebuild with `horizon = E` (the code adds `spr <= E` but the `K` columns beyond E stay in the model; presolve removes them but rebuilding makes presolve cheaper and the hint exact). Per-ticket windows: `earliest[i] = lo` and `latest[i] = E - tail_min[i]` where `tail_min` = longest chain of consumers that MUST be a handoff given frozen owners; usually 0, but frozen tickets pin the chain: propagate frozen slots along edges (a frozen consumer at sprint s forces its producers `<= s`, `<= s-1` if owners differ) to prune `x` variables.
6. Symmetry: people are NOT interchangeable (different caps, baseline owners), sprints are ordered, so classic symmetry breaking mostly does not apply. The exception: people with identical caps and NO baseline tickets (new hires in a what-if) are interchangeable; add `load[p1] >= load[p2]` for such groups. Do not add the rest; the OR-Tools maintainers' advice is to prefer more workers (SECONDARY).
7. Solver parameters to try, one at a time with `--deterministic`, measured by gap at fixed time (UNVERIFIED effects, parameter names VERIFIED to exist in the Primer): raise `num_workers` to cores for stage 4; `use_lns_only=True` with a time limit for stage 4 when a hint exists; `ignore_subsolvers` to drop non-LNS workers; set `max_presolve_iterations` small (UNVERIFIED name) for later stages because the presolve result is mostly unchanged; `log_search_progress=True` under `--verbose` to see which worker finds improvements (the Primer calls it crucial).
8. Anytime behaviour: stage time is `avail*0.6` for stage 1 and `avail/left` for later stages, with nothing carried if a stage ends early (it does roll forward, good). Make stage 4 explicitly an anytime LNS loop that writes the best verified schedule after every improvement (`atomic_write` already exists; use it) so a kill at any time leaves a valid file; currently the best is written only at the end.
9. Honest reporting: report `LB` source (`capacity`, `chain`, `solver`) next to the gap; today `gap_pct = |obj-bound|/max(1,obj)` with bound 0 for stage 4 gives "100%" which reads as failure when it may be optimal.

Evidence caveat: I did not run the solver on a 1400-ticket instance (OR-Tools is not installed in this sandbox, and the project's `solver.test.mjs` skips without it). Items 1-3 follow from reading the model and from the documented behavior; items 5, 7 are hypotheses to measure.

---

## 8. Concurrency and failure handling audit

Atomic write pattern (VERIFIED via the CACM crash-consistency paper and Rust forum/LWN summaries in the search results): write temp, fsync file, rename, fsync containing directory; directory fsync is best-effort on some filesystems. `writeAtomic` (`store.mjs:94`) does the first three. Add `fsyncDir(path.dirname(file))` after the rename, wrapped in try/catch (`EINVAL`/`EPERM` tolerated). On macOS `fs.fsync` does not force the drive cache (`F_FULLFSYNC` needed; UNVERIFIED, Apple docs thread unresolved); acceptable because git holds the history.

Audit (violations first):

| item | file:line | issue | fix |
|---|---|---|---|
| non-atomic source writes | `bin/brain:282,453,481,488,489,133` | truncate-then-write of source-of-truth files | route ALL text writes through `ctx.store.write(file, text)` = `writeAtomic` |
| multi-file update order | `bin/brain:481` (compact), `488-489` (restore) | no transaction across files; compact writes hot before archives (B8) | write archives first, then hot, under a `.compact.lock`; restore: write hot, then delete archives (already correct order, but still non-atomic writes) |
| lock stale-break TOCTOU | `store.mjs:102-115` | check `mtime` then `rmSync` race (B6); `finally` removes a lock it may no longer own | write a unique token into the lock; to break a stale lock `rename(lock, lock+'.stale-'+token)` (atomic, only one waiter wins) then recheck; on release read the token and remove only if equal; also treat a lock whose pid is dead (`process.kill(pid,0)` throws ESRCH) as stale instead of waiting 30 s |
| lock in claim path is held during file work only | `store.mjs:236-243` | fine, but the git steps are outside the lock: two local processes can interleave `pull`/`claim`/`commit` | hold a repo-level `.git/brain-claim.lock` for the whole `claimTicketGit` (not `.brain/`, so it cannot be committed) |
| no timeouts on git | `store.mjs:245`, `stale.mjs:217`, `bin/brain:255` | `execFileSync` can hang forever (credential prompt is disabled, network is not) | `timeout: 30000`, `killSignal: 'SIGKILL'`, surface as `TIMEOUT` error; accept `ctx.signal` and pass `signal` (execFile supports it; `execFileSync` does not, so move to async `execFile` with `signal`, UNVERIFIED for `execFileSync`) |
| `jira-pull` temp name fixed | `bin/brain:298` | `out + '.tmp'` collides with a concurrent pull; no fsync | use `writeAtomic` |
| claim retry idempotence | `store.mjs:261` | B5 | after a pull, if own claim exists in the tree but is not contained in `@{u}` (`git merge-base --is-ancestor` or `git cherry`), go to the push loop instead of returning `already` |
| dirty tree | `store.mjs:258` | B4 | `git pull --rebase --autostash`, or `git stash` of unrelated changes is wrong; better: do not touch the working tree at all: use `git fetch`, then build the new claims file as a commit in a temporary worktree or with plumbing (`git hash-object`, `git update-index --cacheinfo`, `commit-tree`) and `git push origin <sha>:refs/heads/<branch>`. Cheapest: `--autostash` plus a test |
| retries without backoff or jitter | `store.mjs:263-275` | 5 immediate retries; under contention all clones retry in lockstep | exponential backoff with full jitter, capped total time; return `{tag:'unpushed'}` (typed) rather than throw after `maxRetries` |
| cancellation | everywhere except `jira.mjs:155` (`AbortSignal.timeout`) | no `AbortSignal` plumbing in CLI | `ctx.signal` from SIGINT (section 1), passed to git and jira calls; `Atomics.wait` sleeps in `withLock` are not abortable: switch to async `setTimeout(..., {signal})` from `node:timers/promises` |
| idempotence | `refs-update`, `export`, `compact`, `claim`, `migrate` | `migrate` and canonical writes are idempotent (documented, tested); `compact` is reversible by hash; `claim` is B5; `schedule-load` is not idempotent (errors if archive name reused, which is correct) | fine apart from B5 |
| index build | `bin/brain:106-130` | build into temp then rename: good; stale temp cleanup on start: good; `journal_mode=OFF` fine for a throwaway file | none; add fingerprint (B12) |
| multi-process index read while building | `bin/brain:138` | readers open the old file while rename swaps: safe on POSIX | none |
| solver output | `brain-solve atomic_write` | correct (mkstemp, fsync, `os.replace`), no dir fsync | add dir fsync for symmetry |

Typed outcomes to replace booleans (supports section 2): `claimTicketGit` returns one of `{tag:'claimed'}`, `{tag:'already', pushed:true|false}`, `{tag:'held', holder}`, `{tag:'lost', holder}`, `{tag:'unpushed', reason}`; the CLI maps `unpushed` to a nonzero exit and a message "committed locally, run `brain claim --retry-push`".

---

## 9. Prioritized change list

Impact: H/M/L for correctness or maintainability. Effort: S (< half day), M (1-2 days), L (> 2 days). Risk of the change itself.

| rank | change | impact | effort | risk |
|---|---|---|---|---|
| 1 | Fix claim protocol: B5 (never ack an unpushed claim), B4 (`--autostash` or plumbing), typed outcomes, backoff, git timeouts; model-based/race test | H | M | low |
| 2 | Fix merge algebra: absent vs null (B1), `Object.hasOwn` (B2), evidence id includes extras (B7); add commutativity/idempotence property tests and the Map-based reference | H | S | low |
| 3 | Route every text write through `writeAtomic` + dir fsync; reorder compact writes (B8-B10) | H | S | low |
| 4 | Single schema/parser layer with file:line:field errors; claims `claimed_at` ISO only (B3, B11) | H | M | low-med (format: it is an expand step, per FORMAT.md) |
| 5 | CLI restructure: registry, Context with ports, Result/typed errors, renderer owns bounding; golden tests first | H | L | med (mitigated by goldens, incremental steps) |
| 6 | Solver: combinatorial lower bounds for honest gaps; component decomposition; custom LNS for owner-change stage; anytime writes | H for the 1400-ticket case | M-L | med (needs measurement; keep verifier gate) |
| 7 | Lock hardening (token + atomic stale break) and repo-level claim lock (B6) | M | S | low |
| 8 | Metamorphic tests for solver/whatif; structure-aware fuzz for parser and driver | M | S-M | none |
| 9 | Index freshness by fingerprint instead of mtime (B12) | L-M | S | low |
| 10 | TLA+ spec for the claim protocol; deterministic simulation harness once ports exist | M | M | none (tests only) |
| 11 | Custom mutation script on 4 modules (CI floor) | M | S | none |
| defer | CRDT/HLC rewrite of merge, event sourcing of tickets, Salsa-style engine, Stryker, Alloy, persistent-data libraries, `fp-ts`/Effect | L | L | high | 

Proposed module structure: see section 1 (`bin/brain` thin; `src/cli`, `src/commands`, `src/ports`; `lib/` pure; `lib/store.mjs` split into canon/format/migrations/ids/claims/atomic/git-driver; `lib/schema.mjs` new).

Order of work (dependencies): 3 and 2 first (small, independent, immediately reduce risk), then 1 (needs 3's atomic writes and lock fix), then 4, then 5 (golden tests written BEFORE the move), then 10 and 8 on top of the ports, and 6 as a separate stream guarded by the existing independent verifier.

## 10. Sources

- fast-check model-based testing and `asyncModelRun`/`commands` API: https://fast-check.dev/docs/advanced/model-based-testing/ , https://fast-check.dev/docs/api/functions/asyncModelRun/ (SECONDARY: from search summary)
- Stryker TAP runner and Node test runner note: https://stryker-mutator.io/docs/stryker-js/tap-runner/ , https://stryker-mutator.io/blog/announcing-stryker-js-7/ (SECONDARY)
- Salsa and durability: https://rust-analyzer.github.io/blog/2023/07/24/durable-incrementality.html , https://rustc-dev-guide.rust-lang.org/salsa.html (SECONDARY)
- CP-SAT Primer parameters and LNS: https://d-krupke.github.io/cpsat-primer/parameters.html , https://d-krupke.github.io/cpsat-primer/lns.html (VERIFIED by fetch)
- OR-Tools hint/presolve discussions: https://github.com/google/or-tools/discussions/3277 , https://github.com/google/or-tools/issues/3750 , symmetry thread https://github.com/google/or-tools/discussions/3295 (SECONDARY)
- Crash consistency and rename+fsync: https://lwn.net/Articles/667788/ family and the CACM "Crash consistency" article https://cacm.acm.org/?p=73216 (SECONDARY; Dan Luu's "Files are hard" itself was not returned)
- CRDTs: Shapiro et al., SSS 2011, https://www.cs.tufts.edu/~nr/cs257/archive/marc-shapiro/CRDTs_SSS-2011.pdf ; overview https://arxiv.org/abs/1806.10254 (SECONDARY)
- git-bug data model: https://github.com/MichaelMure/git-bug/blob/master/doc/model.md ; beads (steveyegge/beads) JSONL + merge driver: https://pkg.go.dev/github.com/steveyegge/beads (SECONDARY)
- FoundationDB simulation: https://apple.github.io/foundationdb/testing.html , https://thestrangeloop.com/2014/testing-distributed-systems-w-slash-deterministic-simulation.html (SECONDARY)
- TLA+ vs Alloy: https://arxiv.org/pdf/1603.03599 , https://arxiv.org/html/2407.13633v1 (SECONDARY)
- Parse, don't validate (King 2019): https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/ (SECONDARY via mirrors)
- Ports and Adapters (Cockburn), Functional Core / Imperative Shell (Bernhardt): https://en.wikipedia.org/wiki/Hexagonal_architecture_(software) (SECONDARY)
- Git behaviors (`pull --rebase` on a dirty tree, `@{u}` after pull, reset --keep): VERIFIED by running git in the scratchpad.
