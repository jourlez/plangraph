# Open items register

Decisions and fixes owed by a named person before a ticket may start. Module: `lib/openitems.ts`. Tests: `test/openitems.test.ts`.

## Data
`open-items.jsonl`, one record per line, sorted by `key` then `kind` (plain `<`), canonical field order, `\n`, trailing newline:
`key, kind, owner, due_sprint (int|null), status ("open"|"done"), text, closed_at?, closed_by?, close_note?, source? ("manual")`. Unknown extra fields are kept and sorted last. Reading checks that `key` and `kind` are strings, `owner` is a string or absent (or null), and `status` is a non-empty string when present; anything else is a data error naming the line (exit 2).
An item is identified by `key|kind`, one item per pair (several findings of the same pair merge into one text, sorted, joined by ` | `, max 300 chars).

## Contract with `plangraph ready`
`ready` reads exactly `status`, `key`, `kind`. An item is closed iff `status === "done"`; every other status blocks. A finding blocks its ticket unless a
closed item with the same `key|kind` exists. A manual open item (no finding behind it) also blocks. Reuse `blocksReady(items, key, {findings})`
(true when blocked), `blockingItems(items, key)` (reasons) and `closedSet(items)` (the `key|kind` set `ready` builds inline today).
`config.ignore_link_kinds` only skips link waits in `ready`; it never hides findings and never changes the derived items.

## Config
```json
{ "owner_of_decisions": "<name>",
  "open_items": { "rules": [ {"kind":"external","owner":"decision-owner","due":"before_ticket_sprint"},
                             {"kind":"export_clash","owner":"ticket-owner","due":"n_before","n":1},
                             {"kind":"enum_clash","owner":"<name>","due":"sprint:4"} ],
                  "default_rule": {"owner":"ticket-owner","due":"before_ticket_sprint"},
                  "ignore_kinds": [], "lead_time": 0 } }
```
Owner: `decision-owner` = `config.owner_of_decisions` (unset gives `unassigned`), `ticket-owner` = owner in the current schedule, else a literal name.
Due: `before_ticket_sprint` = ticket sprint, `n_before` = ticket sprint minus `n` (default 1), `sprint:N` = N. Unscheduled ticket gives `due_sprint: null` (never due).
Kinds with no rule use `default_rule`, so every finding that blocks `ready` has an item that can be closed.

## Due logic
Effective due = the ticket's CURRENT schedule sprint through its rule (so schedule moves are honoured); stored `due_sprint` for manual items or unscheduled tickets.
An open item is DUE when `due - lead_time <= currentSprint`; `late` is `due < currentSprint`. `overdueItems(model, items, {currentSprint, leadTime?, config?})`.

## API
- `openItemsFromFindings(model, config = model.config, {extraFindings})` -> items
- `reconcileItems(existing, derived, {pruneClosed})`: keeps status/closed_* of items that still derive, refreshes owner/due/text, drops open items whose finding vanished, keeps closed ones (history) and manual ones. Idempotent.
- `registerItem(items, {key, kind, owner, due_sprint, text})` (adds `source:"manual"`), `closeItem(items, key, kind, {by, note, at})`, `reopenItem(items, key, kind)` (close then reopen is an exact round trip). All immutable; `at` defaults to today (pass it for reproducible output).
- `serializeItems(items)` / `parseItems(text)`, `effectiveDue`, `overdueItems`, `blocksReady`, `blockingItems`, `closedSet`
- `renderOpenItems(items, {byOwner:true})`: byte-stable OPEN-ITEMS.md (no timestamps; closed dates come from the data), so a CI `git diff --exit-code` guard works.
- `renderCompact(items, {me, currentSprint, limit=5, maxChars=480})`: under 120 tokens, `... N more` marker, mine first then by due.
- `parseFindings(text, name)` -> `{findings, errors}`. Input is JSONL, one `{key,kind,text}` per line (all strings). Blank lines are skipped; every other bad line yields an error `name:line: reason` (the line's content is never echoed). Limits: 1 MiB per line, 100000 findings. Pass `extraFindings: result.findings` to `openItemsFromFindings`.
- The plugin never executes commands. Checks (schema clashes etc.) run in CI or via Claude's own Bash tool under its normal permission prompts, and write a findings JSONL file; a `checks` section in config is ignored.

## CLI wiring (as implemented in `src/commands/openitems.ts`)
`plangraph open-items [--mine] [--close KEY KIND [--note TEXT] | --reopen KEY KIND | --register KEY KIND --owner O --due N --text T] [--findings FILE|-] [--write] [--sprint N] [--me NAME]` (one action per run)
1. load model; `const {findings, errors} = parseFindings(readFileSync(file, 'utf8'), file)` (print errors to stderr); `derived = openItemsFromFindings(model, config, {extraFindings: findings})`;
2. `items = reconcileItems(parseItems(file), derived)`; apply one of `--close`, `--reopen` or `--register` (one action per run: giving two is a usage error, exit 2); `--mine` filters to `owner === me`;
3. `--write`, or any one action, writes `serializeItems(items)` to `open-items.jsonl` and `renderOpenItems(items)` to `OPEN-ITEMS.md`; otherwise print `renderCompact(items, {me, currentSprint})`, its item lines (which carry free text) inside one `<untrusted>` fence; exit 1 if anything is late (optional).
4. In `ready`: replace the inline closed set by `blocksReady`/`blockingItems`/`closedSet`, and list manual open items as reasons.

Example (the renderCompact text measured 40 tokens for 3 items, hard cap 120; the CLI fence adds about 15):
```
open items: 3 (0 yours, due S3: 3)
<untrusted src="open-items" n="..." len="...">
- T-3 plan_text S1 Ben: step needs missing thing
- T-5 external S1 Ana: need a login
- T-9 export_clash S1 Ben: two exports
</untrusted>
```
