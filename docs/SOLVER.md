# plangraph-solve: sprint assignment with CP-SAT

Assigns every ticket to one person and one sprint. Rules: each ticket placed once; person-sprint load within capacity; strict handoff
`sprint[consumer] >= sprint[producer] + (owner differs ? 1 : 0)`; frozen tickets unchanged (they still use capacity). Frozen history
(docs/CONTRACT.md, `lib/frozen.ts`): a constraint exists only where at least one side is free, so a link whose producer is closed and a link
between two frozen tickets constrain nothing (never INFEASIBLE, never a delayed consumer), and a cell's capacity binds only its free load
(free load within `max(0, cap - frozen load)`: a frozen cell above cap is history, not a violation, and takes no free story point); every ticket that is not
frozen goes to `first_sprint` or later, so no new work lands in a past sprint (a frozen ticket keeps its own slot, even before `first_sprint`).
The independent verifier rejects a free ticket placed before `first_sprint` (frozen tickets are exempt), and the end-sprint capacity bound counts
only the work that must sit in sprints `first_sprint` and later.

## Run

```
bin/plangraph-solve-run --out schedule.json [--end 14] [--time 400] [--workers 8] [--seed 1] [--deterministic]
                    [--baseline current|v2|<archive>] [--freeze K1,K2] [--freeze-file f.json] [--jsonl-dir DIR] [--no-reduce] [--balance]
                    [--lns] [--decompose] [--verbose]
plangraph schedule-load schedule.json <archive-name>
```

`plangraph schedule-load` refuses (exit 4, nothing written) a schedule that moves or drops a frozen ticket of the current plan (docs/CONTRACT.md,
Frozen history); `plangraph verify schedule.json` names each one as `FROZEN_MOVED`.

`--jsonl-dir DIR` reads `tickets.jsonl edges.jsonl schedule.jsonl config.json` directly (no SQLite). Without it the solver reads
`plangraph.sqlite` and `config.json` from the plan dir (as before). `--end 0` and `--time 0` are real values.

## Status (never inflated)

| status | meaning | `proved` |
|---|---|---|
| OPTIMAL | every stage ended OPTIMAL and the model covers every schedule the stage order may prefer (see Horizon below): the lexicographic optimum is proved | true |
| FEASIBLE | a verified schedule, not proved optimal; the first unproved stage prints `gap=` and `bound=` (`gap=n/a (bound 0)` when its bound is 0) | false |
| INFEASIBLE | proved no schedule exists (within sprints up to `horizon`); the output names links that cannot hold | true |
| UNKNOWN | no schedule found in the budget | false |
| MODEL_INVALID | bad input: loop, unknown config person, ticket larger than any capacity, unknown freeze key, missing baseline | false |

A schedule found only by the constructive heuristic (solver stage 1 timed out) is FEASIBLE with `source: constructive`. `end_sprint_proved`
says whether the end sprint alone is proved minimal; it is true only when `end_sprint` is the first stage (an end sprint minimised after
another stage is minimal under that stage's optimum, not globally). A run with `--lns` or `--decompose` never turns FEASIBLE into OPTIMAL.

Exit codes: 0 proved or feasible within the target end sprint; 1 infeasible; 2 usage or invalid model; 3 OR-Tools not installed;
4 target end sprint missed (schedule written, explanation printed); 5 unknown; 6 the independent verifier rejected the result (nothing written).

## Output

`--out` is the array `[{item, owner, sprint}]` that `plangraph schedule-load` reads, written atomically (temp file + `os.replace`).
Metadata is in `<out>.meta.json` (`--meta none` to skip), or inside `{"schedule":[...],"meta":{...}}` with `--format object` (then
`plangraph schedule-load` must be taught the object form; it reads arrays today). Meta fields: `status proved stages[{name,status,objective,bound,gap_pct,
wall_s|det_time,conflicts,budget}] objective bound gap_pct end_sprint end_sprint_bound end_sprint_proved target_end target_met owner_changes
shortfall conflicts seed workers deterministic ortools_version input_hash wall_s links_total links_modeled horizon explanation verified source
stage_order`, plus `lns decompose components polish{method,rounds,improved,components,before,after}` when those options are used. Each stage
`objective` is the value the final schedule has (a later stage or the polish may have lowered an unproved stage's value after it ended), and its
`gap_pct` is recomputed against the stage's `bound`. The bound holds under the earlier stages' values at the time the stage ran; if a later
improvement (the polish) lowered an earlier stage, a value can end below its bound: the gap then shows 0, never a positive number, and the
stage record carries `below_bound: true`. A stage whose bound is 0 (or below) while its value is above 0 has no meaningful relative gap (it would
be 100% for any value): its `gap_pct` is null with `gap_note: "n/a (bound 0)"`, the meta `gap_pct` is then null with `gap_note: "n/a (bound 0):
<stage names>"`, and the status line says `gap=n/a (bound 0)`.

### Anytime output

While the solver runs, `--out` always holds the best verified schedule found so far, so a kill (`SIGTERM`, `SIGKILL`, a crash) at any moment
leaves a valid file: the constructive schedule is written before the model is built, then every solution the CP-SAT callback reports that is
lexicographically better in stage order and passes the independent verifier, at most once per second (the end of every stage is always
written). Each write is atomic (temp file, fsync, rename, directory fsync), so a reader sees either the previous file or the new one. Before each
schedule write the meta file is written with `partial: true`, `status: FEASIBLE`, `proved: false`, `verified: true`; the final meta replaces it
when the run ends. Because the partial meta goes first, a kill in the instant between the two renames leaves a partial meta beside the schedule
written before it (the previous anytime schedule, or the `--out` from before the run on the first write), whose metrics then describe the
schedule that was about to be written; it never leaves a new schedule beside an earlier run's final meta. With `--meta none` (and the default
array format) nothing could mark a mid-run `--out` as partial, so anytime writes are off: `--out` is written once, at the end. With
`--format object` the meta travels inside the file, so anytime writes stay on. `--verbose` prints one `anytime {...}` line per write
to stderr (`stage` ends in `:done` for the end-of-stage write). A kill between `mkstemp` and the rename can leave a `.plangraph-solve-*.tmp` file
in the output directory.

When the run ends without a schedule (INFEASIBLE, UNKNOWN, VERIFY_FAILED, MODEL_INVALID from the solver), the `--out` that existed before the run
is put back byte for byte (or removed, if the run created it), so "nothing written" still holds for the schedule file. The previous `--out` is
snapshotted at start; if it is not a regular file of at most 64 MiB, anytime writes are off for that run (`anytime` in the meta says so). A kill
skips the restore: then `--out` holds the last verified schedule.

Killing the launcher: `bin/plangraph-solve-run` `exec`s the solver's Python on every path, so the launcher's process is the solver and any
signal, `SIGKILL` included, stops it: no orphan is left to overwrite `--out` later. On the uv path uv only prepares the environment
(`uv sync --locked --script bin/plangraph-solve`, which still verifies the pinned lock and fails on a stale one) and names its interpreter
(`uv python find --script`); an overriding `PLANGRAPH_SOLVE_SCRIPT` runs on that same locked environment. Both preparation calls run from the
plugin's `bin` directory, so a `uv.toml` (or `pyproject.toml` `[tool.uv]`) in the repository you run from is not read; your user-level uv
config and `UV_*` variables (a mirror through `UV_INDEX_URL` or `UV_DEFAULT_INDEX`) still apply. The solver itself runs in your directory. On a macOS framework build of Python
(Homebrew, python.org) that interpreter's `bin/python3.x` itself `exec`s `Python.framework/.../Python.app/Contents/MacOS/Python`, so `ps`
shows the process as `Python`, but it is the same process (same pid) and the same guarantee holds (tested on Homebrew 3.14). If that preparation fails (an uv
without `sync --script`), the launcher falls back to `uv run`, where uv stays the parent (the fallback's interpreter comes from `bin`, never from your
directory: an absolute `--python` found by `uv python find` run from the plugin's `bin` directory, with `UV_PYTHON` as the request when set, so a
`.venv` or `.python-version` committed in the repository is never used; when none is found it exits 3 naming `uv python install 3.14`); the solver then runs a parent watchdog
(`PLANGRAPH_SOLVE_WATCH_PARENT=1`, set only there): a thread polls `getppid()` every 0.2 s and, once uv is gone, takes the write lock (so no write
is cut short; an anytime meta + schedule pair and the final schedule + meta are each held as one unit) and exits with no further write.
After a kill, `--out` holds the last verified anytime schedule and its meta says `partial: true`. Tested: a SIGKILL on the launcher on both
paths (`PLANGRAPH_SOLVE_LAUNCH=uv-run` forces the fallback) leaves no solver process within 5 s and `--out` unchanged afterwards. Not covered: a
SIGKILL that lands inside the one-process solver's own write leaves a `.plangraph-solve-*.tmp` file (see above), never a torn `--out`.

## Method

1. Two constructive passes (owners kept; owners free, longest chain first) give a verified start and an upper bound `horizon` on the end sprint.
   The current plan, when it places every ticket and passes the verifier (`current_valid` in the meta), is a third candidate: the search
   starts from the lexicographically best candidate in stage order, and the result is never lexicographically worse than any of them
   (with `owner_changes` ranked above `end_sprint`, owner changes never exceed the current plan's).

   Horizon: with `end_sprint` as the first stage the optimum end sprint is at most the earliest valid construction, so that is the horizon.
   When a stage is ranked above `end_sprint`, the schedules it prefers may end later, so the horizon also contains every valid candidate
   (both constructions, the current plan) and the target end sprint (capped at 2 x tickets sprints past the latest candidate, to bound model
   size). The model still holds only schedules ending by the horizon, so such a run is OPTIMAL only when every stage before `end_sprint`
   reaches a lower bound that no schedule can beat whatever sprint it ends in (`owner_changes`: tickets larger than their baseline owner's
   capacity; `load_of`: tickets nobody else can hold; `peak_load`: the largest ticket or frozen cell; `shortfall`: 0). Otherwise the run is
   FEASIBLE with `proof_scope: "horizon"` in the meta and the line says `optimal only among schedules ending by sprint H` (`proof_scope` is
   `"global"` otherwise).
2. One CP-SAT model: exactly-one (person, sprint) boolean per free ticket; per link one `diff` boolean with
   `spr[c] >= spr[p] + diff` and `diff = 0 => owner[c] == owner[p]`; capacity per person-sprint. Links are transitively reduced
   (sound for the strict rule: `[a!=c] <= [a!=b] + [b!=c]`; tested against `--no-reduce`).
3. Lexicographic stages, each hinted from the previous result and constrained to the previous optimum: (1) end sprint, (2) shortfall below
   `min_per_sprint` over sprints up to the end, (3) total SP of `minimize_load_of` (or peak person-sprint load with `--balance`/`balance_load`),
   (4) owner changes vs `--baseline`. `weights` in config.json are no longer used. `stage_order` in config.json reorders the stages (see below). Budget: 85% of `--time` for stages (stage 1 gets 60% when later
   stages exist), the rest for the infeasibility explanation. Unused time rolls forward. The solver import, load and model build count against `--time`.
4. Explanation (INFEASIBLE, or target missed): relaxed model, every link droppable at cost 1, capacity and frozen slots hard; reports `N links cannot
   hold with end sprint E: A>B, ...` (A needs B; at most 8 listed; "not proved minimal" when the relaxation timed out; only links that constrain
   under the frozen-history rule are candidates, and those ending at a frozen consumer are counted as ones no later end sprint fixes). If no link
   is to blame it says the capacity left beside the frozen tickets does.
5. A separate pure-Python verifier rechecks the result against the original (unreduced) links; failure means exit 6 and no schedule file.

Stage order: `stage_order` in config.json is a list of `end_sprint shortfall load_of peak_load owner_changes`. Listed stages run first, in that
order; stages left out follow in the default order; stages that do not apply (no `min_per_sprint`, no `minimize_load_of`, no balance, no
baseline owners) are dropped; `load_of` wins over `peak_load` as before. Unset, or the value `plangraph init` writes
(`["end_sprint","shortfall","load_of","peak_load","owner_changes"]`), gives the order above. For a replan where keeping people on their tickets
matters more than spreading load, use `["end_sprint","shortfall","owner_changes","load_of"]`: with every stage proved, owner changes are then
never more than with the default order (tested against brute force on tiny plans and on 26-ticket replans whose current plan is feasible).
Shortfall placed before `end_sprint` counts only sprints up to the (still free) end sprint, so it means the same in any position. Errors exit 2
with a fixed message that does not echo the value: `stage_order must be a list of stage names`, `stage_order names an unknown stage (known: ...)`,
`stage_order lists a stage twice`. The value is part of `input_hash` only when set, so the hash of an existing plan does not change.

Frozen tickets: `--freeze`, `--freeze-file` (JSON array of keys), config `frozen_statuses` (by `jira_status`), config `frozen_before_sprint`
(current sprint below it). All use the current schedule slot. Closed tickets (`jira_status` Done, or one listed in config `closed_statuses`,
or an `sp:` task with `impl_status` done) with a current slot are always frozen, whatever `frozen_statuses` says; `plangraph verify` and `plangraph
whatif` pin them the same way. The links that constrain are filtered by the frozen-history rule before the transitive reduction (reducing
first could drop `c>p` as implied by `c>m>p` and then drop `c>m` because `m` is closed). An INFEASIBLE whose culprit link ends at a frozen
consumer says that no later end sprint fixes it (the free producer cannot start before `first_sprint`), instead of blaming the end sprint.

Determinism: `--seed N` (default 1). `--deterministic`: 1 worker, `max_deterministic_time` instead of wall time, no wall-clock fields in the
output, so repeated runs on the same input are byte-identical. Without it, multi-worker runs may differ run to run (both valid).

Capacity default when neither `caps[person]` nor `caps.default` exists: 140 (same as `lib/model.ts`).

Fractional story points: `sp`, `caps` and `min_per_sprint` may be any non-negative numbers with at most 4 decimal places (more, or a
non-number, exits 2 `story points, caps and min_per_sprint must be numbers with at most 4 decimal places`). They are read as exact decimals and
scaled by the smallest power of ten that makes all of them whole numbers, so the integer model is exact (an all-integer plan is not scaled, and its
model, output and `input_hash` are unchanged); load figures in the output (`shortfall`, `load_of`, `peak_load`, their stage objectives and bounds)
are reported in story points. `plangraph verify` sums story points as binary floats, where `0.1 + 0.2` is above `0.3`; so a person-sprint cell
that holds a story point which is not exactly a binary float (0.1, 2.6; unlike 0.5 or 0.25) is kept strictly below its capacity, never at an
exact tie. That is the safe side: the solver may leave a tie unused that `plangraph verify` would have accepted, never the reverse. A 0-SP
ticket adds nothing to the float sum, so it may still join such a cell at a tie held by frozen tickets (its placement adds no violation `plangraph
verify` did not already report), and `plangraph whatif` likewise allows a 0-SP move into a cell that is already over capacity.

## Cost to know

Every stage rebuilds the presolve of the whole model; on a 1400-ticket / 9.6k-link plan that is about 12 s with 8 workers per stage, so budgets under
about 30 s cannot reach stage 2. Model size is `tickets x people x horizon` booleans.

## Polish: `--lns` and `--decompose`

Both run after the stages and only when the stages did not prove everything (they are skipped on an OPTIMAL run). With either option the
stages get half of the 85% stage budget and the polish gets the rest. Each round re-solves a subset of tickets with every other ticket fixed
to the incumbent and the end sprint capped at the incumbent's: the stages of `stage_order` except `end_sprint` run lexicographically on that
small model, hinted from the incumbent. A round's result is kept only when the independent verifier accepts it and it is lexicographically
better in stage order. Neither option is on by default, and neither ever claims a proof.

- `--lns`: rounds of a seeded random 20% of the free tickets (`random.Random(--seed)`), 5 s (or 5 deterministic seconds) per round, until the
  budget is spent (at most 1000 rounds). In `--deterministic` mode each round is charged at least 0.1 deterministic seconds because building
  the sub-model is not counted, so a deterministic run with `--lns` can take longer in wall time than `--time`. Same seed, same bytes.
- `--decompose`: one pass over the connected components of the link graph among free tickets (largest first; consecutive components are
  grouped until a group has at least 50 tickets). With a single component it does nothing (`polish.skipped: "one component"`).

`polish` in the meta records `method rounds improved components before after` (stage values before and after the polish).

### Measurements (1400-ticket generated instance)

`genPlan({ n: 1400, people: 4, seed: 3, cap: 40, density: 0.175 })`: 9654 links (4797 after reduction), stages `end_sprint` and
`owner_changes` (no `min_per_sprint`, no `minimize_load_of`). Wall-clock budget, 8 workers, 12-core machine, one run per row unless noted, 2026-11-22.
"before" is the solver at the parent commit; "after" is this version. Multi-worker runs vary run to run (two 60 s runs of the old solver gave
327 and 381 owner changes), so differences of a few dozen changes between single runs are noise.

| run | `--time` | end sprint (gap) | owner changes (gap) | polish |
|---|---|---|---|---|
| before | 60 | 32 (15.6%, bound 27) | 327, 381 (100%, bound 0) | - |
| after, default | 60 | 32 (15.6%) | 357, 359 (100%) | - |
| after, `--lns` | 60 | 32 (15.6%; one run: stage UNKNOWN, constructive end kept) | 246, 194 (stage UNKNOWN in both runs: no gap) | 9 / 20 rounds, from 385 / 367 |
| after, `--decompose` | 60 | 32 (15.6%) | 356 (100%) | skipped: one component |
| before | 120 | 32 (15.6%) | 292 (100%) | - |
| after, default | 120 | 32 (15.6%) | 294 (100%) | - |
| after, `--lns` | 120 | 32 (15.6%) | 175 (100%) | 29 rounds, from 377 |

What this shows, and what it does not:
- The anytime callback and the configurable stage order cost nothing measurable here (default runs match the old solver within run-to-run noise).
- `--lns` lowers owner changes by 25-49% at the same budget (194-246 vs 327-381 at 60 s, 175 vs 292 at 120 s). The reported gap of the
  owner-changes stage does not improve: its bound stays 0 (the LP relaxation of "keep everyone on their baseline owner" is near 0), so the gap
  was 100% for any schedule with changes (the 100% figures in the table were measured before that gap was reported as `n/a (bound 0)`); the
  improvement is in the objective, not the proof.
- With `--lns` the end-sprint stage gets half the time; at 60 s it once ended UNKNOWN (no CP-SAT solution within its 13 s, below the about
  12 s presolve plus search) and the constructive end sprint (32, the same value here) was kept. On an instance where CP-SAT improves the end
  sprint only late, `--lns` can end later than the default. The end-sprint gap is 15.6% in every run above where that stage ended FEASIBLE; in the
60 s `--lns` run whose end-sprint stage ended UNKNOWN there is no gap to report (no CP-SAT solution, so no stage bound).
- `--decompose` was not measurable on this instance: its link graph is one component. On a two-component 180-ticket test instance (the `polish`
  test) one deterministic pass lowered owner changes from 76 to 75 while `--lns` reached 54. See the multi-component measurement below.

### Measurements: `--decompose` on a multi-component instance

`node test/bench-decompose.ts TIME SEEDS` builds 8 independent components of 150 tickets (genPlan seeds 100 to 107, 5,031 links) that share
4 people (cap 60), so the components couple only through capacity, and runs each seed monolithic and with `--decompose` (2026-11-22, dev
machine with other load present; wall times are noisy). Stage order: end sprint, then owner changes vs current. Every run proved the end sprint
(15, OPTIMAL) and ended the owner-changes stage FEASIBLE with bound 7: the proof status never differed.

| run | seed | owner changes: monolithic | owner changes: `--decompose` (polish rounds improved) | first CP-SAT write, s (mono / dec) |
|---|---|---|---|---|
| `--deterministic --time 60` | 1, 2, 3 | 268, 268, 268 | 268, 268, 268 (0 of 8 each) | none / none (the constructive start was never beaten) |
| `--deterministic --time 120` | 1 | 268 | 265 (2 of 8) | none / 54.5 |
| `--time 60`, 8 workers | 1 | 143 | 254 (0 of 8) | 12.6 / 20.8 |
| `--time 60`, 8 workers | 2 | 140 | 174 (3 of 8, from 184) | 15.9 / 14.8 |

Decision: `--decompose` stays off by default. It is never worse on correctness (every result is verified, the end sprint and its proof are
the same), but it is not better on time or objective: with a wall-clock budget it was clearly worse (owner changes 254 and 174 against 143 and
140), because a polish phase takes half of the stage budget away from the monolithic owner-changes stage, which improves steadily on this
instance; with a deterministic budget it tied at 60 s and gained 3 owner changes (1%) at 120 s. Its time to the first CP-SAT solution was
not better either (20.8 s vs 12.6 s, 14.8 s vs 15.9 s). It may help when components are large and truly independent (no shared people); that
case is not measured here.

## Environment (PEP 723 notes)

`bin/plangraph-solve` carries an inline script header (`requires-python >=3.10,<3.15`, `ortools==9.15.6755`), so `uv run bin/plangraph-solve ...` also works.
OR-Tools has no wheel for Python 3.15 (verified 2026-11). `bin/plangraph-solve-run` tries, in order: `uv run --locked --script bin/plangraph-solve` (dependencies pinned with hashes in `bin/plangraph-solve.lock`; a stale lock fails instead of re-resolving);
a venv in `<base>/venv` (see "Which uv configuration applies, and the venv base" below) built from python3.14..3.10 (first found) with `pip install --require-hashes -r solver/solver-requirements.txt`; a python3 that already imports ortools;
else prints three lines and exits 3. `PLANGRAPH_SOLVE_SCRIPT` overrides the script (used by the mutation test).

### Which uv configuration applies, and the venv base

| path | runs in | configuration files uv reads | `UV_*` variables |
|---|---|---|---|
| `uv sync --locked --script`, `uv python find --script` (normal path), `uv python find` (interpreter for the fallback) | the plugin's `bin` directory | `uv.toml` or `pyproject.toml` `[tool.uv]` found by uv's walk up from `<plugin>/bin` (none in the plugin tree, and a test keeps it so; the walk reaches only the plugin's parents, which the user owns: `~/.claude/plugins/...` or a checkout), the user's `uv.toml` (`$XDG_CONFIG_HOME/uv/uv.toml` or `~/.config/uv/uv.toml`), the system `uv.toml`, `UV_CONFIG_FILE` | apply |
| `uv run` fallback (an older uv without `sync --script`, or `PLANGRAPH_SOLVE_LAUNCH=uv-run`) | your directory | none from your directory: `--no-config` drops every file; the user's own `uv.toml` comes back through `--config-file` when it exists and `UV_CONFIG_FILE` is unset (an `XDG_CONFIG_HOME` that is not absolute is ignored, since it would resolve in your directory); with `UV_CONFIG_FILE` set, that file applies (uv honors it even with `--no-config`). The system `uv.toml` (`/etc/uv/uv.toml`) is not read on this path | apply |

To use a package mirror on every path, set `UV_INDEX_URL` or `UV_DEFAULT_INDEX` (or `index-url` / `[[index]]` in your own `uv.toml`). Measured with uv
0.8.8 and uv 0.4.30: `uv run --no-config --config-file <user uv.toml>` is accepted, uses the index of that file and ignores a hostile `uv.toml` in
the working directory, and a command-line `--config-file` wins over `UV_CONFIG_FILE`. `--no-config` does not stop uv from taking the interpreter of a
committed `.venv` (every version) or `.python-version` (0.4.30), which is why the fallback also passes an absolute `--python` (above).

The venv base (no uv) is `$CLAUDE_PLUGIN_DATA` when it is an absolute path, else `~/.cache/plangraph` (the rule of `lib/driver.ts`
`defaultDataDir`; a relative value is never used, so `rm -rf` never reaches your directory). Whoever can write the base can plant `venv/bin/python`,
which the launcher would run, so before the venv is first used the base must be a real directory (not a symlink) owned by you without group or
world write; a missing base is created `0700` (`umask 077`). A group- or world-writable `$CLAUDE_PLUGIN_DATA` (Claude Code creates it with the
default mode, so `775` under umask `002`) is not an error: the launcher prints one stderr line and uses `~/.cache/plangraph` instead, and never
changes the other directory (the merge shim of `lib/driver.ts` does the same, decision D19). Any other untrusted base (a symlink, not a
directory, owned by another user, or `~/.cache/plangraph` itself writable by others) exits 3 with one line naming the reason; only the writable
case names the fix, `chmod go-w <dir>`. The check uses `find` and `id`; when either is missing it fails closed. An existing `<base>/venv` and its
`bin` directory must pass the same check before the venv is first used; one that fails (writable by others, a symlink, not a directory) is
removed and rebuilt, and the launcher exits 3 when it cannot be removed. The venv is always built under `umask 077`. Before it looks up any
command, the launcher drops every `PATH` entry that is not absolute (an empty entry, `.`, or a relative directory), since those resolve in your
directory, where a repository could commit an executable `uv` or `python3.14`.

Tests: `node --test test/solver.test.ts` (about 2 to 3 minutes; skips with a message if neither uv nor an ortools python exists).

## Input limits and path confinement

`--workers` is clamped to 1..32 and `--time` to 0..3600 s (0 stays a real value, see above); the same clamp applies to `workers` and `time_limit_seconds` from config.json.
The meta file records the effective `workers` and `time_limit`, plus `clamped: ["workers", "time"]` when a value was changed. `nan` and non-numeric values exit 2 (`--time must be a finite number`); `inf` and integers too large for a float (such as `10**400` in config.json) clamp to the bound and are listed in `clamped`; `-0` is recorded as `0.0`; `--workers` must be a whole number (`8.9` exits 2) and a boolean in config.json exits 2.
Story points, caps and `min_per_sprint` must be at most 1,000,000,000 after scaling to whole numbers (at most 4 decimal places; with 4 places
that is 100,000 story points), so CP-SAT only sees small exact integers: a larger value (such as a cap of `1e300`) exits 2 `MODEL_INVALID: story
points, caps and min_per_sprint must be at most 1000000000 after scaling to whole numbers`. `first_sprint`, `end_sprint` (and `--end`) and
`frozen_before_sprint` must be whole numbers from -1,000,000 to 1,000,000 (an integer: not a float, string or boolean), else exit 2
`MODEL_INVALID: <name> must be a whole number from -1000000 to 1000000`.
`--jsonl-dir` and the plan dir (`.plangraphrc` / `PLANGRAPH_DIR`) are resolved with `realpath` and must sit inside the repository root (`git rev-parse --show-toplevel` of the
current directory, else the current directory): otherwise exit 2 `directory outside the repository`. `--out` (and the meta file) must not be a symlink
(`refusing to write through a symlink`) and its parent directory must resolve inside the root; the same check runs again at write time, so a parent swapped for a symlink after the first check is refused.

Input guards (`load_raw`; tests: `test/plangraph-solve-input.test.ts`, Python unit checks, stdlib only). The index (`plangraph.sqlite` or `--db`)
gets the same guards as the CLI's `openIndex` (`src/db.ts`): it must be a regular file (lstat, then the solver's own
`O_RDONLY|O_NONBLOCK|O_NOFOLLOW` open and fstat with the same device and inode: a symlink or a FIFO is refused, never followed or blocked
on), no SQLite sidecar (`-journal`, `-wal`, `-shm`) may sit beside it (a hot journal would be replayed), it is opened read-only
(`file:...?mode=ro` plus `PRAGMA query_only`), its `sqlite_master` must pass the same schema allowlist as `schemaOk` (a planted view, for
example over an infinite `WITH RECURSIVE`, is refused before any query; the Python lists are compared with `src/db.ts` by a test), and its
content digest must match (the same canonical rows as `contentDigest`; the JSON row text comes from SQLite itself; an index without a digest
is refused). Each refusal exits 2 `MODEL_INVALID: <what>: run \`plangraph build\``. JSONL files and the plan dir's `config.json` are read like
`readDataCapped`: lstat (a symlink is refused), `O_NOFOLLOW|O_NONBLOCK` open, fstat must be a regular file with the lstat's device, inode and
ctime, at most 64 MiB; errors name the base name only. A `--config` named on the command line may be a symlink (it is still regular-file
only and capped). Residual: SQLite opens the index again by path after the check, as in `openIndex`; `.plangraphrc` is still read with a plain
`open()`.

### Limits of the confinement

- `--db` and `--config` are intentionally not confined: they are read-only. They can be used to probe whether a file exists or parses, and an invalid numeric value in a config file is echoed in the error (at most 40 characters, control characters replaced by `?`), so a config pointed at an arbitrary file can leak a short prefix of one value, never more.
- The check on `--out` and the write are separate steps. `check_out` runs first and `atomic_write` re-checks the symlink and the confinement right before the write, which narrows the window but does not close it: the filesystem APIs used (`mkstemp`, `os.replace`) are path based, so a parent directory swapped for a symlink in the instant between that last check and the rename cannot be excluded without directory file descriptors (`openat` with `O_NOFOLLOW`). Not worth the complexity for a tool the repository owner runs on their own checkout; do not rely on it against a hostile process sharing the directory.
- The repository root comes from `git rev-parse --show-toplevel`, so it honours `GIT_DIR`, `GIT_WORK_TREE` and a hostile repository's `core.worktree`. The confinement guards against bad arguments, not against a hostile checkout or environment.
- The anytime restore (put back or remove `--out` when a run ends without a schedule) re-checks `--out` (no symlink, parent inside the root) and
  removes only a regular file, but the check and the `unlink` are separate path-based steps, with the same window as above.
- Setting `PLANGRAPH_SOLVE_SCRIPT` runs the unlocked path and disables locking (test-only override).
- uv's own error text mentions `uv.lock` rather than `plangraph-solve.lock`; it is the same lock (`uv lock --script` writes `bin/plangraph-solve.lock`).

## Where the lock files live

Claude Code exposes every file in `bin/` as a command on PATH, so the hash-pinned pip requirements live in `solver/solver-requirements.txt` (moved out of `bin/`; verified
that `uv export --script bin/plangraph-solve --format requirements-txt --no-header` reproduces it byte for byte and that the fallback's `pip install --require-hashes` builds a working venv from the new path).
`bin/plangraph-solve.lock` has to stay next to the script because `uv lock --script` writes `<script>.lock` and `uv run --locked --script` reads it from there. It is a non-executable data file,
so it is listed by the validator as a `bin` entry but cannot be run as a command. `uv lock --check --script bin/plangraph-solve` passes.

## What the first run downloads

The locked uv path (`uv run --locked --script bin/plangraph-solve`) and the hash-verified pip fallback (`pip install --require-hashes -r solver/solver-requirements.txt`)
fetch the pinned Python packages on first use: `ortools`, `numpy` and their dependencies, at the exact versions listed in `bin/plangraph-solve.lock` and
`solver/solver-requirements.txt`. They come from PyPI (`pypi.org` for the index, `files.pythonhosted.org` for the files) and are cached afterwards (uv cache, or the venv under
`<base>/venv`, see above). If no Python 3.10-3.14 is installed, the `uv run` fallback (an older uv) exits 3 and asks you to run `uv python install 3.14` (it never downloads one); on the normal path uv (default `python-downloads = automatic`; `--no-python-downloads` or `UV_PYTHON_DOWNLOADS=never` turns it off) first downloads a standalone CPython from the Astral `python-build-standalone` project:
`github.com` (release download URL), which redirected to `release-assets.githubusercontent.com` when checked on 2026-11-22 (that CDN host is GitHub's choice and may change). The pip fallback uses only the default PyPI index and never downloads a Python.
These four hosts, plus the two Jira hosts, are what `network.hosts` in `.claude-plugin/plugin.json` declares. Nothing else leaves the machine: no ticket data, no telemetry. This is the only network access the solver ever makes.
A cold first run took about 27 s on a fast connection (one measurement in an isolated cache; it is network-bound, so a slow connection takes longer); later runs reuse the cache.
To pre-fetch in CI (or before going offline): `uv run --locked --script bin/plangraph-solve --help`.

## Refreshing the locked dependencies

After changing the pin in `bin/plangraph-solve`: `uv lock --script bin/plangraph-solve && uv export --script bin/plangraph-solve --format requirements-txt --no-header > solver/solver-requirements.txt`
(uv 0.8.8: hashes are emitted by default; the flag is `--hashes`/`--no-hashes`, not `--hash`). Commit both files.
