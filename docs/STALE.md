# Incremental re-audit (lib/stale.mjs)

Goal: `brain stale` lists exactly the tickets whose verdict no longer matches its inputs, provably equal to a full re-derivation (`test/stale.test.mjs`, differential test against an independent oracle).

## What counts as an input (declared = read)
Per audited ticket (a `refs` row): (1) plan: normalized text of each `{plan, task}` section at the ref, mixed with the heading regex; (2) files: blob ids of `files` at the ref (absent is a value); (3) jira: the `updated` stamp; (4) links: sorted, deduplicated Jira link set (`deps.linkSet`), covers link edits that may not bump `updated` (unverified in Jira); (5) rules: `brain_rules_version` (`opts.rulesVersion`); plus the plan-graph structure (producer list).
An input whose dep returns `null`/`undefined` (no Jira snapshot, no rules version) is "not checked": never a change, and the old record is kept by `refs-update`. The CLI must print what was not checked.

## Producers (transitive)
Each row stores `fp_prods`: per direct producer, a Merkle digest of its whole producer cone per input class (SCC-condensed, so cycles terminate and members share a digest). A ticket is stale when (a) an own input differs, (b) a recorded producer digest differs or the producer set changed, or (c) any producer is stale (closure over `prods`, any depth). So re-auditing a producer alone never hides its change from consumers, and re-auditing a consumer while its producer is still stale leaves it stale. Reason `producer_changed`, `via` = nearest stale producer (fewest hops, ties by smallest key); a node with only digest mismatches gets the smallest mismatched producer. Rows without `fp_prods` (legacy) that have producers are stale (safe direction, one-time cost). The graph comes only from `model.prods` (sorted, deduplicated): edge order cannot matter.

## Normalization (decision)
CRLF/CR to LF, BOM dropped, trailing spaces/tabs per line removed, trailing blank lines removed. Indentation, inner blank lines, wording, reflow are significant: a semantic edit never hides as formatting. Changing it invalidates stored fingerprints (golden test pins the algorithm; hash is sha256 truncated to 16 hex).

## API
- `fingerprintTicket(row, deps, {ref, heading, rulesVersion}) -> {plans:[{plan,task,fp}], fp_files, jira_updated, fp_links, rules}`
- `computeStale(model, refs, deps, {ref, heading, rulesVersion, full}) -> {stale:[{key, reasons, via}], clean, ref}`; reasons in order `plan files jira links rules full producer_changed`; `full` is the escape hatch (`--full`: everything stale). `clean` = audited tickets not stale. Stale list also includes unaudited tickets reached by propagation (they carry no record, so only `producer_changed`).
- `refsUpdate(model, refs, deps, opts, keys|null) -> {rows, updated, skipped}`; keys null = all stale tickets that have a row; rows sorted, canonical field order, extra fields `fp_links rules fp_prods` (the integrator must persist them in `refs.jsonl` and the `ref` table).
- `resolveRef(config, flag)`: flag, else `config.default_ref`, else `HEAD`. `formatStale(res, {list,json,limit,commit,jiraChecked,linksChecked})` always prints the ref. `staleKeys(res, exclude)`: ONE set for `stale` and `units --stale` (exclude e.g. Done tickets after propagation).
- `gitDeps(repoRoot, ref, {jira})`: `git show`/`ls-tree` with per-instance caches (create a fresh instance per command; a moving ref like HEAD is read once per instance). Jira snapshot `{KEY:{updated, links|blockedBy, status}}`.

## CLI wiring (bin/brain, integrator)
```
const ref = resolveRef(config(), opt('ref')); const deps = gitDeps(ROOT, ref, { jira: opt('jira') && rj(opt('jira')) });
const res = computeStale(model, model.refs, deps, { ref, heading: config().ref_heading, rulesVersion: config().brain_rules_version, full: has('full') });
process.stdout.write(formatStale(res, { list: has('list'), json: has('json'), commit: deps.commit(ref), jiraChecked: !!opt('jira') }));
```
`brain refs-update [KEY...] [--ref R] [--jira f]`: `refsUpdate(model, model.refs, deps, {ref, ..., commit: deps.commit(ref)}, keys.length ? keys : null).rows` written as JSONL. `units --stale`: `keys = staleKeys(res, doneSet)` from the same `computeStale` call (no second implementation). Example (about 25 tokens): `stale vs origin/dev (a1b2c3d): 3 of 120 need re-audit {"plan":1,"producer_changed":2}`.
