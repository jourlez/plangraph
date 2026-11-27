# Stability after 1.0

This is the promise about the files plangraph writes in your repository and the commands that read them. It covers the plan directory ([docs/FORMAT.md](FORMAT.md)), the `--json` envelope, the command names and the exit codes. It does not cover the git-ignored, rebuildable files (`plangraph.sqlite`, `cache/`, the solver input): those can change in any release, and `plangraph build` recreates them.

## The rule

- **Minor releases (1.x) only add.** A minor release may add a new optional field, a new node kind, a new relation, a new command, a new option, a new document generator, a new violation code, or a new key in the `--json` `data` object. It does not remove, rename or repurpose any of these, and it does not change what an existing field means.
- **A change that breaks a reader needs a major version.** Anything that would make a 1.0 tool misread, refuse or damage a directory written by a later 1.x tool, or the reverse, waits for 2.0. That includes: removing or renaming a field, changing a field's type or meaning, changing the canonical text of a node or batch file, changing a file name or path scheme, changing an id derivation, and raising `min_reader`.
- **Unknown data survives.** A reader never interprets a field it does not know and never drops it: an older tool that edits a node keeps the newer tool's fields, sorted with the rest (`docs/FORMAT.md` section 2). This is what makes "additive" safe.
- **Newer directories are refused for writing.** `format.json` holds `format_version` and `min_reader`. A tool that finds `format_version` above its own refuses to write; it reads only when `min_reader` is not above its own. The message says to upgrade the tool.
- **Pre-1.0 directories are not migrated.** A directory written before 1.0 (the one-file-per-kind layout, `format_version` below 2) is refused with `unsupported pre-1.0 directory: recreate it with plangraph takeover`. This is the one format break, made once, before 1.0.

## `schema_version` per entity

A node or batch line may carry `schema_version`, a whole number of at least 1, which is the version of that one entity's own shape (not of the directory). A missing value means 1. The rules:

- A reader reads an entity with a higher `schema_version` than it knows, and keeps every field it does not understand. It never refuses an entity for being newer.
- A writer that adds a field to an entity kind in a minor release keeps `schema_version` unless the new field changes how existing fields are read; bumping it is how a later tool tells that it can rely on the new field being present and meaningful.
- Within a major version, a given `schema_version` of a kind never changes meaning. A reshaping that breaks readers is a new major version, not a new `schema_version`.

`format_version` (the directory) and `schema_version` (one entity) are separate on purpose: the first gates whether a tool may write at all, the second travels with each entity so one clone can hold entities of mixed ages.

## How a break would ship

If 2.0 ever has to change a shape, it follows the expand, migrate, contract sequence in `docs/FORMAT.md` section 6, over separate releases: the new shape is first read and written beside the old one, then a tested, idempotent migration rewrites data, then the old reading code goes. `min_reader` is raised only when an old tool would misread the new shape, so that it stops with "upgrade" instead of damaging data.

## What is stable, what is not

| Surface | After 1.0 |
|---|---|
| Plan directory layout, node and batch file syntax, reserved fields | stable under the rule above |
| `config.json` keys | additive; an unknown key is kept and ignored |
| Command names, options and their meaning | additive; a command or option is removed only in a major version |
| `--json` envelope (`v`, `cmd`, `ok`, `exit`, `data`, `fresh`, `next`) | `v` changes only in a major version; `data` may gain keys |
| Exit codes 0 to 5 | stable |
| Violation codes of `plangraph check` | codes are not renamed or reused; new ones may appear |
| Plain-text output of commands | not a contract: wording and counts may change in a minor release. Use `--json` to parse |
| Generated documents (`docs/plangraph/`) | content may change; the `<!-- plangraph:begin ... -->` and `<!-- plangraph:end ... -->` region markers are stable |
| `plangraph.sqlite`, `cache/`, `cache/solver-input/` | not stable; derived and rebuilt |
| Library modules under `lib/` and `src/` | internal; not a public API |

## What is not verified

The rule above is a policy and the tests around it are narrow: `test/store2-pg.test.ts` checks that an unknown field is kept and sorted with the rest, `test/graph-files.test.ts` that `schema_version` and an unknown field survive a round trip, `test/store2-check.test.ts` that a malformed `schema_version` is reported, and `test/store.test.ts` that a directory with a newer `format_version` is refused for writing. No test replays a real 1.x release against a 1.0 directory, because no 1.1 exists yet, and nothing tests that a reader reads a `schema_version` above the highest one it knows beyond keeping the fields. The first minor release must add that test (a directory written by the previous release, read and rewritten by the new one, byte for byte on the fields it does not know).
