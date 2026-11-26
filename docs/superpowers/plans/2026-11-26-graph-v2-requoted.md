# Graph v2, 0.4.0 execution brief (Task 0: the graph plan re-quoted against the renamed tree)

Inputs: the graph plan `2026-11-24-graph-model-v2.md` (old text, "plan" below), the binding amendment `2026-11-25-graph-v2-amendment.md` ("amendment"), the name map of `2026-11-25-plangraph-0.3.0-revised.md` section 3. Where plan and amendment disagree the amendment wins; contradictions the amendment does not settle are Open items (section 9). This file changes no source and replaces no plan text: an implementer reads the plan task, then this brief for paths, anchors and deltas.

Tree measured: commit `8412633` (base of branch `g0`), package version `0.3.0-dev`, Node floor 24.15, Jira code split under `lib/jira/`, consent-gated merge-driver heal, `bin/plangraph*` launchers. There is no `v0.3.0` tag and no `.baseline/` directory in this tree (see Open items 1 and 2). Line numbers below are for this commit and go stale at the next edit; the quoted text is the anchor.

## 1. Rename map applied to the plan

`brain` command -> `plangraph`; `.brain/` -> `.plangraph/`; `brain.sqlite` -> `plangraph.sqlite` (`INDEX_FILE`, `src/db.ts:30`); `bin/brain-solve` -> `bin/plangraph-solve` (its input test is `test/plangraph-solve-input.test.ts`, not `brain-solve-input`); `bin/brain-merge` -> `bin/plangraph-merge`; `brain-jsonl` -> `plangraph-jsonl`; `BRAIN_*` -> `PLANGRAPH_*` (perf factor: `PLANGRAPH_PERF_FACTOR`, `test/helpers/perf.ts:12`; property runs: `PLANGRAPH_PROPERTY_RUNS`); `BrainError` -> `PlangraphError` (`src/errors.ts:31`, codes include `STALE` with `try: plangraph build`); `brain doctor|check|build|...` -> `plangraph ...`. Test constant `APPROVED_BRAIN` (`test/skills-routing.test.ts:138`) and identifiers `needBrain` (`src/commands/shared.ts:70`), `brainDir`/`resolveBrainDir` (`src/context.ts`, `lib/fsafe.ts:44`) keep their old spelling: the map renames tool names, files and variables, not those identifiers; do not rename them in graph tasks. `brain_rules_version` stays (exception 1 of the map). Skill dir `skills/brain/` is now `skills/plangraph/`.

## 2. What the amendment changes in the 0.4.0 scope

| Plan text | Amendment ruling | Effect in this brief |
|---|---|---|
| Six graph files incl. `plantasks.jsonl` | 3.14 item 9: `plantasks.jsonl` dropped; set = people, sprints, epics, repos, capacity, links, xrefs (7) | no `plantask` table, no `PlanTaskRow`; plan tasks only derived (Open item 3) |
| `NodeType` 6 values, `RELATIONS = ['relates_to']` | 3.1: core types `ticket person sprint epic plantask openitem plan doc repo` plus `x-<sys>.<kind>`; relations plus `x-<sys>/<rel>` | open grammars; `LINK_UNKNOWN_REL` only for unknown non-`x-` relations |
| Six derived relations | adds `part_of`, `specified_by`, `tracked_by`, and (3.10) `owned_by` | `DERIVED_RELATIONS` grows; `V1_HOME` gains homes (Task 1) |
| `openitem` not in `g_nodes` | 4.4: it is a node type and appears in `g_nodes` | via `graphReader` in TypeScript (Open item 4) |
| Task 2A format-2 guard; Task 8 migration | 3.9, D23: no format bump before 1.0.0; Task 8 becomes `graph materialize` (0.5.0) | Task 2A dropped from 0.4.0 (Open item 5) |
| `capacity.jsonl` a node file | 4.3: data file, not a node type; 3.13 item 4: optional `review_h` | `capacity` table stays, not in `g_nodes` |
| Person rename "solved" | 4.2: not solved; `person.id` = schedule owner string | doc wording only |
| Spec section 4 | 4.5: nodes keyed per file; no file stores a `type` field | spec edit in Task 1 docs |
| `edges.kind` | 4.6: stays a free string | no change |
| Ids free text | 3.1: new rows at most 200 chars, no C0/C1/bidi/line-break; old values warn only | `parseGraphFile` warning path |
| `docs/CONTRACT.md` "eight text files" | 4.8: updated in Task 2 | line 178 (still the old text) |
| New | Tasks 1A (`pg:` URI), 1B (`repo scan`), 7B (format benchmark), 7C (differential tests); `explain` stays unchanged except `graph` and `repo` | sections 5 |

## 3. Interfaces of the current tree that the tasks consume

`lib/store.ts`: `FORMAT_VERSION = 1`, `MIN_FORMAT = 1`; `interface Schema { file; order: string[]; sets: string[]; defaults: Record<string, unknown>; id: KeyFn; sort: KeyFn }`; `SCHEMAS: Record<string, Schema>` (nine files, built by private `mk(file, key[], order[], extra)` at `:40`); `schemaFor(fileName): Schema` (`:55`, `|| FALLBACK`); `specOf`, `withDefaults`, `canonValue`, `canonLine(obj, spec?)`, `canonFile(records, spec?)`, `canonText(text, spec?, name?)`, `parseJsonlText(text, name)`, `readRecords(dir, file, { defaults })`, `keyStr(parts)`, `showKey(k)`; `checkFormat(dir, supported = { version: FORMAT_VERSION, min: MIN_FORMAT }, { mode = 'write' })` (`:221`; read mode already exists: it compares `min_reader`); `readFormat`, `writeFormat(dir, { format_version, min_reader })`; `migrations: Migration[]` (one entry, `from: 0, to: 1`); `installMergeDriver(repoRoot, { dir = '.plangraph', driverPath })`.

`lib/schema.ts` (23 lines): exports `Rec`, `IMPL_STATUSES`, `validators: Record<string, (r: Rec) => string | null>` (six files: tickets, edges, schedule, findings, refs, open-items). Helpers `str`, `optStr`, `optNum`, `optInt`, `optNonNeg`, `first`, `need` are NOT exported. `src/db.ts` `validatorOf` reads `validators[t.file]`, so graph validators must be registered in this map or `build` skips them.

`lib/jsonl.ts`: `parseJsonl(text, name, { maxLine, validate })`, `readJsonl`, `readDataCapped(file, max)`, `presentDataFile(f)` (false when missing, throws `IngestError` on a symlink), `IngestError`, `DATA_REFUSALS`.

`src/db.ts`: `INDEX_FILE`, `FINGERPRINT_KEY`, `CONTENT_KEY`; private `DEFS: Array<[table, file, pk[], intCols[], upsert]>` (`:39`, eight rows); `TABLES: Map<string, Readonly<TableSpec>>` (`:66`; `TableSpec { name; file; columns; upsert; known; text; scalar; columnList; placeholders; ddl; prep; order }`); private `PREP`, `PREPPED`, `DDL` (`:86`), `SOURCE_FILES` (`:85`), `readSources`, `fingerprintOf`, `rowOf`, `scalarCheck`, `schemaOk`; exported `EXPECTED_COLUMNS`, `EXPECTED_INDEXES`, `sourceFingerprint(dir)`, `contentDigest(h)`, `stampContent(h)`, `buildIndex(ctx, { file, now })`, `openIndex(file, { readOnly = true, dir })`, `stampFingerprint(file, dir)`, `SIDECARS`, `class IndexHandle { exec, prepare, cached, all(sql, ...a), get(sql, ...a), close, stale: boolean | null, fingerprint, builtFingerprint }`. Column names in `ddl`/`columnList`/`order` are unquoted today (`IDENT = /^[a-z][a-z0-9_]*$/`, `:35`).

`src/commands/shared.ts`: `CUR = "version='current'"` (`:23`), `KEY_RE`, `MAX_DATA`, `SRC_FILES` (`:27`, nine names incl. `open-items`), `dbFile(ctx)`, `rel`, `verbose(args)`, `isPlaced`, `fenceLines/fenceBlock/fencedList(src, items, max, line, what)`, `shellArg`, `nextCommand(words)`, `nextList`, `dataText`, `needBrain`, `usage(msg)`, `dataError(msg, hint?)`, `modelFromDb(ctx): Model` (`:103`, reads `ticket`, `edge`, `schedule`, `finding`, `evidence`, ... through `ctx.db()`), `readItems(ctx): Promise<{ OI, items }>` (`:109`), `wireMergeDriver`, `recordHealConsent`, `writeState`, `precheckTargets`.

`src/context.ts`: `Ctx` (`db()`, `config()`, `io` with `out`, `err`, `outBlock`, `raw`, `data?`, `dir`, `root`, `env`, `flags`, `now`, `git`), `STALE_WARNING`, `makeContext`; `ctx.db()` = `warnStale(openIndex(path.join(dir, INDEX_FILE), { readOnly: true, dir }))`; `fresh()` = first 8 hex of `handle.fingerprint` (the `fresh.fp` of the `--json` envelope).

`src/registry.ts`/`src/commands/index.ts`: a command is `{ run, positionals: [min, max], options?, writes?, guard?, summary, also? }` in a `CommandMap`; groups are listed in `GROUPS` (`src/commands/index.ts:12`, nine groups); default guard `soft`; `guard: 'strict'` refuses on any format problem. `src/cli.ts:81` `formatGuard` calls `checkFormat(ctx.dir)` (write mode). Errors: `PlangraphError(code, message, { hint, cause })`.

`lib/model.ts`: `Model`, `ModelRecords { tickets, edges, schedule, config, findings, evidence, learnings, refs }`, `buildModel(records)`, `loadModel(dir, { config })`, `capOf(cfg, person) = ownNumber(cfg.caps, person, 140)` (`:68`), `PlanConfig`, `Placement`, `readConfig`.

`lib/ready.ts` (102 lines): `readiness(model, key, { items, statuses, closed, findingsOf }): Readiness`, `readySet(model, items, statuses, { keys })`, `readyScope(model, { owner, sprint }, items, statuses)`, `doneOf`, `closedStatuses`; `Reason = { code: 'VERDICT'; verdict } | { code: 'OPEN_ITEM'; from: 'finding' | 'item'; kind; text; owner? } | { code: 'WAITS'; key; status; impl; place }`; `ReadyOpts { items?: readonly PlanRecord[]; statuses?; closed?; findingsOf? }` (items typed `PlanRecord`, cast to `OpenItem` inside).

`lib/openitems.ts`: `OpenItem`, `parseItems(text, name)`, `closedSet(items)`, `blockingItems(items, key)` (open rows of the key, sorted); item id is `key + '|' + kind` (private `idOf`, `:51`). `lib/whatif.ts`: `whatif(model, mv, opts)`, `proposeMove`, `relieve(model, { person, sprint }, opts)`, `findSlots(model, key, opts)`, `resolvePerson`, `WhatifCode` (no gate or slot codes yet). `lib/verify.ts`: `verifyPlan(model, sched?, opts?)`, `Violation` (`:22`), shares only `capOf`/`ownNumber` with the model. `lib/forecast.ts`: `forecast({ history, actuals, model, config, seed })`. `bin/plangraph-solve` (Python): `INDEX_TABLES` (`:155`, `{table: (columns, pk)}`), `EXPECTED_COLUMNS`, `EXPECTED_INDEXES`, `index_order(t)`, `schema_ok(db)` (`:177`), `content_digest(db)` (`:198`), `open_index(dbp)` (`:211`).

## 4. Anchor ledger (every anchor the plan cites for Tasks 1 to 7)

Status: OK = text and line unchanged; MOVED = text exists at the new line; CHANGED = text differs; GONE = no longer exists. Old lines were on `89193c9`.

| Task | Plan anchor | Now | Status |
|---|---|---|---|
| 1 | `lib/stale.ts:17-19` (refs.plans entries unchecked) | `:17-19` "plan and task are unchecked" | OK |
| 1 | `src/commands/shared.ts:22` seed read | `:22` `export const SEED = path.join(import.meta.dirname, '../../seed/learnings.seed.jsonl');` | OK |
| 1 | `lib/store.ts:239` `Object.keys(SCHEMAS)` | `:239` `for (const name of Object.keys(SCHEMAS).sort()) {` (inside `migrations[0].plan`) | OK |
| 1 | `lib/store.ts:54` whole-record identity | `:54` `const FALLBACK: Schema = { ... id: (r) => sha(canonLine(...)) ...}` | OK |
| 1 | `lib/merge.ts:56-58` | `:56-58` `if (same(o.lines, t.lines)) take(o.lines);` / `else if (same(o.lines, b.lines)) take(t.lines);` / `else if (same(t.lines, b.lines)) take(o.lines);` | OK |
| 1 | `src/db.ts:67` columns from `SCHEMAS[file].order` | `:67` `const columns = Object.freeze([...(SCHEMAS[file] as Schema).order]);` | OK |
| 1 | `lib/schema.ts` `optInt` | `:9` `const optInt: FieldCheck = ...` not exported | CHANGED (needs export) |
| 1 | `src/commands/queries.ts:335-339` `cardLineText` | `:344-356`; loop `:348` `for (const f of ['config.json', ...SRC_FILES]) {`; missing file `:350` `h.update(\`${f}\0${b.length}\0${b}\0\`)` with `b = ''` | MOVED |
| 1 | `queries.ts:357` `firstUseLine` | `:363` (SRC_FILES loop `:370`) | MOVED |
| 1 | `src/context.ts:115` `fresh.fp` | `:115` `fresh: () => (handle?.fingerprint ? { fp: handle.fingerprint.slice(0, 8), ...` | OK |
| 1 | `lib/openitems.ts:9-11` key\|kind identity | `:9-10` comment "identified by key|kind", `:51` `const idOf = (i: OpenItem): string => i.key + '|' + i.kind;` | MOVED |
| 1 | `lib/integrations/superpowers.ts:470,500,502` | `:470` `const epic = \`sp:${plan.slug}\`...`; `:500` `const tickets = [mkTicket(epic, ..., '', 0)];`; `:502` `const r = mkTicket(keyOf(t.id), t.title, epic, t.points);` | OK |
| 1 | `superpowers.ts:559` (refs.plans write) | `:557` `return { ...prev, key, plans: [...others, ...mine], files: fm };`, `:559` `const newRefs = [mkRef(epic, plan.header.spec ? [plan.header.spec] : [], null), ...` (the epic row gets `plans: []` and the spec in `files`) | MOVED |
| 1 | `test/store.test.ts:37-48`; `test/mutation-kills-store.test.ts:24-30, :142` | `:37` `canon: idempotent, order-independent, byte-stable over random records for every schema`; `:24`, `:142` | OK |
| 1 | `test/tsconfig.test.ts` rule R25 | `:41` `checkJsSources(tracked, includes)` | OK |
| 1 | `scripts/mutate-all.ts` `DEFAULT_TARGETS` | `:36` `['lib/*', 'lib/integrations/*', 'lib/jira/*', 'src/*', 'src/commands/*', 'mcp/*']` | CHANGED (add `lib/graph/*`) |
| 1 | `biome.jsonc`, `knip.jsonc`, `tsconfig.json exclude` | files are still `biome.json`, `knip.json`; `tsconfig.json` has no `exclude` key yet | CHANGED (Open item 6) |
| 1 | `test/helpers/cli-fixture.ts:50` `init` | `:50` `assert.equal((await run(d, ['init'])).code, 0);` | OK |
| 1 | `scripts/baseline.ts:11`, `:96-100` | `:12` header comment "NOT covered: the Python solver (own tests), ..."; `:94` `/** The registry as \`plangraph explain --json\` reports it.` (every command runs with `--json` in the matrix) | MOVED |
| 2 | `src/db.ts:161-168`, `:179`, `:308-311` | `fingerprintOf` `:161-169` (`h.update(\`${f}\0-\0\`)` for a missing file at `:164`); `contentDigest` `:179`; `schemaOk` comment `:308-312`, `else return false; // view, trigger, anything else` `:324` | MOVED/OK |
| 2 | `src/db.ts:373-374`, `:376-380`, `:383-390`, `:401` | `:372-374` `let good = false; try { good = schemaOk(h); } ... 'the index has an unexpected schema (not built by plangraph build)'`; `:376-380` no-digest branch (`readOnly: false` throws `the index has no integrity digest (built by an older plangraph)`); `:382-385` digest compare; `:386-391` fingerprint/stale (`h.stale = stored !== h.fingerprint || want === undefined`); `stampFingerprint` `:399-407` | MOVED |
| 2 | `src/db.ts:130`, `:139-142`, `:39-48` | `rowOf` `:128-138`; `scalarCheck` `:140-143`; `DEFS` `:39-48` | MOVED/OK |
| 2 | `bin/brain-solve:176-191` | `bin/plangraph-solve:155-163` tables, `:177-191` `schema_ok`, `:198-207` `content_digest`; refusal text `:235` `the index has an unexpected schema (not built by plangraph build)`, `:237` `no integrity digest (built by an older plangraph)` | MOVED |
| 2 | `test/brain-solve-input.test.ts:63-72`, `:23` | `test/plangraph-solve-input.test.ts:63` (`the Python schema allowlist, table order and sidecar list are the same as src/db.ts`, no view assertion yet), `:23` `const SKIP = HAVE_PY3 ? false : 'skipped: no python3';` | MOVED |
| 2 | `test/index-integrity.test.ts:41-51, :53-55` | `:41` `const EDITS = {`, `:53` `test('every table has a direct-edit case'` | OK |
| 2 | `docs/SOLVER.md:252-254` | `:275` "its `sqlite_master` must pass the same schema allowlist as `schemaOk` (a planted view, ..." | MOVED |
| 2 | `docs/CONTRACT.md:184-195`, `:178` | `:184-195` index integrity paragraph; `:178` "sha256 of the eight text files it is built from" | OK |
| 2 | `test/build-extra.test.ts:146-155, :164-171` | `:146` `(f) source scan: the INSERT column lists come from constants, never from record keys`; `:164` `(f) runtime: every table spec lists its schema columns plus extra...` | OK |
| 2 | `src/commands/plan.ts:122, :146, :236, :371, :373` | `:122` `using db = openIndex(dbFile(ctx), { readOnly: false });` (whatif --write); `:146` same (schedule-load); `:236` `writeFormat(dir, { format_version: S.FORMAT_VERSION, min_reader: S.FORMAT_VERSION })`; build/schedule-load are in `commands` `:373+` with the default `soft` guard | MOVED |
| 2 | `shared.ts:109-113` `readItems`; `:23` `CUR` | `:109-113`; `:23` | OK |
| 2 | `queries.ts:125, :140` (`person`/`sprint` join `ticket`) | `:125` `const rows = d.all(\`SELECT s.owner, SUM(t.sp) sp, COUNT(*) n FROM schedule s JOIN ticket t ON t.key=s.key WHERE s.${CUR} AND s.sprint=? ...`; `:140` same for person | OK |
| 2 | `src/context.ts:107` stale handles keep answering | `:112` `db: () => (handle ??= warnStale(openIndex(...)))` (comment `:96-98` "is still answered from") | MOVED |
| 2A | `src/cli.ts:84`, `lib/store.ts:221-224`, `src/registry.ts:47`, `README.md:302`, `queries.ts:366` | `src/cli.ts:84` `try { checkFormat(ctx.dir); } catch (e) {`; `store.ts:221-224` OK; registry default `guard = 'soft'` `:47`; `README.md:306` (`A tool refuses to write to a newer format`); `queries.ts:379` | MOVED; task dropped (Open item 5) |
| 3 | `lib/verify.ts:1, :22`; `shared.ts:109`; `lib/model.ts:56-59`; `store.ts:44` | `verify.ts:1` header; `:22` `export type Violation = ...`; `model.ts:56-59` `ModelRecords`; `store.ts:44` `'schedule.jsonl': mk('schedule.jsonl', ['version', 'key'], ...` | OK |
| 3 | `queries.ts` `check`, `plan.ts` `build`, `doctor` | `check` `:194-216` (`const edges = (d.all('SELECT consumer,producer,kind FROM edge') ...).filter((e) => !skip.has(e.kind))` `:199`); `build` `plan.ts:194-199`; `doctor` `:253-281`, `doctorWarnings` `:327` | MOVED |
| 4 | `lib/ready.ts:1-2` header, `:38-67`, `:59`, `:64-65`, `:76-77` | header `:1-2` still reads "`plangraph ready` ..., `plangraph blockers` and `plangraph report` ... all call it"; `doneOf` `:38`; `readiness` `:46-68`; `:59` `if (!pt) continue; // a link to a ticket that is not in the plan`; `:64-65` WAITS pushes; `findingsOf` build `:76-77` | MOVED |
| 4 | `lib/model.ts:72-80` | `:72` `const skip = new Set<unknown>(config.ignore_link_kinds || []);` ... `:80` `for (const m of [prods, cons]) ...` | OK |
| 4 | `queries.ts:70-74` neighbors, `:87-101` chain, `:90`, `:199`, `:147-148`, `:294-299` | `MAX_DEPTH = 50` `:70`, `neighbors` `:71-83` (depth check `:74`), `chain` `:87-120` (skip `:88`, edge load `:90`, cycle error `:99`), `blockers` `:146-153` (`:148` SQL `SELECT key,verdict FROM ticket WHERE verdict<>'READY' AND verdict<>'' ORDER BY verdict,key`), reasons loop `:292-302` | MOVED |
| 4 | `src/mcp.ts:46` | `:46` tool `ticket` "Same text as `plangraph ticket KEY`." | OK |
| 5 | `queries.ts` `commands` map `394-406` | `:412-425` (`const B = { type: 'boolean' };` `:411`) | MOVED |
| 5 | `docs/TOKENS.md:76` explain 736 bytes | `:76` `| explain | 785 | 197 |` | CHANGED (value) |
| 5 | `test/golden.test.ts:91`; `test/skills-routing.test.ts:139`; `test/json-envelope.test.ts:66-69`; `test/hostile-fuzz.test.ts:167-170`; `test/mutation-kills-cli.test.ts:37-46` | `:91` explain case; `APPROVED_BRAIN` `:138`; `:66` `the shapes cover every registered command`; `:167` `every registered command has fuzz argument shapes ...`; `:37` `usage errors for every command: ...` | OK/MOVED |
| 5 | `lib/schema.ts:17-19` free-string keys | `:17-19` `tickets.jsonl`, `edges.jsonl`, `schedule.jsonl` validators | OK |
| 5 | `src/registry.ts` modify | not needed: registration is by `GROUPS` in `src/commands/index.ts`; `registry.ts` stays | CHANGED |
| 5 | `README.md` "Commands" | `README.md:359` `## Commands` | OK |
| 6 | `lib/whatif.ts` `:148, :153, :244, :389, :425, :473, :517, :579`; `:347-349, :525-526, :564-576` | `:148` `entry` (`cap: capOf(model.config, o)`); `:153` `const cap = capOf(model.config, owner);`; `:244` `cap = capOf(cfg, o);`; `:389` `const cfg = model.config || {}, cap = capOf(cfg, person), ...`; `:425`; `:473` `if (cur > capOf(cfg, to.owner)) continue;`; `:517`; `:579`; safety nets `:347`, `:525-526`, `:564-576` | OK (all identical) |
| 6 | other `capOf` callers (not in plan) | `lib/report.ts:49`, `lib/render.ts:100`, `lib/forecast.ts:277`, `src/commands/analysis.ts:59`, `queries.ts:126,127,134,203`, `lib/verify.ts:77` | keep `capOf` (not whatif/relieve) |
| 6 | `scripts/mutate.ts` pins on whatif capOf | `:93` and `:94` (verbatim `capOf(cfg, to.owner)` lines) | OK; re-pin after the change |
| 6 | `src/commands/plan.ts:54-58` whatif/relieve plumbing; `analysis.ts:21-28` forecast | `relieveCmd` `plan.ts:54`; `whatif` `:87-132` (`model = modelFromDb(ctx)` `:95`); `forecast` `analysis.ts:21-28` | OK/MOVED |
| 6A | `analysis.ts forecast`, `report.ts forecastTag` | `analysis.ts:21` `async function forecast(...)`, call `F.forecast({ history: H.records, actuals: A.rows, model, config: ctx.config(), seed: ... })` `:28`; `report.ts:16` `forecastTag(ctx, model)`, call `:21` | OK |
| 7 | `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `src/mcp.ts`, `src-core.json` version strings | `package.json:3`, `.claude-plugin/plugin.json:3`, `src/mcp.ts:16` `export const SERVER_VERSION = '0.3.0-dev';`, `test/golden/mutation-kills/src-core.json:344, :607, :621` (`.claude-plugin/marketplace.json` has no version) | OK |
| 7 | `PENDING_DECISIONS.md` D7, D10, D18; D23-D25 | D7 `:56`, D10 `:78`, D18 `:135` under "Open"; D22 is the only "Decided"; D23 to D25 are not recorded | CHANGED (Open item 7) |

No anchor of the plan is GONE. Mutation pins that quote moved or edited text and need re-pinning by the controller: `scripts/mutate.ts` `:52` (`'\\0-\\0\`); continue; }'`, the missing-file marker in `fingerprintOf`; Task 2 edits that function), `:53`, `:54`, `:68`, `:71` (`src/db.ts`), `:83`, `:85`, `:86` (`lib/ready.ts`), `:87`, `:88` (`queries.ts`), `:93`, `:94` (`lib/whatif.ts`), `:25-28` (`lib/store.ts`).

## 5. Task briefs (0.4.0)

Common to every task: the plan's Gate (`npm run bulletproof:check` exit 0; `node scripts/baseline.ts compare --only-common --a .baseline/pre-040 --b <capture>` prints `differing: 0`); commit subjects plain imperative, no trailer, bodies carry `Decision Dn: <answer>` (D7, D10, D18; D23, D24, D25 where listed); tests use `node:test`; any new `lib/graph/*` file is a mutation target (Task 1) and falls under the overall floor.

### Task 1: node and link files

- Create: `lib/graph/files.ts` (types `NodeType` as open string grammar with `CORE_NODE_TYPES`, extension regex `x-[a-z][a-z0-9-]{0,23}\.[a-z][a-z0-9-]{0,23}`; `RELATIONS` (hand-authored), `DERIVED_RELATIONS`, `V1_HOME`, `REL_SEMANTICS` may live here or in Task 4 (Open item 8), `parseGraphFile(name, text): readonly Rec[]`, `readGraphFiles(dir): GraphFiles`, `GraphDataErrorCode`), `test/graph-files.test.ts`, `test/mixed-version.test.ts`, `scripts/freeze-release.ts`, `test/fixtures/release-0.3.0/` (written by the script).
- Modify: `lib/store.ts` (`SCHEMAS` gains `people.jsonl` key `id`; `sprints.jsonl` key `n`; `epics.jsonl` key `id`; `repos.jsonl` key `id`; `capacity.jsonl` key `person`+`sprint`; `links.jsonl` set (id and sort = hash of the canonical record, as `FALLBACK`); `xrefs.jsonl` key `type`+`id`+`sys`+`xid`; the 0-to-1 migration at `:239` iterates a frozen list of the nine v1 names), `lib/schema.ts` (export what the graph validators need, or register `validators` entries calling `parseGraphFile` rules; `n`/`sprint` safe integers 0 and negatives allowed like `optInt`, `sp` non-negative, `active` boolean, `attrs` object, others strings), `src/commands/shared.ts` (new frozen `GRAPH_SRC_FILES`, 7 names, next to `SRC_FILES` `:27`, which is unchanged), `src/commands/queries.ts` (`cardLineText` `:348` loop hashes each `GRAPH_SRC_FILES` entry only when `presentDataFile`; `firstUseLine` unchanged), `docs/FORMAT.md` (section 1 key table `:5-28` plus index-table list; section 4 merge rule `:56`; section 6 `:73`), `scripts/mutate-all.ts:36`, `tsconfig.json`, `knip.json`, `biome.json` (frozen fixture excluded), `test/tsconfig.test.ts`, `test/store.test.ts`, `test/mutation-kills-store.test.ts`, `test/golden/mutation-kills/store.json` (controller), and the spec text (nodes keyed per file, no `type` field).
- Consumes: `canonFile`, `canonLine`, `schemaFor`, `parseJsonl`, `presentDataFile`, `mergeJsonl` (via `bin/plangraph-merge`, key from basename).
- Amendment delta: add `repos.jsonl` row schema of 3.10 (`id`, `name`, `role` in `service|lib|app|infra|docs|monorepo`, `langs`, `pm`, `runtime`, `frameworks`, `cmds{build,test,lint}`, `entry`, `deploy`, `owners`, `paths[{glob,sub}]`, `src` in `scan|manual|catalog`, `fp`, `scanned_at`, `scanner`; arrays that are sets declared in `sets`, so canonical order is sorted); `xrefs.jsonl` row `{type,id,sys,xid,src?,seen?,note?}` with the `sys` grammar of 3.2 and the generic `xid` rule `[A-Za-z0-9._:/#@ -]{1,200}`, no `..`, no URLs, no account ids or emails (D24); id rule (200 chars, no C0/C1/bidi/line breaks) as warning for old values, error for the new-row path in `repo scan`; `capacity.jsonl` accepts optional non-negative `review_h`, preserved, never read; no `plantasks.jsonl` (Open item 3); unknown `x-` types, relations and `sys` accepted and counted, never an error; plan task id `<plan>#<task>` is never parsed.
- Tests (fail first): `test/graph-files.test.ts` per-file shape errors with `<file>:<line>: "<field>" must be ...`; `LINK_UNKNOWN_REL` only for a non-`x-` unknown relation; `LINK_DERIVED_REL` naming `V1_HOME` for every derived relation (one case each); dates `YYYY-MM-DD`, `start <= end`; `DUPLICATE_NODE` naming file and id; merge by key with 200 fuzz cases per node file incl. `repos` and `xrefs`, set merge for `links`; legacy 0-to-1 migration unchanged with a `people.jsonl` present; card line of a v1-only directory equals the frozen 0.3.0 card line (a present `people.jsonl` changes only the digest); amendment risk test: an `x-github.pr` node, `x-github/closes` link and unknown xref `sys` parse. `test/mixed-version.test.ts` as plan Step 2 plus xrefs: frozen 0.3.0 `bin/plangraph-merge` keeps the record set when one side edits; a two-sided edit of one xref gives two rows on 0.3.0 (recorded limit) and one row on the 0.4.0 driver.
- Prerequisite: the frozen 0.3.0 tree (`git archive` of a tag or commit) does not exist yet (Open item 1).

### Task 1A: `lib/graph/uri.ts`

- Create: `lib/graph/uri.ts` (`nodeUri(type, id): string`, `parseNodeUri(uri): { type; id } | null`; form `pg:<type>/<pct(id)>`; percent-encode `%`, `/`, `#`, `|`, `?`, space, controls, non-ASCII (UTF-8); single-pass decode; reject a value that does not re-encode to the input), `test/graph-uri.test.ts`. Pure, no I/O, no consumers yet except Task 5.
- Consumes: `NodeType` grammar of Task 1 (type import only).
- Tests: examples of 3.1 (`pg:person/Ana%20Silva`, `pg:plantask/docs%2Fp.md%23Task%203`); round trip fuzz over random strings incl. `%2e%2e`, double encoding, lone surrogates, 200-char ids; `%2e%2e` and `%252f` refused; type grammar enforced (core or `x-<sys>.<kind>`).

### Task 1B: `plangraph repo scan [--check]`

- Create: `lib/graph/repo.ts` (pure: manifest, tool-version, CODEOWNERS, Dockerfile and CI-name parsers to a canonical `repos.jsonl` row; CODEOWNERS last match wins, no negation), `src/commands/repo.ts` (command `repo`, positionals `[0, 2]` for `scan` and a path, options `all`, `check`; `writes: 'text'`, `guard: 'strict'`), `test/graph-repo.test.ts`, `test/repo-scan-command.test.ts`, fixtures under `test/fixtures/repo-scan/`.
- Modify: `src/commands/index.ts` (add the group; also `GROUPS` freeze list), `docs/FORMAT.md` (repos row, owned by Task 1: Task 1B edits only a new `docs/REPO.md` or the CLI docs, not FORMAT.md), `test/json-envelope.test.ts` and `test/hostile-fuzz.test.ts` `SHAPES` (a `repo` entry each: the registry-coverage tests fail otherwise), `test/golden/explain.txt` (controller), `test/golden/mutation-kills/cli.json` (controller), `test/skills-routing.test.ts` (not read-only: `repo` stays off every `allowed-tools`).
- Consumes: `makeGit(root)` (`lib/gitsafe.ts:14`, `git` argv only), `assertInside`, `writeAtomicSafe`/`writeState`/`precheckTargets` (`src/commands/shared.ts`), `canonFile(rows, SCHEMAS['repos.jsonl'])`, `readRecords`.
- Amendment delta (3.10): allowlisted files only, 256 KB cap each, from git blobs when possible, no subprocess except `git`, no symlink out of the repo; `fp` = SHA-256 of sorted `(path, blob sha)`; hand-written fields (`role`, `owners` edits, `paths`) survive a rescan, scanned fields overwritten and tagged `src: scan`; scanned text is data, only allowlisted tokens reach a row; `touches` hand-authored through `links.jsonl` (Open item 9). 0.5.0 items (GitHub linking, `touches` heuristic, `paths` auto-detect, catalog seed) are out.
- Tests (10 from 3.10): hostile manifest/CODEOWNERS text never reaches a row or any output; a planted `postinstall`/Makefile runs nothing (assert only `git` is spawned); two scans on different paths are byte-identical; changing a script or dependency fails `--check`, changing only a README does not; CODEOWNERS last match, no negation, unresolvable owners dropped, oversized file refused; one alias with three repos and one repo with two aliases collide nowhere; a repo rename keeps ids and `touches` edges; two branches adding different repo nodes merge cleanly with canonical array order; `touches`/`depends_on` to a deleted repo id reported by `verify` is a 0.5.0 item (the 0.4.0 form is `LINK_MISSING_NODE`).

### Task 2: index tables and views over v1 and v2 data

- Create: `lib/graph/views.ts` (view DDL constants, `reach`, `graphReader`, `BlockerSource`, `GraphReader`, `NodeRef`, `GRAPH_MAX_DEPTH = 20`), `test/graph-views.test.ts`, `test/graph-views-timing.test.ts`.
- Modify: `src/db.ts` (`DEFS` gains `person` `['id']`, `sprint` `['n']` with INTEGER `n`, `epic` `['id']`, `repo` `['id']`, `capacity` `['person','sprint']` with INTEGER `sprint`,`sp`, `link` (no key), `xref` `['type','id','sys','xid']`; `PREP`/`PREPPED` store `person.active`, `link.attrs`, and the array/object columns of `repo` as canonical JSON text; double-quote every column in `ddl`, `columnList`, `order` and the `json_array`; `sourceFingerprint`/`readSources` hash a graph file only when present (the `fingerprintOf` marker for a missing v1 file `:164` stays); `schemaOk` accepts exactly the two views `g_nodes(id, type)` and `g_links(src, src_type, rel, dst, dst_type, version, kind)` with byte-equal `sql`; `openIndex` recognises the exact 0.3.0 schema (eight v1 tables, `index_meta`, `edge_p`, `ev_k`, no view): content digest over the 0.3.0 table list, then `stale = true` and `query_only`; writers (`readOnly: false`, `stampFingerprint`) refuse it with `PlangraphError('STALE', ...)`), `bin/plangraph-solve` (`INDEX_TABLES` gains the new tables in `TABLES` order; `schema_ok` allows the two views with byte-equal SQL, still refuses any other view or trigger; `content_digest` covers the new tables with quoted columns; an exact 0.3.0 schema is refused with `the index was built by an older plangraph: run \`plangraph build\``), `test/plangraph-solve-input.test.ts`, `test/index-integrity.test.ts` (`EDITS` one UPDATE per new table; the `link` one on `"from"`), `test/build-extra.test.ts` (`:146`, `:164`), `docs/SOLVER.md:275`, `docs/CONTRACT.md:178` (eight text files -> the actual count) and `:184-195`, `docs/FORMAT.md` (index-table list, only if Task 1 left it).
- Consumes: `SCHEMAS[file].order` (`src/db.ts:67`), `validators`, `readItems` (open items stay out of the index), `PlangraphError`, `IndexHandle.all/get`.
- Amendment delta: add `xref` and `repo` tables and no `plantask` table; derived `plan` and `doc` nodes (`plan` from every `ref.plans` object entry with a string `plan`; `doc` from `refs.files` keys of rows whose ticket key is an `sp:<slug>` epic; plan task from entries with string `plan` and `task`); derived relations in `g_links`: `part_of` (plantask to plan; sub-unit `repo:<slug>#<sub>` to repo from `repo.paths`), `specified_by` (plan to doc; see Open item 10), `tracked_by` (from `xref`), `owned_by` (repo to person from `repo.owners`), plus the six of the plan; `x-` types and relations pass through `link` rows; `obs` table is 0.5.0 (the Python mirror accepts `xref` now and `obs` later); `docs/CONTRACT.md` fix in this task.
- Tests: the plan's list, minus the `plantask` cases, plus: `xref` and `repo` tables build with keyword and JSON columns and the digest verifies after `open`; `an x-github.pr node and an x-github/closes link build, v1 answers byte-identical`; fingerprint of a v1-only directory equals the frozen 0.3.0 value (`fresh.fp`); a 0.3.0-built index opens stale for v1-only commands and the `g_*` readers exit 2 `STALE` `try: plangraph build`; planted `g_links` body, extra view and trigger refused (CLI and solver); solver input digest identical with and without graph files; timing ratio 100000 vs 10000 tickets at most 12 (`PLANGRAPH_PERF_FACTOR`).
- Needs python3 for the solver cases (skipped without it, `:23`).

### Task 3: integrity in build, check, doctor

- Create: `lib/graph/integrity.ts` (`integrity(files, v1, items): IntegrityViolation[]`), `test/graph-integrity.test.ts`.
- Modify: `src/commands/plan.ts` (`build` `:194`: print violations on stderr, exit 0; `doctor` `:253`: catch `DUPLICATE_NODE`, print fix line, print the integrity count and `plangraph check` only when above 0, capacity warning, `ext ignored N`), `src/commands/queries.ts` (`check` `:194`: exit 1 on an error-class violation), `scripts/baseline.ts` (`integrity-*` probes, owned by this task until Task 5).
- Consumes: `readGraphFiles` (Task 1), `readItems(ctx)` for `key|kind` endpoints, `modelFromDb`.
- Amendment delta: codes `XREF_DUPLICATE` (error: one `sys`+`xid` on two nodes of a type), `XREF_MISSING_NODE` (error), `XREF_BAD_ID` (a parse error from `parseGraphFile`, not from `integrity()`), warning `DOUBLE_PLACED_WORK` (an `sp:` ticket and the Jira ticket it tracks are both placed; hint text must not name `sp-link --track`, a 0.5.0 command: Open item 11); doctor prints `ext ignored N` for accepted `x-` rows; unchanged: `LINK_MISSING_NODE`, `UNDATED_SPRINT`, no cycle code, exit 1 never for a warning alone.
- Tests: the plan's list plus one fixture and exact message line per new code; `XREF_BAD_ID` through `build` exit 2; v1-only directory has no new output; `doctor` unchanged without graph files (golden `test/golden/doctor*.txt` stay).

### Task 4: one blocker definition; commands on the views

- Create: `lib/graph/blockers.ts` (`blockersOf`, `BlockerReason`, `modelSource`, re-export `BlockerSource`; `REL_SEMANTICS` frozen, Open item 8), `test/blockers-one.test.ts`, `test/blockers-one-timing.test.ts`.
- Modify: `lib/ready.ts` (`readiness` `:46` delegates; `ReadyOpts` gains `source?: BlockerSource`; `readySet` `:75` builds the source once; header `:1-2` stops naming `plangraph blockers`), `src/commands/queries.ts` (`ticket` `:29`, `person` `:139`, `sprint` `:122` on `reach`; `neighbors` `:71` and `chain` `:87` read `needs` rows of `g_links` incl. `kind`; `blockers` `:146` unchanged), `scripts/mutate.ts` pins (controller).
- Consumes: `graphReader(db, items)`, `reach` (Task 2); `closedSet`, `blockingItems`; `doneOf`, `closedStatuses`; `Reason` mapping (`VERDICT`, `OPEN_ITEM from finding|item`, `WAITS`).
- Amendment delta: `blockersOf` reads only gate (`held_by`, verdict, finding) and order (`needs`) relations: `REL_SEMANTICS` test proves no `trace`, `identity`, `info`, `group`, `x-*` relation or `repo` edge changes any `blockersOf` or `capacityFor` answer (property test); `openitem` nodes visible through `graphReader.node` (Open item 4); `ticket` output unchanged (no xref text added).
- Tests: the plan's list (equality with `readiness` on every fixture and rule, `blockers` output equals frozen 0.3.0, `neighbors` depth 0/21/50, 25-hop `chain`, MCP `ticket` text, cycle error, `person`/`sprint` with versions, source built once, linear scaling) plus the `REL_SEMANTICS` property test and an `x-github/closes` link that blocks nothing.

### Task 5: `plangraph graph`

- Create: `src/commands/graph.ts`, `test/graph-command.test.ts`, `test/golden/graph-*.txt`.
- Modify: `src/commands/index.ts` (add `graph` group), `scripts/baseline.ts` (`graph-*` probes), `docs/TOKENS.md` (`:76` explain row, regenerate with `node test/bench-tokens.ts`, keep the 400-token bound), `README.md:359` Commands, `test/golden/explain.txt`, `skills/plangraph/SKILL.md` (`allowed-tools` gains `Bash(plangraph graph:*)`, command table line), `test/skills-routing.test.ts:138`, `test/json-envelope.test.ts:53` `SHAPES`, `test/hostile-fuzz.test.ts:114` `SHAPES`, `test/golden/mutation-kills/cli.json` (controller). `src/registry.ts` is not modified.
- Consumes: `graphReader`, `reach`, `GRAPH_MAX_DEPTH`, `parseNodeUri`/`nodeUri` (Task 1A), `fencedList`, `fenceBlock`, `oneLine`, `usage`, `ctx.db()` (STALE behavior), `readItems`.
- Amendment delta: `graph KEY` accepts a `pg:` URI as well as a raw id (a URI that is not in grammar exits 2); `--json` ids are in `pg:` form; xrefs print fenced as `<untrusted src="<sys>">`; default output under 250 tokens, truncated output carries `truncated N, narrow with --rel or --depth` (3.12 item 12); `--type openitem` works with `'K|kind'`; `--rel` accepts the extended relation set and `x-<sys>/<rel>`; `--type` accepts `x-<sys>.<kind>`.
- Tests: the plan's list plus a `pg:` URI and a `%2e%2e` refusal, `--json` ids in URI form, output cap and truncation line, fenced xref text, `--type openitem`, `--type repo` with `part_of`/`owned_by`.

### Task 6: capacity rows

- Create: `lib/capacity.ts` (`capacityFor(person, sprint, rows, config): number` = `Math.min(row.sp, capOf(config, person))` when a row exists), `test/capacity.test.ts`.
- Modify: `lib/whatif.ts` (replace the whatif and relieve `capOf` sites listed in section 4, `:148`, `:153`, `:244`, `:389`, `:425`, `:473`, `:517`, `:579`; leave the `verifyPlan` safety nets), `lib/model.ts` (`Model` and `ModelRecords` gain `capacity?: readonly CapacityRow[]`, default empty, `buildModel` `:71`), `src/commands/shared.ts` (`modelFromDb` `:103` reads the `capacity` table), `src/commands/plan.ts` (only the plumbing at `:54-58`/`:95` if any argument changes; the model already carries the rows), `scripts/mutate.ts` pins `:93`, `:94` (controller).
- Consumes: `CapacityRow` from `lib/graph/files.ts`; `capOf` unchanged; `capacity` index table (Task 2).
- Amendment delta: none in code; `review_h` is carried and ignored; the advisory line text for a row above config is unchanged.
- Tests: the plan's nine; `lib/verify.ts` imports nothing from `lib/capacity.ts`; `capOf` untouched; a `capacity` row never changes `plangraph verify`, `check`, the solver (`capOf` stays in `lib/verify.ts:77`, `lib/report.ts:49`, `lib/render.ts:100`, `lib/forecast.ts:277`, `analysis.ts:59`).

### Task 6A: forecast calendar when sprints are dated

- Create: `test/forecast-calendar.test.ts`. Modify: `lib/forecast.ts` (new optional input `sprints`), `docs/FORECAST.md`, `src/commands/analysis.ts` (`forecast` `:21`, rows from the index table `sprint` via `ctx.db()`), `src/commands/report.ts` (`forecastTag` `:16`).
- Consumes: `sprint` table (Task 2); `F.forecast({ history, actuals, model, config, seed })` signature. Amendment delta: none. Tests: as plan (all dated: calendar end date; one undated: byte-identical to 0.3.0; none: byte-identical; `report` tag agrees).

### Task 7: audit and release 0.4.0

- Create: `docs/audit/0.4.0-audit.md`. Modify: `CHANGELOG.md` (`## [0.4.0]` below an empty `## [Unreleased]`), `package.json:3`, `package-lock.json`, `.claude-plugin/plugin.json:3`, `src/mcp.ts:16`, `test/golden/mutation-kills/src-core.json` (`:344`, `:607`, `:621`), `KNOWN_ISSUES.md`, `PENDING_DECISIONS.md` (controller).
- Amendment delta: audit adds the forward-compatibility fixture of section 6 (frozen 0.4.0 tree builds a directory with `x-github.pr` nodes, `x-github/closes` links, an unknown xref `sys`: exit 0, v1 answers byte-identical), the xref merge limit on 0.3.0, hostile-input fuzz for every new file and for `repo scan`, a start-up and size measurement against the frozen tree (hand, recorded), and records D23, D24, D25 (Open item 7). CHANGELOG says "upgrade every team member to 0.4.0 before anyone commits node files".

### Task 7B: format benchmark `evals/graph-format/`

- Create only: `evals/graph-format/` (question set of 100 to 200 over a fixed synthetic plan with SQL/solver ground truth, runner, report with Wilson intervals, token and tool-call counts, golden-query retrieval check, per-answer token budget test), `test/graph-format.test.ts` (offline: question set integrity and ground-truth recomputation; no model call in CI). No edit of `src/` files. Consumes `plangraph graph` (Task 5), `ready`, `ticket`, the index. Output: a ruling on the default answer format; any change to `src/commands/graph.ts` is a follow-up commit by Task 5's owner after 7B reports (the amendment sets the format "from its result before 0.4.0 ships").

### Task 7C: differential tests

- Create only: `test/differential/` (`rules-oracle.test.ts`, `whatif-oracle.test.ts`, `solver-oracle.test.ts`) and a small brute-force oracle helper under `test/helpers/oracle.ts`. Consumes `verifyPlan`, `whatif`, `proposeMove`, `readySet`, `capacityFor`, `bin/plangraph-solve` (python3 gated), `genPlan` (`test/fixtures/gen.ts`), seeded `rng`. Tests: small random instances (at most 6 tickets, 3 people, 4 sprints) enumerate all schedules; rules and `whatif` accept exactly what the oracle accepts; the solver's end sprint equals the brute-force optimum; each rule keeps its hand-written cases.

## 6. Order, dependencies, parallel waves and file ownership

Dependencies: 1 -> {1A, 2}; 2 -> {3, 1B}; 3 -> 4 (4 needs the graph tables and `LINK_*` readers, and `openitem` in the reader); 4 -> 5; 4 -> 6 (6 needs the `capacity` table from 2 and the model, not Task 4 code; kept after 4 so `queries.ts` has one writer at a time); {5, 6} -> 6A; {5, 6, 6A} -> {7B, 7C}; all -> 7. Task 2A and Task 8 are not in 0.4.0.

| Wave | Tasks | Runs |
|---|---|---|
| A | 1 | alone (touches `lib/store.ts`, `lib/schema.ts`, `shared.ts`, `queries.ts`, docs, tool configs) |
| B | 1A, 2 | parallel |
| C | 3, 1B | parallel |
| D | 4 | alone |
| E | 5, 6 | parallel (as the plan); the controller then adds `capacity-*` probes to `scripts/baseline.ts` and captures `.baseline/post-G5+6` |
| F | 6A | after E (shared Gate) |
| G | 7B, 7C | parallel |
| H | 7 | alone, after the controller has decided the 7B ruling |

File ownership inside each parallel wave (no overlap; a file not listed is owned by no task in that wave):

| Wave | Task | Owns (create or modify) |
|---|---|---|
| B | 1A | `lib/graph/uri.ts`, `test/graph-uri.test.ts` |
| B | 2 | `lib/graph/views.ts`, `src/db.ts`, `bin/plangraph-solve`, `docs/SOLVER.md`, `docs/CONTRACT.md`, `test/graph-views*.test.ts`, `test/plangraph-solve-input.test.ts`, `test/index-integrity.test.ts`, `test/build-extra.test.ts` |
| C | 3 | `lib/graph/integrity.ts`, `src/commands/plan.ts` (`build`, `doctor`), `src/commands/queries.ts` (`check`), `scripts/baseline.ts`, `test/graph-integrity.test.ts` |
| C | 1B | `lib/graph/repo.ts`, `src/commands/repo.ts`, `src/commands/index.ts`, `test/graph-repo.test.ts`, `test/repo-scan-command.test.ts`, `test/fixtures/repo-scan/**`, the `repo` entries in `test/json-envelope.test.ts` and `test/hostile-fuzz.test.ts` |
| E | 5 | `src/commands/graph.ts`, `src/commands/index.ts`, `scripts/baseline.ts`, `test/graph-command.test.ts`, `test/golden/graph-*.txt`, `docs/TOKENS.md`, `README.md`, `test/golden/explain.txt`, `skills/plangraph/SKILL.md`, `test/skills-routing.test.ts`, the `graph` entries in `test/json-envelope.test.ts` and `test/hostile-fuzz.test.ts` |
| E | 6 | `lib/capacity.ts`, `lib/whatif.ts`, `lib/model.ts`, `src/commands/shared.ts` (`modelFromDb` only), `src/commands/plan.ts` (whatif/relieve plumbing only), `test/capacity.test.ts` |
| G | 7B | `evals/graph-format/**`, `test/graph-format.test.ts` |
| G | 7C | `test/differential/**`, `test/helpers/oracle.ts` |

Notes: `test/json-envelope.test.ts` and `test/hostile-fuzz.test.ts` are edited by 1B (wave C) and by 5 (wave E), never in the same wave. Controller-applied files (`scripts/mutate.ts` pins, `test/golden/mutation-kills/*.json`, `PENDING_DECISIONS.md`, `KNOWN_ISSUES.md`) are never in an implementer's set.

## 7. Gate and baseline facts

`scripts/baseline.ts` exists (`capture`, `compare [--only-common]`, `bench`); `compare` maps the A side (old names) to the new names (`normalizeOutput(..., { oldNames })`, `:404`), so a capture from a pre-rename tree still compares, but `pre-040` must be captured on the renamed 0.3.0 tree plus the `0.4.0-dev` version bump (amendment 4.1, risk row "Rename collision": Task 0 asserts it). `.baseline/` is absent here and git-ignored status was not verified; the controller captures it. Deliberate differing ids by task: Task 5 the `explain` probes (`graph`, and `repo` from 1B); Task 7 the version probes (MCP `initialize` result `src/mcp.ts:144`).

## 8. Per-task risks found while re-quoting

- `src/commands/plan.ts` `exportText` (`:165-192`) uses a fixed `EXPORT` list of six tables, so the new tables are never exported: leave `EXPORT` alone (graph files are hand-authored). `stampFingerprint` after `export` hashes graph files only when present.
- `build` prints one summary line (`plan.ts:197`); Task 3 adds stderr lines only, so `test/golden/build*.txt` stays.
- `doctor` golden files (`test/golden/doctor*.txt`) must not change for a v1-only directory.
- `lib/schema.ts` helpers are not exported (Task 1 must export or duplicate).
- No `lint:py` or ruff script exists in `package.json` (Open item 12).

## 9. Open items

1. The plan's Task 1 Step 1 freezes the `v0.3.0` tag, and the mixed-version, "equals the frozen 0.3.0 tree" and `fresh.fp` tests need it. This tree has no tags and reports `0.3.0-dev`. Recommended: Task 1 does not start until the controller creates the release commit (or tag) of 0.3.0; `scripts/freeze-release.ts` takes any tree-ish (`git archive <rev>`), so the fixture directory keeps the name `release-0.3.0`.
2. `.baseline/pre-040` does not exist and must come from the renamed 0.3.0 tree (amendment 4.1). Recommended: capture it in the same controller step as Open item 1.
3. The amendment's table says "`GRAPH_SRC_FILES` 6 to 7", but adding `repos` and `xrefs` to the plan's six gives eight; item 9 of 3.14 drops `plantasks.jsonl`, giving seven. Recommended: seven files (people, sprints, epics, repos, capacity, links, xrefs); no `plantask` table, `PlanTaskRow` or `plantasks.jsonl`; plan tasks are derived from `refs.plans` entries with a string `plan` and `task` (id `<plan>#<task>`, never parsed).
4. Amendment 4.4 puts `openitem` in `g_nodes`, but `open-items.jsonl` is deliberately not indexed (`DEFS` has no row; indexing it would leave the index stale after every `open-items --close`). Recommended: `g_nodes` stays an SQL view over indexed data; `graphReader.node()` and `reach` add open-item nodes and `held_by` edges in TypeScript from `readItems`, so `plangraph graph 'K|kind' --type openitem` works and no index change is needed; the Python mirror is unaffected.
5. Task 2A (read/write format-2 directories) and Task 8 migration are not in the amendment's 0.4.0 scope, and D23 removes every format bump before 1.0.0. Recommended: drop Task 2A (no release writes `format_version` 2, `checkFormat` already has a read mode, `init` keeps `min_reader: FORMAT_VERSION` at `plan.ts:236`); keep `docs/FORMAT.md` section 2 as is until the contract release.
6. The plan edits `biome.jsonc` and `knip.jsonc`; this tree still has `biome.json` and `knip.json`, and `tsconfig.json` has no `exclude`. Recommended: the frozen fixture is excluded in the files that exist under their current names; a later rename of those files carries the exclusion along.
7. Decisions D23, D24, D25 exist only in the amendment; `PENDING_DECISIONS.md` lists D1 to D21 as open and D22 as decided. Recommended: the controller records D23 to D25 (answers as written in the amendment) before the commit that cites them.
8. Where `REL_SEMANTICS` lives (amendment 3.1 freezes it; the task table puts it in Task 4). Recommended: declared in `lib/graph/files.ts` (Task 1, next to the relation lists, so Task 2 and 3 can read it) and asserted by Task 4's test.
9. Relations of 3.10 versus the closed relation set: `depends_on` and `touches` are not derivable in 0.4.0 (the `repos.jsonl` row has no dependency or published-name field; cross-repo edges from package names are listed under "Later"), `part_of (repo to system)` has no `system` type, and `RELATIONS` is `['relates_to']` per D18. Recommended: `RELATIONS` = `relates_to`, `depends_on`, `touches` (hand-authored in `links.jsonl`, `attrs` carries `conf` and `why` for `touches`); derived = the plan's six plus `part_of` (plantask to plan; sub-unit to repo; no repo-to-system edge), `specified_by`, `tracked_by`, `owned_by`; `REL_SEMANTICS`: `touches: trace`, `depends_on: info`, `owned_by: info`, `tracked_in` not shipped; D18's recorded answer is widened accordingly.
10. `specified_by` (plan to doc) is not derivable from the epic's `refs` row alone: `sp-ingest` writes the spec into the epic row's `files` with `plans: []` (`superpowers.ts:559`), and the plan path lives on the task rows. Recommended: derive plan P of an epic E from the tickets whose `epic = E` and whose `refs.plans` hold P, and the doc from `refs.files` keys of the row whose ticket key is E; an epic with no task row has no `specified_by` edge.
11. `DOUBLE_PLACED_WORK` (Task 3, 0.4.0) refers to `sp-link --track`, which is Task 13 of 0.5.0, and the implicit default Jira alias of 3.2 has no source in this tree (`config.json` has only `jira: { base_url, jql }`). Recommended: in 0.4.0 the warning fires only on explicit `xrefs.jsonl` rows (`tracked_by`) and its fix line says "keep one of the two placed", naming no future command; implicit references stay documentation until the 0.5.0 import.
12. Task 2 requires `npm run lint:py` at zero findings, but `package.json` has no `lint:py` script (0.3.0 Task 15 is not in this tree). Recommended: Task 2 keeps the existing Python style, runs `python3 -m py_compile bin/plangraph-solve` and its tests, and applies the ruff gate only if that script exists when the task starts.

## 9. Controller rulings on the open items (2026-11-26; binding)

1. No `v0.3.0` tag exists until the 0.3.0 release merges. Task 1 and every mixed-version test start from the 0.3.0 release commit (the squash commit on `main`); the freeze script takes that revision. Graph work does not start before it.
2. `.baseline/pre-040` is captured from that same release tree in the same controller step.
3. Seven graph files after 0.4.0: people, sprints, epics, repos, capacity, links, xrefs (no `plantasks.jsonl`). `GRAPH_SRC_FILES` follows that list; the amendment's "6 to 7" is read as "seven files".
4. `g_nodes` stays a view over indexed data; open-item nodes and `held_by` edges are added in `graphReader` in TypeScript.
5. Task 2A is dropped (`checkFormat` already has a read mode). Old Task 8 becomes `plangraph graph materialize` (0.5.0, no format bump) per the amendment.
6. Use the current config file names (`biome.json`, `knip.json`) when excluding the frozen fixture.
7. D23, D24 and D25 are recorded in `PENDING_DECISIONS.md` before any commit cites them.
8. `REL_SEMANTICS` is declared in `lib/graph/files.ts`; Task 4 asserts it and the reader rule.
9. Relations: hand-authored (stored in `links.jsonl`) = `relates_to`, `depends_on`, `touches`; derived = `needs`, `assigned_to`, `scheduled_in`, `belongs_to`, `implements`, `held_by`, `part_of`, `specified_by`, `tracked_by`, `owned_by`. The repo-to-system edge is dropped (no `system` type). Decision D18's recorded answer is widened accordingly.
10. `specified_by` is derived from the epic's task rows (plan) and the epic row's `files` (doc); `plans: []` in the epic row is not a source.
11. `DOUBLE_PLACED_WORK` fires in 0.4.0 only on explicit `xrefs.jsonl` rows; its fix line names no future command.
12. Task 2 uses `python3 -m py_compile` plus the solver tests; ruff only if a `lint:py` script exists when it starts.
