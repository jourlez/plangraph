# Typing conventions for the TypeScript migration

Every layer task (Tasks 5 to 11) follows this page; it is not restated in the tasks. The pilot that set these rules is the Jira boundary:
`lib/jira.ts`, `src/jira-tenant.ts` and the record interfaces in `lib/model.ts`. Read those files next to this page.

## 1. Check your files

Node strips types at load time; `tsc` is the only type checker. In a `.ts` file JSDoc types are ignored, so a file that was clean as
`.mjs` shows errors right after the rename until you annotate it.

```bash
npx tsc --noEmit --pretty false -p tsconfig.json 2>&1 | grep -E '^(lib/store\.ts|test/store\.test\.ts)\('          # your files, strict
npx tsc --noEmit --pretty false -p tsconfig.prod.json 2>&1 | grep -E '^(lib/store\.ts)\('                           # lib, src, mcp with noUncheckedIndexedAccess
npm run typecheck              # both configs: fails on any error
node --test test/types.test.ts # the negative-type suite (section 9)
```

`tsc` always checks the whole program, so an error can appear in a file that imports yours: grep for the importers too
(`git grep -l "lib/store.ts"`). A per-branch gate is: your tests pass with `node --test`, and the first command shows no error in your files
or in their importers.

## 2. JSDoc to TypeScript

| JSDoc | TypeScript |
|---|---|
| `/** @typedef {{ a: string, b?: number }} X */` | `export interface X { a: string; b?: number }` next to the code that builds it |
| `/** @typedef {'a' \| 'b'} K */` | `export type K = 'a' \| 'b'` |
| `/** @param {string} a @param {X} [o] */ function f(a, o = {})` | `function f(a: string, o: X = {})` (the default makes it optional) |
| `/** @returns {Promise<X>} */` | `: Promise<X>` on the signature (always write the return type of an exported function) |
| `(/** @type {T} */ (x))` | `(x as T) // why it holds` (section 5) |
| `/** @type {Array<[string, RegExp]>} */ const R = ...` | `const R: Array<[string, RegExp]> = ...` |
| callback `{(file: string) => Promise<string>}` | an exported function type: `export type Exec = (file: string, args: string[]) => Promise<string>` |

A description in JSDoc stays as a plain `/** ... */` comment; only the `{type}` parts move. Worked example from `lib/jira.ts`:

```js
// before (.mjs): the option types lived in nobody's head
export async function getCredentialsFor(host, { env = {}, exec = defaultExec, platform = process.platform, registry = {}, allowGeneric = false } = {}) {
```

```ts
// after (.ts): same tokens at run time, every input typed, return type explicit
export type Exec = (file: string, args: string[]) => Promise<string>;
export interface SiteEntry { email_env?: string; token_env?: string; op_ref?: string; keychain?: string }
export async function getCredentialsFor(host: string, { env = {}, exec = defaultExec, platform = process.platform, registry = {}, allowGeneric = false }:
  { env?: Record<string, string | undefined>; exec?: Exec; platform?: string; registry?: Record<string, SiteEntry>; allowGeneric?: boolean } = {}): Promise<JiraCredentials> {
```

A class with fields assigned in the constructor uses `declare` fields:

```ts
export class JiraError extends Error {
  declare readonly code: JiraErrorCode; // `declare`: no class-field initializer at run time
  declare status?: number;
  constructor(code: JiraErrorCode, message: string, extra: { status?: number; resetAt?: string | undefined } = {}) { ... }
}
```

Without `declare`, Node turns `status?: number;` into a real class field: every instance gets an own `status: undefined`, which changes
`Object.keys`, JSON output and goldens.

## 3. Behavior must not change

A conversion diff is annotations only. Allowed: type annotations, `interface`/`type`, `import type`, `as T`, `declare` fields, generic
arguments (`new Map<string, Ticket>()`), `as const`, and parentheses that an assertion needs. Not allowed in a conversion: new variables,
new helper functions, renamed locals, reordered code, changed defaults, `enum`, `namespace`, parameter properties. If a type cannot be
written without one of those, keep the looser type and report it (section 10).

The one exception: a narrowing function may be added only when it replaces an existing inline check with identical semantics, beside a
constant your task's brief authorizes. The pilot's `isAuthMode` (with `AUTH_MODE_LIST`) replaced `['scoped', 'site-token',
'datacenter'].includes(mode)` next to the brief-named `AUTH_MODES`. Every other new helper, variable or run-time item stays forbidden.

Every regular expression, constant, message and comment stays byte-identical. Two traps seen in the pilot: an editor or tool may turn the
escape `\uFEFF` (six characters) into a literal byte-order mark, and `scripts/mutate.ts` holds exact source lines of some files (for example
`if (e.code === 'SYMLINK') throw fail(...)` in `lib/model.ts`): grep your file there and leave those lines untouched.

Check the run-time tokens before committing: strip both versions and diff the words.

```bash
R=<SHA of the commit that renamed your file>; D=$(mktemp -d); git show $R:lib/store.ts > $D/old.ts; cp lib/store.ts $D/new.ts
node --no-warnings --input-type=module -e "import {stripTypeScriptTypes as s} from 'node:module'; import fs from 'node:fs'; for (const f of process.argv.slice(1)) fs.writeFileSync(f + '.js', s(fs.readFileSync(f, 'utf8')))" $D/old.ts $D/new.ts
git diff --no-index -w --word-diff=plain $D/old.ts.js $D/new.ts.js; rm -rf $D
```

Only comments you added and assertion parentheses may differ.

## 4. `unknown` at the edge

Data crossing a trust boundary (JSON.parse, JSONL rows, config files, Jira answers, CLI arguments, files a user names) is unchecked. Type
it so that nothing can be used without the run-time check the code already does:

- A parse result you test as a whole: `let v: unknown; try { v = JSON.parse(text) } ...` then narrow (`readConfig` in `lib/model.ts`).
- A validator that reads fields of untrusted JSON: declare a `Raw*` interface whose fields are all optional and whose leaves are `unknown`
  (`RawIssue`, `RawFields`, `RawAdf` in `lib/jira.ts`). Any parsed object or null fits, and an `unknown` leaf must be tested before use.
  Pin `JSON.parse`'s result to it with an annotation (`let j: RawRegistryFile | null`), never with `any`. Give a leaf its expected type
  only when the code tests it through a loop key TypeScript cannot narrow (`RawSiteEntry`), and say so. A container field (an array or object) is only as safe as the code that reads it. A Raw* field that the code iterates or calls methods
  on without a check (`for...of`, `.length`, `.map` with no `Array.isArray`) must be typed `unknown`, or carry the comment
  `// unchecked: iterated without Array.isArray (pre-existing)` when a conversion cannot add the check (`RawFields.comment.comments`,
  `RawHistory.items`). A nested object field (`status?: { name?: unknown } | null`) is fine only where every read goes through `?.`, so a
  non-null primitive in its place reads `undefined` harmlessly.
- The caller side of a Raw* parameter: `JSON.parse` returns `any`, which reaches a Raw* parameter unchecked; that is the edge, and the
  validator tests every field. A caller that holds an `unknown` passes it with one assertion: `normalizeIssue(x as RawIssue) // the validator tests every field`.
- `Array.isArray(x)` narrows `unknown` to `any[]`: type the elements at once (`for (const l of (... ) as RawLink[])` or an annotated variable).
- `Number.isInteger` and `Number.isFinite` do not narrow: follow them with `(n as number)` and the comment `// Number.isInteger is the check`.
- `catch (e)` is `unknown` under strict: read `e && (e as Error).message` with the comment `// whatever was thrown ...`; never `catch (e: any)`.
- A small string union read from config is narrowed by a function next to its constant (`isAuthMode(x: unknown): x is AuthMode` beside
  `AUTH_MODES`), within the limit of section 3: only as a replacement for an existing inline check.

## 5. Assertions

Order of preference: a narrower declared type, an existing narrowing check, a narrowing function that already exists, then an assertion.
Every assertion carries a one-line reason on the same line (or the line above) saying why it holds: `return c as JiraCredentials; // token
was defined on the line above`. Use `as T`, not `x!` (Biome warns on `!`). Never `any`, never `as any`, never `@ts-ignore`.

In tests, a deliberate misuse (a number where a string is required, junk input) is written `// @ts-expect-error <why>` on the line above
when that line holds only the misuse, else `5 as unknown as string // deliberate misuse`. A test predicate types its parameter with what it
expects (`(e: JiraError) => e.code === 'bad_host'`): a wrong guess makes the test fail, never pass.

## 6. Injected dependencies

Type a dependency by what the code calls, not by the global's full type, and export the type next to the function:

```ts
export type Exec = (file: string, args: string[]) => Promise<string>;              // credential helpers
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;     // globalThis.fetch fits, so does a test double
sleep?: (ms: number) => Promise<unknown>; now?: () => number | Date; random?: () => number; log?: (s: string) => void;
```

When a function takes a client or service object, declare an interface with only the members it uses (`SnapshotClient`, `IssueTextClient`
in `lib/jira.ts`), so a test fake fits without a cast.

## 7. `env`

Always `env: Record<string, string | undefined> = {}`, spelled out (no shared alias, so no import only for it). `process.env` is
assignable to it. Keep existing `env.NAME` reads as they are (annotation-only). `noPropertyAccessFromIndexSignature` is not adopted (it
only changes the spelling of index-signature reads and adds no safety beyond `noUncheckedIndexedAccess`), so either spelling is accepted.

## 8. Shapes

- Records: import `Ticket`, `Edge`, `ScheduleRow`, `Model`, `PlanConfig` from `lib/model.ts`; never redefine them. Optional known fields
  admit `null` (the validators treat null as absent); unknown fields arrive through the index signature.
- A function that returns a shape built from data gets an explicit exported interface (`Snapshot`, `JiraIssue`, `PullResult`), never `any`.
- Result variants: a union discriminated on a field that exists at run time (`ok: true | false`). Give each variant the other's fields as
  `?: never` (`PullSuccess.code?: never`) so an unnarrowed read compiles and reads `undefined`, as it does at run time.
- Imports name the real extension (`./model.ts`, `./jsonl.ts`); type-only imports use `import type`.

## 9. Negative-type fixtures

One file per layer: `test/types-fixtures/<layer>-bad.ts`. Line 1 is `// expect: TS2322,TS2345`, the codes in source order (repeat a code
for each occurrence: `// expect: TS2741,TS2741`). Each misuse is one statement with a comment naming the code; use `export const` so
nothing is an unused variable. `test/types.test.ts` runs `tsc` once with `test/types-fixtures/tsconfig.json` (the final strict flags: it extends `tsconfig.json` and adds `noUncheckedIndexedAccess`) and
requires each fixture to produce exactly its listed codes, in order; errors located in library files are not counted. Do not edit the
runner or that tsconfig. Useful codes: TS2322 (wrong type assigned), TS2345 (wrong argument), TS2554 (wrong argument count), TS2741 (one
required property missing; several missing give TS2739), TS2540 (assignment to a readonly property, not TS2322). Look at your fixture's
codes with `npx tsc --noEmit --pretty false -p test/types-fixtures/tsconfig.json 2>&1 | grep '^test/types-fixtures/<layer>-bad.ts'`.

## 10. Report, do not force

In a parallel task, do not edit `tsconfig.json`, `tsconfig.prod.json`, `biome.json`, `test/types.test.ts` or another task's files: list in your report
every type you could not express without a run-time change. Known residue from the pilot (history; Task 12 resolves each):

- `lib/model.ts` `readConfig` read `e.code` in a catch whose lines are pinned by `scripts/mutate.ts`; resolved, it is strict-clean now (`(e as Coded).code`).
- `ModelRecords` in `lib/model.ts` (the input of `buildModel`) types each list as `readonly object[]`, not `Ticket[]`, because existing
  tests pass deliberately ill-typed records (a string `sp` or `sprint`). The layer task that types the core libraries tightens it to
  `readonly Ticket[]`, `readonly Edge[]`, `readonly ScheduleRow[]` and marks each ill-typed test fixture `as unknown as Ticket[] // deliberate misuse`.
- `test/jira.test.ts` and `test/jira-slim.test.ts` are non-strict only.
- The final flags flagged the `undefined` body in `makeClient`'s `RequestInit`.
