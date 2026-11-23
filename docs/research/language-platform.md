# plangraph: language and platform research and code audit

Date: 2026-11-22. Machine: Node v24.18.0 (V8 13.6, ICU 78.3, undici 7.28, SQLite 3.53.1), macOS.
Scope: bin/brain (547 lines), bin/brain-merge, lib/*.mjs, docs/CONTRACT.md, package.json. No code was edited.
Tags: VERIFIED-locally (ran on this machine), VERIFIED-docs (primary source fetched: nodejs.org, tc39/proposals), UNVERIFIED (secondary sources only or not tested).
Baseline: `node --test test/*.test.mjs` = 223 pass, 0 fail, 41 s.

## 0. Executive summary

1. The code is already modern ESM with zero CommonJS and zero runtime dependencies. The remaining gains are safety fixes and structure, not syntax.
2. Three real security defects were found and reproduced locally (section 5.1): git option injection through `--ref`/config, SQL identifier injection from JSONL column names in `build()`, and `brain constructor` running a prototype method and exiting 0. Fix these first.
3. Type safety: JSDoc plus `tsc --noEmit --checkJs` (TypeScript 7.0.2, the native compiler, runs in about a second) is the best fit. Today `checkJs` non-strict reports 60 errors; strict reports about 1,000 (mostly missing parameter types). Staged adoption plan in section 3.
4. Performance is already good: `brain` costs about 12 ms above bare `node -e 0`; compile cache saves only about 3 ms. The only real hot spot is `build()` preparing one SQLite statement per row (599 ms vs 190 ms at 100k rows). Streaming JSONL is slower than the current sync read and not worth it.
5. Dev tooling: add `typescript` and `@biomejs/biome` as devDependencies only. Zero runtime deps stays true.

## 1. Language features (ES2024 to ES2026+), availability on Node 24

Source for status: tc39/proposals finished-proposals.md (VERIFIED-docs, fetched 2026-11-22).

| Feature | ES edition | Node 24.18 | Tag | Use here |
|---|---|---|---|---|
| Set methods (union, isSubsetOf ...) | 2025 | yes | VERIFIED-locally | `lib/whatif.ts`, `stale.mjs`, `openitems.mjs` set algebra |
| Iterator helpers (map/filter/take/toArray ...) | 2025 | yes | VERIFIED-locally | replace `[...x].filter().map()` chains, lazy `take(limit)` |
| Object.groupBy / Map.groupBy | 2024 | yes | VERIFIED-locally | replace Map-of-arrays builders (bin/brain 175, 214-215; compact.mjs 27; model.mjs 14-19) |
| toSorted / toSpliced / with / findLast | 2023 | yes | VERIFIED-locally | `[...a].sort()` copies become `a.toSorted()` |
| Promise.withResolvers, Promise.try | 2024 / 2025 | yes | VERIFIED-locally | `jira.mjs` sleep and exec wrappers |
| RegExp.escape | 2025 | yes | VERIFIED-locally | replaces the hand-written escape in bin/brain 258 and stale.mjs 29 |
| RegExp v flag, modifiers `(?i:)`, duplicate named groups | 2024/2025 | yes | VERIFIED-locally | optional |
| Error cause, AggregateError | 2022 | yes | VERIFIED-locally | typed errors (5.4) |
| Array.fromAsync | 2026 | yes | VERIFIED-locally | async collection of readLines |
| Import attributes / JSON modules | 2025 | parses | VERIFIED-locally | `import pkg from '../package.json' with { type: 'json' }` for a version string |
| Top-level await | 2022 | yes (already used in bin/brain 546-547) | VERIFIED-locally | |
| Float16Array, Math.f16round | 2025 | yes | VERIFIED-locally | not useful |
| JSON.rawJSON / JSON.parse source text access | 2026 | yes | VERIFIED-locally | not needed |
| Error.isError | 2026 | yes | VERIFIED-locally | cross-realm safe `instanceof Error` |
| Explicit resource management (`using`, `await using`, DisposableStack, SuppressedError, Symbol.dispose) | 2027 expected | yes, runs | VERIFIED-locally | `DatabaseSync` and `fs.mkdtempDisposableSync` are disposable (verified: db closed and temp dir removed at scope end) |
| Math.sumPrecise | 2026 | NOT in 24.18 | VERIFIED-locally (typeof undefined) | not needed |
| Uint8Array toBase64/fromBase64/toHex/fromHex | 2026 | NOT in 24.18 | VERIFIED-locally | use `Buffer` (already) |
| Iterator.concat | 2026 | NOT in 24.18 | VERIFIED-locally; arrives with V8 14.6 in Node 26 (VERIFIED-docs) | |
| Map/WeakMap getOrInsert, getOrInsertComputed (Upsert) | 2026 | NOT in 24.18 | VERIFIED-locally; Node 26 (VERIFIED-docs) | would replace the `if (!m.has(k)) m.set(k, [])` idiom, 14+ places |
| Temporal | 2027 expected | NOT in 24.18 (needs `--harmony-temporal`, experimental) | VERIFIED-locally; enabled by default in Node 26 (VERIFIED-docs) | none: brain uses epoch ms and ISO strings; `new Date().toISOString()` is enough |
| Iterator.zip, joint iteration | 2027 | no | VERIFIED-locally | |
| Atomics.waitAsync | 2024 | yes | VERIFIED-locally | |
| WeakRef / FinalizationRegistry | 2021 | yes | VERIFIED-locally | no use, avoid |
| structuredClone | web | yes | VERIFIED-locally | already used in store.mjs 42 |

Release lines (VERIFIED-docs, nodejs/Release schedule.json): v24 LTS since 2025-10-28, maintenance from 2026-10-20, end of life 2028-04-30. v26 (V8 14.6, Temporal on, undici 8, `--experimental-transform-types` removed) became LTS 2026-10-28, EOL 2029-04-30. v22 EOL 2027-04-30.

Decision for `engines`: keep `>=24` (24.12+ is needed for stable type stripping if option (b) is ever used). Write code that also runs on 26 without change. Do not adopt Upsert or Iterator.concat until the floor is 26 (about 2027-04, when 24 leaves active support is irrelevant; the real trigger is dropping 24 at its EOL 2028-04). Note docs/CONTRACT.md says `Node >= 22.13` while package.json and bin/brain say `>=24`: reconcile (the doctor command in bin/brain 504 also still says 22.13).

## 2. Node platform (24.x, verified)

| Capability | Status in 24.18 | Tag | Relevance |
|---|---|---|---|
| node:sqlite | Stability 1.2 release candidate since 24.15; no flag; no warning printed when imported (tested); `DatabaseSync` only, no `Database` export (exports: DatabaseSync, StatementSync, Session, constants, backup). SQLite 3.53.1. `defensive` on by default since 24.14. Methods: exec, prepare, function, aggregate, createTagStore, serialize/deserialize, setAuthorizer, createSession, `[Symbol.dispose]`; props isOpen, isTransaction; `backup(db, path)` is async | VERIFIED-locally + VERIFIED-docs | bin/brain 45-56 and 55 can drop the `Database \|\| DatabaseSync` fallback and the `emitWarning` monkeypatch |
| node:test | `mock.timers`, snapshot, `assert.partialDeepStrictEqual`, `--test-randomize`, `--test-rerun-failures`, `--test-global-setup`, `--test-shard`, `--test-isolation`, coverage thresholds `--test-coverage-lines/branches/functions`, `--test-coverage-include/exclude`, `--watch` all present in `node --help` | VERIFIED-locally | add coverage gate and randomize in CI |
| util.parseArgs | present, strict mode, short options, `--` handling (tested) | VERIFIED-locally | replaces hand-rolled `opt`/`has` (5.2) |
| util.styleText | present | VERIFIED-locally | not needed (output must stay ANSI-free; render.clean strips it) |
| util.parseEnv, stripVTControlCharacters, getCallSites | present | VERIFIED-locally | `stripVTControlCharacters` can replace the ANSI regex in render.mjs 11 |
| fs.glob / fs.promises.glob | present | VERIFIED-locally | |
| fs.mkdtempDisposableSync | present, works with `using` | VERIFIED-locally | tests and temp work |
| process.getBuiltinModule | present | VERIFIED-locally | not needed in pure ESM |
| AbortSignal.timeout / any | present; jira.mjs 155 already uses `timeout` | VERIFIED-locally | use `any` to combine caller abort + timeout |
| import.meta.dirname / filename / main | present (`import.meta.main` is true in the entry file) | VERIFIED-locally | `import.meta.main` lets lib files expose a runnable entry |
| module.enableCompileCache | present; measured gain about 3 ms on the full import graph (45.6 to 42.5 ms median) | VERIFIED-locally | skip it |
| `--permission` | Stability 2 (stable) since 23.5/22.13; flags `--allow-fs-read/-write`, `--allow-child-process`; `node:sqlite` bypasses fs checks and symlinks are followed; "seat belt, not a boundary" | VERIFIED-docs | not applicable: brain spawns git, reads arbitrary repos, uses sqlite. Do not rely on it |
| Native type stripping | stable since 24.12; unflagged since 23.6; no warning since 24.3; `process.features.typescript === "strip"`; erasable syntax only (an `enum` failed with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX in my test); `.ts` extensions mandatory in imports; ignored under node_modules; tsconfig ignored. `--experimental-transform-types` removed in Node 26 | VERIFIED-locally + VERIFIED-docs | option (b) in section 3 |
| `--experimental-require-module` | `process.features.require_module: true`, no flag needed | VERIFIED-locally | irrelevant (no CJS) |
| zlib zstd, URLPattern, WebSocket, navigator | present | VERIFIED-locally | not needed |
| `node --run` | present (listed in `--help`) | VERIFIED-locally | `node --run test` instead of `npm run test`: faster, no npm |
| Single-executable apps | `--experimental-sea-config` present; still experimental | VERIFIED-locally (flag exists) | not worth it: the plugin needs readable source and uses node:sqlite; distribution is a git plugin |
| `--experimental-config-file` | present | VERIFIED-locally | a `node.config.json` could hold test flags; unverified in detail (UNVERIFIED) |
| WebCrypto vs node:crypto | both present | VERIFIED-docs/locally | node:crypto `createHash` sync is the right tool for fingerprints; WebCrypto digest is async-only |
| fetch/undici | undici 7.28 built in, `AbortSignal.timeout`, `redirect: 'manual'` all used correctly in jira.mjs | VERIFIED-locally | no undici options needed |
| diagnostics_channel, readline/promises | present | VERIFIED-locally | not needed |

## 3. Typing strategy without a build step

Measured with `typescript@7.0.2` (native compiler; `tsc -v` printed `Version 7.0.2`) and `@types/node@24`, config below, run against copies of lib/ and bin/ (bin/brain copied as `brain.mjs` because tsc and Biome ignore extensionless files):

| Config | lib errors | bin/brain | bin/brain-merge |
|---|---|---|---|
| `checkJs`, strict false | 49 | 11 | 0 |
| `checkJs`, strictNullChecks only | 99 | n/m | n/m |
| `checkJs`, `strict: true` | 867 (548 are TS7006 implicit any parameters, 165 TS2339 missing property) | 131 | 2 |

Per-file lib errors under strict (worst first): forecast 185, jira 130, store 111, stale 100, openitems 93, whatif 93, compact 44, render 35, merge 31, model 20, verify 19, jsonl 6.
Non-strict errors by file: jira 22, openitems 14, store 7, compact 2, forecast 2, model 1, render 1 (plus bin/brain 11). The non-strict errors are mostly option objects typed `{}` (for example `process.env` shape in jira.mjs 89, options in compact.mjs 19 and 62).

Options compared:

- (a) JSDoc + `tsc --noEmit --checkJs`, dev-only. Zero change to runtime, files stay `.mjs`, matches "no build step". Cost: JSDoc is verbose; tsc must be a devDependency.
- (b) `.ts` files run directly by Node via type stripping. Real types, no JSDoc noise. Costs: every relative import must be renamed to `.ts`; `import type` everywhere (a missed one is a runtime error, not a compile error unless `verbatimModuleSyntax` is on); no enums or parameter properties; the `bin/brain` extensionless shebang entry and the Claude plugin hook (`bin/brain card --if-present`) still work, but the merge driver path stored in git config must be reinstalled; Node under node_modules refuses `.ts`, which breaks if the tool is ever installed from npm as a dependency; Node 24 floor goes to 24.12; repo-wide rename churn invalidates `git blame`. It also ties distribution to a Node feature that changed between 24 and 26 (transform flag removed).
- (c) plain JS. Zero cost, zero protection. Today the 223 tests are the only net, and tsc already finds real problems (see below).

Recommendation: (a), adopted in three stages, with `.d.ts`-free JSDoc `@typedef`s for the data model (`Ticket`, `Edge`, `SchedRow`, `Model`, `Config`). Revisit (b) only if the team wants to publish to npm as a package with types, and then choose `.mts`.

Staging and cost:
1. 0.5 h: add tsconfig (below), `typescript` devDependency, `npm run typecheck`. Set `strict: false` and fix the 60 errors: about 2 h. Gate in CI.
2. 1 day: add `@typedef` for Model, Config, Options objects; enable `strictNullChecks` + `noImplicitThis` (99 errors lib-only before fixes).
3. 2 to 3 days spread over time: `noImplicitAny` for pure-core modules first (verify, merge, compact, render, model, store: about 250 errors), then whatif/stale/openitems, then jira and forecast. Use `// @ts-check` per file to ratchet instead of a big bang; flip global `strict` last.

tsconfig.json (strict target; start with the commented flags relaxed):

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024", "esnext.iterator", "esnext.disposable", "esnext.collection"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true
  },
  "include": ["lib/*.mjs", "src/**/*.mjs", "bin/*.mjs", "test/*.mjs"]
}
```

Stage 1 sets `"strict": false` and adds `"noImplicitAny": false`. Real bugs tsc already surfaces: `forecast.mjs` 17 and 38 pass `string | number` to a string parameter (JSON.parse of a line), and `compact.mjs` 19 and 62 read option fields that the destructuring type omits (`currentSprint`, `keys`). Add `bin/brain` as `src/cli.ts` (section 5.3) so tsc sees it.

## 4. Lint, format, dev tooling and dependency policy

Measured: `@biomejs/biome@2.6.8`, recommended rules, lint only, on lib + bin copy: 112 `useTemplate`, 37 `useOptionalChain`, 5 `noAssignInExpressions`, 5 `noUnusedVariables`, 3 `noUnusedFunctionParameters`, 2 `noControlCharactersInRegex` (store.mjs 14 `\x00` regex; render.mjs 11 ANSI), 2 `noCommaOperator`, 1 `useConst`. Few real findings; the style ones are autofixable.

| Tool | Verdict |
|---|---|
| Biome (one binary, lint + format, no plugins, fast) | Recommended. One config file, zero peer deps. |
| ESLint + Prettier | Works but pulls about 100 transitive packages for the same result; flat config churn. Not recommended. |
| `node --check` | Syntax only; does not work on `.ts`; keep as a trivial CI step but it adds almost nothing over tsc. |

The code style is deliberately dense (one-line functions, long lines, multiple statements per line). Do not run the Biome formatter over it wholesale: it would explode the diff and break readability the authors chose. Use Biome for linting only, formatter disabled, and for the formatter set `lineWidth: 160` if ever enabled.

biome.json:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.8/schema.json",
  "formatter": { "enabled": false },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "useTemplate": "off" },
      "suspicious": { "noAssignInExpressions": "warn", "noControlCharactersInRegex": "off" },
      "complexity": { "useOptionalChain": "warn" }
    }
  },
  "files": { "includes": ["lib/**/*.mjs", "src/**/*.mjs", "bin/*.mjs", "test/**/*.mjs"] }
}
```

Dependency policy: runtime dependencies stay exactly zero (enforce with a test: `Object.keys(pkg.dependencies ?? {}).length === 0` and an import scan that every non-relative specifier starts with `node:`). Justified devDependencies: `typescript` (checker only), `@types/node` (pinned to 24), `@biomejs/biome`. Nothing else: node:test replaces a test framework, `node --test --experimental-test-coverage` replaces c8.

package.json scripts to add:

```json
"scripts": {
  "test": "node --test --test-randomize test/*.test.mjs",
  "test:cov": "node --test --experimental-test-coverage --test-coverage-lines=85 --test-coverage-include='lib/**' test/*.test.mjs",
  "typecheck": "tsc --noEmit -p .",
  "lint": "biome lint .",
  "check": "node --run typecheck && node --run lint && node --run test"
}
```

(`--test-randomize` exists in 24.18 per `--help`; if a test order dependency appears, that is a finding, not a flake.) Also fix `docs/CONTRACT.md` (Node 22.13 vs `>=24`).

## 5. Code audit

### 5.1 Security and correctness defects (reproduced)

S1. git option injection (VERIFIED-locally). `bin/brain` 255 `git(...)` and 323 `git('show', `${opt('ref','HEAD')}:${p.plan}`)`, `stale.mjs` 217-229 (`ls-tree -r ref`, `show ref:path`, `rev-parse --short ref`). `ref` comes from `--ref`, `config.default_ref`, and (for `show`) the path from refs.jsonl, all untrusted committed data. A ref beginning with `-` is parsed by git as an option. Reproduced: `git show "--output=<dir>/pwned:a"` created a file named `pwned:a`. A committed config.json with `"default_ref": "--output=/path/x"` makes `brain stale` or `brain bundle` write a file. Fix: validate and pass `--end-of-options`.

```js
// src/git.mjs
import { execFileSync } from 'node:child_process';
const SAFE_REF = /^[\w][\w./@^~{}:+-]*$/; // never starts with '-'
export function checkRef(ref) {
  if (typeof ref !== 'string' || !SAFE_REF.test(ref) || ref.includes('..')) throw new TypeError(`invalid git ref: ${JSON.stringify(ref).slice(0, 60)}`);
  return ref;
}
export const makeGit = (root) => (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
// usage: git('show', '--end-of-options', `${checkRef(ref)}:${plan}`)
```

Also reject plan paths that are absolute or contain `..` segments before `show`.

S2. SQL identifier injection in `build()` (bin/brain 114-115). `cols = Object.keys(r)` from a JSONL line is interpolated into `INSERT INTO t(${cols.join(',')})`. A line such as `{"key":"A","summary) VALUES(1,2)--":1}` alters the statement. Impact is limited (one statement, local index file, node:sqlite `defensive` is on) but a committed data file should never shape SQL. It is also the performance hotspot. Fix with an allowlist from the table schema plus a statement cache (section 5.5 gives code).

S3. `table[cmd]` prototype lookup (bin/brain 517-519). `brain constructor` exited 0 silently (VERIFIED-locally; `brain nonsense` exits 1). `toString`, `__proto__`, `hasOwnProperty` behave the same. Fix: use a `Map` or `Object.create(null)` (done in the registry below).

S4. Arbitrary command execution by config (`openitems.mjs` 163-164): `spawnSync('/bin/sh', ['-c', command])` over `config.checks[].command` from the committed config.json. It is opt-in (`--run-checks`) and documented, but it means any committer can run code on every teammate that runs the flag. Mitigations: accept `{ "argv": ["node","scripts/x.mjs"] }` and run with `execFileSync` (no shell), keep the shell form behind `BRAIN_ALLOW_SHELL_CHECKS=1`, print the command before running it, and set a `timeout` (currently none, so a hanging check hangs brain).

S5. ReDoS from config (`bin/brain` 258, `stale.mjs` 29-30). `new RegExp(heading.replace('{id}', escaped), 'm')` where `heading` is `config.ref_heading` (committed, untrusted). The ticket id part is escaped; the rest is not. V8 has no regex timeout. Mitigations: cap `heading.length` (<= 200), reject nested quantifiers with a small check, and run `brain` with `--enable-experimental-regexp-engine-on-excessive-backtracks` (the flag exists in V8 13.6, VERIFIED-locally via `--v8-options`; falls back to a linear-time engine after excessive backtracking). It can be set in code with `v8.setFlagsFromString` before the first regex runs (UNVERIFIED for timing) or via a `#!/usr/bin/env -S node --enable-experimental-regexp-engine-on-excessive-backtracks` shebang. Replace the `RegExp.escape` hand-written escape with `RegExp.escape` (VERIFIED-locally; note it also escapes a leading alphanumeric as `\x61`, which is valid).

S6. Prototype pollution: not exploitable. `JSON.parse('{"__proto__":{...}}')` creates an own property (VERIFIED-locally), object spread is safe (`withDefaults` in store.mjs 42, `{ ...rec }`), and `canonLine`/`canonValue` iterate own keys and serialize manually (store.mjs 46-65). `Object.assign({}, parsed)` WOULD set the prototype of the copy (VERIFIED-locally: `.x === 1`), so never use `Object.assign` on parsed records. `merge.mjs` 31 already uses `Object.defineProperty` for safety. Keep it. Add a lint rule or test that greps for `Object.assign(` in lib.

S7. Merge driver quoting: `shq()` in store.mjs 282 is correct for POSIX. On Windows git runs drivers through sh, fine. Low risk.

S8. Locking (`withLock`, store.mjs 102-113): `Atomics.wait` blocks the event loop, acceptable in a CLI. The stale-lock rule removes a lock older than 30 s even if its owner is alive (a slow `claimTicketGit`, which does network git, can exceed 30 s): two writers can then run. Use `writeFileSync(..., {flag:'wx'})` plus pid liveness (`process.kill(pid, 0)`) before stealing, and `using` for release (section 5.4).

S9. `jira.mjs` is solid (host allowlist, `redirect:'manual'`, secrets registered and redacted, `execFile` not `exec`, timeout 10 s, `maxBuffer`). Small improvements: line 77 `execFile` callback can use `util.promisify(execFile)` or `node:child_process/promises`-style wrapper; line 141 sleep can be `timers/promises` `setTimeout(ms, undefined, { signal })`; line 155 combine `AbortSignal.any([callerSignal, AbortSignal.timeout(ms)])`.

### 5.2 bin/brain: line-level modernization

| Line | Before | After |
|---|---|---|
| 34-38 | `argv.indexOf('--' + n)`, `has`, `opt` | `util.parseArgs` per command (5.3). Today `--runs` as the last token yields `undefined`, `--runs --sigma` swallows the next flag as a value, unknown flags are silently ignored (typos like `--aply` run the dry run). `strict: true` rejects all of these |
| 36 | `opt(n, d)` where `+opt(...)` coerces | typed option parsing: `Number.parseInt` with validation, error on NaN (today `--keep abc` gives `NaN` silently) |
| 42-55 | `loadSqlite()` version check, `emitWarning` monkeypatch, `Database \|\| DatabaseSync` | `const { DatabaseSync } = await import('node:sqlite')`; no warning is printed in 24.15+ (VERIFIED-locally); keep the version guard for the hook only; delete the monkeypatch and the `Database` fallback (`Database` is not exported) |
| 55 | `Db = (file, o) => new C(file, o)` | `new DatabaseSync(file, { readOnly, timeout: 5000 })`; add `timeout` so concurrent builds do not throw SQLITE_BUSY immediately |
| 59 | `execFileSync('git', ...).toString()` | via `makeGit(root)` with `encoding: 'utf8'` (also avoids `.toString()` on every call) |
| 61 | `rj(rc).dir` unguarded | wrap: a malformed `.brainrc` currently surfaces as a raw JSON SyntaxError stack with no file name. Also validate `dir` stays inside ROOT (`path.relative` does not start with `..`); `.brainrc` is committed and untrusted, and `brain init` / `export` write into that directory |
| 81-96 | `fs.existsSync` then write (TOCTOU) | `fs.writeFileSync(f, data, { flag: 'wx' })` and catch `EEXIST` |
| 108 | `readdirSync` + startsWith loop to delete stale temp DBs | `fs.globSync('brain.sqlite.tmp-*', { cwd: DIR })` or `using` temp dir (below) |
| 111-117 | `rows.map`, `forEach((r,i)`, prepare per row | statement cache + column allowlist, 3x faster (5.5) |
| 112-129 | try/catch with manual `db.close()`, `rmSync(tmp)` | `using db = new DatabaseSync(tmp)` plus a `DisposableStack`; no nested try |
| 133 | `S.canonFile(...)` per table | fine; `fs.writeFileSync` then should be `S.writeAtomic` (an interrupted export leaves truncated JSONL in git) |
| 138 | `open()` calls `process.exit(2)` and prints | throw `UsageError` (5.4) |
| 141 | `argv.includes('-v')` | parseArgs `short: 'v'` |
| 174-206 | `chain()` builds `prods` by hand | `Object.groupBy`/`Map.groupBy` or reuse `model.prods` (already computed by `buildModel`); `chain()` and `check()` recompute the graph from SQL while `modelFromDb()` has it |
| 175-177, 214-215, 234-235 | `if (!m.has(k)) m.set(k, []); m.get(k).push(...)` | `Map.groupBy(rows, r => r.consumer)` now; `getOrInsert` after Node 26 floor |
| 196 `carr`, 233 | `Object.entries(load).filter(...).length` | fine; `Iterator.prototype.filter` not needed |
| 239, 365, 418, 421, 437, 514, 507 | `process.exit(1)` inside commands | return an exit code from the command function (5.3) |
| 254 | `crypto.createHash('sha1')` for fingerprints | sha1 is fine for non-security change detection, but use `crypto.hash('sha1', x, 'hex')` (one-shot, added in Node 21/20.12; check availability: UNVERIFIED locally, test with `node -p "typeof require('crypto').hash"`) |
| 258 | hand-rolled regex escape | `RegExp.escape(base)` (VERIFIED-locally) |
| 279, 330, 304 | `argv.slice(1).filter(a => /^[A-Z][A-Z0-9]*-\d+$/.test(a))` silently drops invalid keys (typo `demo-12` is ignored and the command reports success with zero tickets) | parseArgs positionals, then throw on any non-matching key |
| 298 | `tmp = out + '.tmp'` write then rename | `writeAtomic` from store.mjs (random suffix, fsync) |
| 340-344 | `for (let i=0; i<keys.length; i+=size)` | `Array.from({length: Math.ceil(n/size)}, (_, i) => keys.slice(i*size, (i+1)*size))` (no Iterator.chunk yet: stage 4 for 2027, not in Node 24) |
| 347 | `toLocaleString()` for numbers | locale-dependent output breaks CONTRACT rule 6 (determinism: "same input gives byte-identical output"). Use `Intl.NumberFormat('en-US')` or a plain integer |
| 364 | prints `(statuses ...)` through console.log | fine |
| 372-373 | in-line mulberry32 and Box-Muller | move to `lib/rng.mjs` (the contract says to copy the function into lib); `test/fixtures/gen.ts` has its own copy: one source |
| 380-381 | `ready.shift()` + `ready.sort()` inside the loop: O(n^2 log n) for a 100k-ticket plan | use a binary heap (whatif.mjs 135 already has a priority-queue `less`) |
| 446 | `at2` reads two args by index | model as `--close KEY KIND`: parseArgs does not support 2-arg options; use `--close KEY:KIND` or subcommands (`brain open-items close KEY KIND`) |
| 517-519 | `table` object + `table[cmd]` | a `Map` registry (5.3) |
| 524-544 | `main()` replaces `console.log` and `process.exit` globally, collects lines, re-prints | see 5.3: pass an `out` collector; remove global monkeypatching |
| 541, 543 | `realExit(c)` after `flush` | return code, set `process.exitCode`, let the event loop drain (avoids truncated stdout on pipes: `process.exit` after `console.log` to a pipe can lose data on some platforms, most visibly large `--json` envelopes) |
| 543 | `e instanceof IngestError \|\| e.code ? e.message : 'brain: ' + e.message` | typed errors with `exitCode` property (5.4) |
| 545-547 | top-level `await loadSqlite()` before `main()` | with the registry each command declares `needsIndex: true`; sqlite is imported inside `open()` lazily |

### 5.3 Command registry and parseArgs (ready to apply)

Target layout (about 600 lines of bin/brain become 1 shim + 8 small files; each is independently typed and testable):

```
bin/brain                 #!/usr/bin/env node  import '../src/cli.mjs'   (3 lines; hook path unchanged)
src/cli.ts               main(), registry, output capture, exit codes
src/args.ts              shared option schema
src/context.ts           root/dir/config/db helpers (makeContext)
src/db.ts                schema, build, open
src/git.mjs               makeGit, checkRef
src/commands/*.mjs        one file per command: export const meta, export async function run(ctx, args)
```

Command contract:

```js
// src/commands/ready.mjs
export const meta = {
  name: 'ready',
  summary: 'may this ticket be started now?',
  needsIndex: true,
  options: { jira: { type: 'string' } },
  positionals: { min: 1, max: 1, pattern: /^[A-Z][A-Z0-9]*-\d+$/ },
};
/** @param {import('../context.mjs').Context} ctx @param {{ values: any, positionals: string[] }} args @returns {Promise<number | void>} exit code */
export async function run(ctx, { values, positionals: [key] }) {
  // ... ctx.out(line) instead of console.log; return 1 instead of process.exit(1)
}
```

Registry and runner (replaces bin/brain 517-547 and the console/exit monkeypatching):

```js
// src/cli.ts
import { parseArgs } from 'node:util';
import { realpath } from 'node:fs/promises';

const GLOBAL = { json: { type: 'boolean' }, verbose: { type: 'boolean', short: 'v' }, dir: { type: 'string' }, 'if-present': { type: 'boolean' } };
const LOADERS = new Map([ // lazy: a command's file is imported only when it runs
  ['ready', () => import('./commands/ready.mjs')],
  ['ticket', () => import('./commands/ticket.mjs')],
  // ...
]);

export class UsageError extends Error { exitCode = 2; }

async function main(argv) {
  const [name, ...rest] = argv;
  const load = LOADERS.get(name);
  if (!load) throw Object.assign(new UsageError(`unknown command ${JSON.stringify(String(name).slice(0, 40))}; commands: ${[...LOADERS.keys()].join(' ')}`), { exitCode: 1 });
  const cmd = await load();
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...cmd.meta.options }, allowPositionals: true, strict: true });
  } catch (e) { throw new UsageError(`${name}: ${e.message}`, { cause: e }); }
  const lines = [];
  const ctx = await makeContext(parsed.values, { out: (...a) => lines.push(a.join(' ')) });
  const code = (await cmd.run(ctx, parsed)) ?? 0;
  emit(lines, code, name, parsed.values); // bound/clean/JSON envelope, exactly the old flush()
  return code;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e instanceof UsageError || e.code ? e.message : `brain: ${e.message}`); process.exitCode = e.exitCode ?? 1; });
}
```

Benefits: no global `console.log`/`process.exit` replacement (the capture hack at bin/brain 533-541, which also means library code accidentally calling console would be swallowed), exit codes are data (testable with `await run(ctx, args)` in node:test with no child process), unknown flags and bad numbers fail loudly, `Map` lookup fixes S3, `strict: true` makes typos errors. Keep `--json` envelope and bounding in `emit` unchanged so the golden/token tests keep passing. Commands that must stay silent in the session-start hook (`card --if-present`) keep their early return. The existing `NO_GUARD`, `WRITES_TEXT`, `NO_INDEX` sets move into each command's `meta` (`needsIndex`, `writesText`, `skipFormatGuard`), which removes three sets that must be kept in sync with the table by hand.

`parseArgs` caveats (VERIFIED-locally): `values` has a null prototype; `--` ends options; `allowNegative` exists in newer Node; two-argument options (`--close KEY KIND`) need a redesign (use `--close KEY --kind KIND`).

### 5.4 Errors, resources, async

- Typed errors: today there are `IngestError` (jsonl.mjs 5), `FormatError` (store.mjs 10), `JiraError`. Add `UsageError`, `GitError`. Give each `exitCode`, and always pass `{ cause }` when wrapping: bin/brain 116 (`new IngestError(`...${e.message}`)`) loses the original stack; store.mjs 83 throws plain `Error` for the same parse failure that jsonl.mjs throws as `IngestError` (two near-identical parsers, see below).
- One JSONL parser. `jsonl.mjs readJsonl`, `store.mjs parseJsonlText` (77-85), `openitems.mjs parseItems` (69), `compact.mjs parse` (15), `forecast.mjs` (17, 38), `jira.mjs parseSnapshotJsonl` (361) all re-implement split + JSON.parse with slightly different BOM, CRLF, blank-line and conflict-marker handling (jsonl.mjs and parseJsonlText check for conflict markers, parseItems and compact `parse` do not and throw a bare `SyntaxError` with no line number). Make `parseJsonlText` the single implementation, make `readJsonl` call it, and have the others import it (this is the pure-core rule, CONTRACT 4, applied to parsing). `AggregateError` is the natural carrier for "N bad lines": `throw new AggregateError(errs.map(e => new IngestError(e)), 'N bad lines')`.
- `using` for scoped resources (all VERIFIED-locally):
  - `build()`: `using db = new DatabaseSync(tmp)` closes the database on every exit path (today a throw between `db.close()` at 122 and `fs.renameSync` leaves `db = null` handled by hand).
  - `withLock` (store.mjs 102-113): return `{ [Symbol.dispose]() { rmSync(lockPath, { force: true }) } }` and write `using _lock = takeLock(path)`, so the `try/finally` goes away and nested locks compose with `DisposableStack`.
  - Temp work in tests: `using t = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'brain-'))` replaces manual `mkdtempSync` + `rmSync` in the test files (check which tests do cleanup by hand; `test/store.test.ts` and `test/smoke.sh` are candidates).
  - `writeAtomic` (store.mjs 94-99): the fd try/finally is fine; `fs.writeFileSync(tmp, text, { flag: 'wx' })` plus `fs.openSync` only for fsync is the minimal form; keep fsync because it is the point.
- `Promise.try(() => fn())` for APIs that may throw synchronously or return a promise (jira.mjs `exec` injection at 101/105 mixes sync throw and rejection); `Promise.withResolvers()` replaces `new Promise((resolve, reject) => ...)` at jira.mjs 77 and 141.
- Immutability: `Object.freeze` on model Maps is overkill; instead make `buildModel` documented as read-only with a JSDoc `ReadonlyMap`. `whatif.mjs` already guarantees no mutation by test ("never mutates the model"). Prefer `toSorted()` over `[...x].sort()` (about 25 sites) and `Object.groupBy` (null-prototype result, safe keys).
- Sync blocking: `sleepMs` via `Atomics.wait` (store.mjs 100) is fine in a CLI; do not move to async without need.

### 5.5 Performance (measured, 100,000 ticket-shaped records, 21.4 MB file)

| Operation | Time | Note |
|---|---|---|
| `readJsonl` (current: readFileSync + split + parse) | 71 ms | fastest |
| `readline.createInterface` async | 91 ms | slower |
| `fs.promises.open().readLines()` | 87 ms | slower |
| `canonFile` (sort + canonical serialize) | 225 ms | fine |
| SQLite insert, `db.prepare` per row (current, bin/brain 115) | 599 ms | |
| SQLite insert, statement cached by column set | 190 ms | 3.1x faster |
| peak RSS for the whole script (all arrays alive at once) | 528 MB | the 21 MB file becomes about 100 MB of objects; two copies (`rows` + records) exist at once in `build()` |
| `bin/brain` no-op startup | 55 ms wall, vs 33 ms bare node | most of the 22 ms is the first import of node:sqlite and fs |
| full lib import graph with and without `NODE_COMPILE_CACHE` | 45.6 vs 42.5 ms | not worth adding |

Conclusions:
- Do NOT switch JSONL to streaming for the common case: line-by-line async is slower and the parsed structure is held in memory anyway (the model needs random access). Streaming would only matter above about 500k records or when a file exceeds the 512 MB string limit; at 100k records memory (about 100 MB of objects) and time (about 70 ms) are fine. If a future `brain export` of evidence grows past 1M rows, use `FileHandle.readLines()` plus the SQLite insert loop so rows are not retained (the statement cache loop does not need the array).
- Fix `build()` (statement cache). Ready-to-apply replacement for bin/brain 111-118:

```js
// src/db.ts
const COLUMNS = new Map([ // allowlist: column names never come from data
  ['ticket', ['key','summary','epic','sp','jira_status','v2_owner','v2_sprint','verdict','verdict_source','first_verdict']],
  ['schedule', ['version','key','owner','sprint']],
  ['edge', ['consumer','producer','kind','note']],
  ['evidence', ['key','source','verdict','resolution','needs']],
  ['finding', ['key','kind','text']],
  ['meta', ['k','v']],
]);
const bindValue = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

export function loadTable(db, table, recs, fileName) {
  const cols = COLUMNS.get(table);
  const stmt = db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`); // identifiers come from the constant above
  let i = 0;
  for (const r of recs) {
    i++;
    const unknown = Object.keys(r).find((k) => !cols.includes(k));
    if (unknown !== undefined) throw new IngestError(`${fileName}: record ${i}: unknown field ${JSON.stringify(unknown).slice(0, 40)}`);
    try { stmt.run(...cols.map((c) => bindValue(r[c] ?? null))); }
    catch (cause) { throw new IngestError(`${fileName}: record ${i}: ${cause.message}`, { cause }); }
  }
}
```

(Behavior note: unknown fields currently fail at SQL time with a SQLite error message; the allowlist makes the failure explicit and equivalent. Missing columns now bind NULL, which matches the current "column not listed" default. Generate `COLUMNS` from the `SCHEMA` text or from `PRAGMA table_info` after `db.exec(SCHEMA)` to avoid drift: `db.prepare('PRAGMA table_info(ticket)').all().map(c => c.name)` returns the names.)

- Memory: in `build()`, parse tables one at a time and insert immediately instead of `rows = Object.entries(FILES).map(...)` (bin/brain 111), which holds all six files parsed. The "parse everything first, then insert" rule exists to fail before touching the temp DB; keep it only for validation by parsing lazily inside the transaction (the temp DB is discarded on failure anyway, which already makes the build atomic).
- `chain()`, `check()`, `simulate()` re-query SQL into Maps on every call; `modelFromDb()` already builds a model. Minor.
- `whatif.mjs` 223: bounded search of 100000 iterations is intentional; fine.
- `forecast.mjs` 145: O(N^2) pair loop for ICC; N is the number of historical sprints x people, small. Fine.
- `simulate` (bin/brain 380-381): `ready.sort()` inside the loop is the only super-linear spot found, relevant for plans above about 10k tickets.
- Lazy imports are already used correctly everywhere (each lib imported inside the command). Keep `jira.mjs` and `forecast.mjs` lazy.

### 5.6 Per-file notes for lib/

- `jsonl.mjs` (18 lines): dedupe with `store.parseJsonlText`; `fs.existsSync` + `readFileSync` is a TOCTOU (use try/catch ENOENT); `path.relative(process.cwd(), f)` embeds the cwd, so messages differ by cwd (acceptable). Use `.toWellFormed()`? not needed.
- `model.mjs`: lines 14-19 `prods`/`cons` builders are `Map.groupBy` candidates; `new Map(tickets.map(...))` becomes `Map.groupBy` only if duplicates matter; `rj()` at 25 should name the file in the error.
- `store.mjs`: 13-14 control-char regex `\x00` (Biome flag; use a named `const SEP = '\u0000'` and `split`/`replaceAll`); 52 `[...new Set(items)].sort()` ok; 100 `Atomics.wait`; 182 `withLock` into `using`; 245 `git()` shares the option-injection helper, but its inputs are internal (`rel`, key) so lower risk; `claimTicketGit` (256-278) is a distributed CAS through `git push`: correct design, ensure `GIT_TERMINAL_PROMPT=0` (already set) and add a per-call `timeout` to `execFileSync` (a stuck network push hangs the CLI and the lock until 30 s staleness).
- `merge.mjs`: clean. Line 31 `Object.defineProperty` is the right defence against `__proto__` keys. `new Map([...O, ...T])` spreads two Maps; use `new Map([...O, ...T])` fine. Sorting comparator at 60 is a nested ternary: extract `cmp` shared with compact.mjs `lt` (duplicated in compact 11, store 69, verify 84, forecast 42, openitems): one `lib/cmp.mjs` (`export const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0)`); this also serves the determinism rule 6.
- `compact.mjs`: 27-34 `by` Map builder → `Map.groupBy(model.evidence.entries(), ...)` style; 14 `parse` duplicates the shared parser; 56 `(archives[t.file] ||= [])` fine (use `??=`); 64-68 `.map((r,i)=>[r,i]).sort().map(x=>x[0])` decorate-sort-undecorate is unnecessary: `Array.prototype.sort` is stable since ES2019, `toSorted((a,b)=>lt(a.key,b.key))` suffices.
- `render.mjs`: 11 ANSI regex → `util.stripVTControlCharacters` (VERIFIED-locally, but check it strips the same sequences for the byte-identity tests); 90, 103 count-by-key builders → `Map.groupBy` + map to counts.
- `stale.mjs` 29-30: `RegExp.escape` and S5; 217 git helper shared with S1; 218-224 `trees` cache: `Map.getOrInsertComputed` after Node 26 floor.
- `whatif.mjs`: algorithmic code; `[...set].sort()` x many → `toSorted()`; 135 `less()` is a hand-written heap comparator, reuse it for `simulate`.
- `verify.mjs` 56-101: `[...people].sort()`; fine.
- `openitems.mjs` 163-164: S4. 69 `parseItems` skips conflict-marker detection; line 163 import is in the middle of the file (move to the top; ES imports are hoisted anyway, so this is style only).
- `forecast.mjs` 17, 38: tsc finds `JSON.parse(l)` with `l: string | number` (a `forEach`/loop index mixup): fix type; `for (const [no, l] of lines.entries())` is clearer.
- `jira.mjs`: strongest module. 77 `execFile` wrapper; 141 `sleepFn` default; 177 `text = await res.text(); JSON.parse(text)` fine. Replace `Math.random` jitter injection (already injectable). Consider `res.json()` guarded by content-length limit: a hostile or buggy server can send an unbounded body (`res.text()` buffers all). Add a byte cap by reading `res.body` with a counter, abort at 32 MB.

## 6. Prioritized action list

| # | Action | Value | Effort |
|---|---|---|---|
| 1 | S1 git option injection: `checkRef`, `--end-of-options`, path validation (code in 5.1) | Security | 1 h |
| 2 | S2 + perf: `loadTable` allowlist and cached statements in `build()` (code in 5.5) | Security + 3x faster build | 1.5 h |
| 3 | S3: `Map`-based registry; `brain constructor` must exit 1 (code in 5.3) | Correctness | 0.5 h (part of 4) |
| 4 | `util.parseArgs` strict per command + command registry + `ctx.out`, remove console/exit monkeypatching; `bin/brain` becomes a 3-line shim to `src/cli.ts` | Maintainability, loud typo errors, testable commands, exit codes as data | 2 to 3 days (mechanical; one command per PR) |
| 5 | Typecheck: `tsc` 7 + JSDoc typedefs, staged strictness (section 3), gate in CI | Catches the 60 existing issues, prevents regressions | 0.5 day stage 1; 1 day stage 2; 2 to 3 days stage 3 |
| 6 | Single JSONL parser (`parseJsonlText`) used everywhere, with `AggregateError` and `cause` | Consistent file:line errors, conflict-marker detection in all readers | 3 h |
| 7 | `using` for sqlite db, locks and tests (`mkdtempDisposableSync`) | Removes manual cleanup branches | 3 h |
| 8 | S4 `openitems` checks: argv form without shell, timeout, print command before run | Security (config as code execution) | 3 h |
| 9 | S5 regex length cap + experimental-regexp fallback flag; `RegExp.escape` | DoS hardening, less code | 1.5 h |
| 10 | Biome lint-only, `lib/cmp.mjs` shared comparator, `toSorted`/`Map.groupBy` sweeps, reconcile Node floor (CONTRACT 22.13 vs `>=24`, doctor 22.13) | Cleanliness | 0.5 to 1 day |

Not recommended (investigated and rejected, with reason): single-executable app (experimental, plugin needs source), `--permission` (git, sqlite and arbitrary repo reads defeat it; sqlite bypasses fs checks), compile cache (3 ms), streaming JSONL (slower at 100k), native `.ts` execution (cost listed in section 3), Temporal / Upsert / Iterator.concat (not in Node 24; no need), ESLint+Prettier (heavier than Biome for no gain), Biome formatter (would rewrite the dense house style).

## 7. Ready-to-apply snippets (index)

All code blocks above are complete enough to paste: `src/git.mjs` (5.1 S1), `src/cli.ts` and command module (5.3), `src/db.ts loadTable` (5.5), `tsconfig.json` (3), `biome.json` and `package.json` scripts (4). A scoped-lock example for `withLock` with `using`:

```js
// lib/store.ts
function takeLock(lockPath, { retries = 100, waitMs = 20, staleMs = 30_000 } = {}) {
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) { fs.rmSync(lockPath, { force: true }); continue; } } catch { continue; }
      if (i >= retries) throw new Error(`could not take lock ${lockPath}`, { cause: e });
      sleepMs(waitMs);
    }
  }
  return { [Symbol.dispose]() { fs.rmSync(lockPath, { force: true }); } };
}
// caller: { using _lock = takeLock(file + '.lock'); ...critical section... }
```

Open items for the owner: decide the Node floor policy (24 now, 26 when 24 reaches end of life 2028-04-30); confirm that `crypto.hash` one-shot is acceptable (UNVERIFIED locally); decide whether the extensionless `bin/brain` shim must stay (the plugin hook calls `${CLAUDE_PLUGIN_ROOT}/bin/brain`, so yes).

Sources: nodejs.org docs v24 (sqlite, typescript, permissions), nodejs.org/en/blog/release/v26.0.0, nodejs/Release schedule.json, tc39/proposals finished-proposals.md. Secondary web results that disagreed about Temporal and Explicit Resource Management being in ES2026 were resolved in favor of the tc39 table (both expected 2027).
