#!/usr/bin/env bash
# Smoke test on synthetic data (no real project data). Usage: PYTHON=/path/to/python-with-ortools test/smoke.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BRAIN="$HERE/bin/brain"
SOLVE="$HERE/bin/brain-solve"
PY="${PYTHON:-python3}"
T="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$(mktemp -d)" # never the real data dir
cd "$T"
git init -q
git config user.name tester && git config user.email tester@example.invalid
mkdir docs
printf '# Plan\n\n### Task 1: first\nbuild a\n\n### Task 2: second\nbuild b using a\n' > docs/plan.md
git add -A && git commit -qm base

fail() { echo "FAIL: $1"; exit 1; }

"$BRAIN" init >/dev/null
git config --get merge.brain-jsonl.driver | grep -q "^$CLAUDE_PLUGIN_DATA/bin/brain-merge " || fail "init did not install the stable shim"
printf '%s\n' \
  '{"key":"T-1","summary":"first","epic":"E","sp":3,"jira_status":"To Do","v2_owner":"Ana","v2_sprint":1,"verdict":"READY","verdict_source":"audit","first_verdict":"READY"}' \
  '{"key":"T-2","summary":"second","epic":"E","sp":5,"jira_status":"To Do","v2_owner":"Ben","v2_sprint":2,"verdict":"READY","verdict_source":"audit","first_verdict":"READY"}' \
  '{"key":"T-3","summary":"third","epic":"E","sp":8,"jira_status":"To Do","v2_owner":"Ana","v2_sprint":3,"verdict":"BLOCKED","verdict_source":"refute","first_verdict":"BLOCKED"}' > .brain/tickets.jsonl
printf '%s\n' \
  '{"consumer":"T-2","producer":"T-1","kind":"plan_need","note":""}' \
  '{"consumer":"T-3","producer":"T-2","kind":"plan_need","note":""}' > .brain/edges.jsonl
printf '%s\n' \
  '{"version":"current","key":"T-1","owner":"Ana","sprint":1}' \
  '{"version":"current","key":"T-2","owner":"Ben","sprint":2}' \
  '{"version":"current","key":"T-3","owner":"Ana","sprint":3}' > .brain/schedule.jsonl
printf '{"key":"T-1","plans":[{"plan":"docs/plan.md","task":"1","fp":""}],"files":{},"fp_files":"","jira_updated":"","audited_at":"base"}\n' > .brain/refs.jsonl
"$BRAIN" refs-update --ref HEAD >/dev/null

"$BRAIN" build | grep -q "3 tickets, 2 links" || fail build
"$BRAIN" check | grep -q "strict-rule violations 0" || fail check
"$BRAIN" neighbors T-3 2 | grep -q "T-1" || fail neighbors
"$BRAIN" chain T-3 | grep -q "2 hops" || fail chain
"$BRAIN" sprint 2 | grep -q "Ben: 5 SP" || fail sprint
"$BRAIN" blockers | grep -q "BLOCKED (1): T-3" || fail blockers
"$BRAIN" rules | grep -q "solver" || fail rules
"$BRAIN" card --write >/dev/null && grep -q "3 tickets" .brain/CARD.md || fail card
"$BRAIN" card --if-present | grep -q "3 tickets" || fail "session-start hook command"
"$BRAIN" stale --ref HEAD | grep -q ": 0 of " || fail stale-clean
printf '\n### Task 3: third\n' >> docs/plan.md && sed -i.bak 's/build a$/build a differently/' docs/plan.md && git add -A && git commit -qm change
"$BRAIN" stale --ref HEAD | grep -qE ": [123] of " || fail stale-detects-change
# audit preparation: bundle, units, jira-text
"$BRAIN" bundle T-1 --ref HEAD | grep -q "build a" || fail bundle-plan-text
"$BRAIN" bundle T-2 --ref HEAD | grep -q "T-1 S1/Ana" || fail bundle-needs-positions
"$BRAIN" units --keys T-1,T-2,T-3 --size 2 --ref HEAD --out units | grep -q "2 units" || fail units
[ -f units/u001.md ] && [ -f units/u002.in.json ] && [ -f units/units.json ] || fail units-files
printf '{"fields":{"summary":"s","status":{"name":"To Do"},"updated":"2026-01-01","description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Do the thing"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"item one"}]}]}]}]},"comment":{"comments":[{"author":{"displayName":"Ana"},"created":"2026-01-02","body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"blocked until T-1"}]}]}}]}}}' > issue.json
"$BRAIN" jira-text T-9 --from-json issue.json --out texts >/dev/null && grep -q "Do the thing" texts/T-9.txt && grep -q "item one" texts/T-9.txt && grep -q "blocked until T-1" texts/T-9.txt || fail jira-text
# definition of ready
"$BRAIN" ready T-1 | grep -q "READY TO START T-1" || fail ready-yes
if "$BRAIN" ready T-2 >/dev/null 2>&1; then fail ready-should-fail-while-producer-open; fi
{ "$BRAIN" ready T-2 || true; } | grep -q "waits for T-1" || fail ready-reason
{ "$BRAIN" ready T-3 || true; } | grep -q "verdict is BLOCKED" || fail ready-verdict
# new commands on the valid plan
"$BRAIN" verify | grep -q "OK plan valid (3 tickets)" || fail verify-ok
{ "$BRAIN" whatif T-2 --sprint 1 || true; } | grep -q "^NO:" || fail whatif-rejects-too-early
"$BRAIN" whatif T-3 --sprint 4 | grep -q "^OK:" || fail whatif-accepts-later
"$BRAIN" open-items | grep -q "open items" || fail open-items
# findings come from a file (no command execution): ingest, report bad lines with file:line, and a hostile config.checks is never run
printf '%s\n' '{"key":"T-1","kind":"export_clash","text":"two exports"}' 'not json' > f.jsonl
{ "$BRAIN" open-items --findings f.jsonl 2>err.txt || true; } | grep -q "export_clash" || fail open-items-findings-file
grep -q "f.jsonl:2" err.txt || fail open-items-findings-error-line
# bad --findings arguments and oversized input are refused cleanly (exit 2, short message, no stack trace)
chk() { want="$1"; shift; set +e; out="$("$BRAIN" open-items "$@" 2>&1 </dev/null)"; rc=$?; set -e; [ "$rc" = "2" ] || fail "open-items $* exit $rc"; [ "$out" = "$want" ] || fail "open-items $*: got: $out"; }
TRY_OI="$(printf '\ntry: brain explain open-items')"
chk "error: --findings needs a file path (or - for stdin)$TRY_OI" --findings
chk "error: --findings needs a file path (or - for stdin)$TRY_OI" --findings ""
chk "error: --findings needs a file path (or - for stdin)$TRY_OI" --findings --write
chk "error: cannot read nope.jsonl$TRY_OI" --findings /no/such/dir/nope.jsonl
head -c 9437185 /dev/zero | tr '\0' 'x' > big.jsonl
set +e; out="$("$BRAIN" open-items --findings big.jsonl 2>&1)"; rc=$?; set -e
[ "$rc" = "2" ] || fail "oversized findings exit $rc"; case "$out" in *"too large"*) ;; *) fail "oversized findings message: $out";; esac
[ "$(printf '%s' "$out" | wc -l)" -le 1 ] || fail "oversized findings message not short"
set +e; out="$("$BRAIN" open-items --findings - 2>&1 <big.jsonl)"; rc=$?; set -e
[ "$rc" = "2" ] || fail "oversized stdin exit $rc"; case "$out" in *"too large"*) ;; *) fail "oversized stdin message: $out";; esac
printf '%s\n' '{"key":"T-1","kind":"export_clash","text":"two exports"}' | "$BRAIN" open-items --findings - 2>/dev/null | grep -q export_clash || fail stdin-findings
# a device is refused as "not a regular file" and returns promptly (the old stat-then-read hung while allocating)
if command -v timeout >/dev/null 2>&1; then TMO="timeout 10"; elif command -v perl >/dev/null 2>&1; then TMO="perl -e 'alarm 10; exec @ARGV' --"; else TMO=""; echo "skipped /dev/zero check (no timeout or perl)"; fi
if [ -n "$TMO" ]; then
  set +e; out="$(eval "$TMO" '"$BRAIN"' open-items --findings /dev/zero 2>&1 </dev/null)"; rc=$?; set -e
  [ "$rc" = "2" ] || fail "--findings /dev/zero exit $rc"
  [ "$out" = "error: findings path is not a regular file$TRY_OI" ] || fail "--findings /dev/zero message: $out"
fi
rm -f big.jsonl
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(".brain/config.json","utf8"));c.checks=[{name:"x",command:"touch SHOULD_NOT_EXIST"}];fs.writeFileSync(".brain/config.json",JSON.stringify(c))'
"$BRAIN" open-items >/dev/null 2>&1 || true
[ ! -e SHOULD_NOT_EXIST ] || fail "config.checks was executed"
"$BRAIN" migrate | grep -q "up to date" || fail migrate-up-to-date
"$BRAIN" doctor | grep -q "merge driver: ok" || fail doctor
"$BRAIN" forecast | grep -q "REFUSED" || fail forecast-refuses-without-history
"$BRAIN" sprint 2 --json | grep -q '"v":2' || fail json-envelope
# a schedule with an owner who is not a plan person must be refused
printf '[{"item":"T-1","owner":"Ghost","sprint":1}]' > bad.json
if "$BRAIN" schedule-load bad.json x >/dev/null 2>&1; then fail "ghost owner accepted"; fi
# violation is caught: put the consumer before its producer
printf '[{"item":"T-1","owner":"Ana","sprint":2},{"item":"T-2","owner":"Ben","sprint":2},{"item":"T-3","owner":"Ana","sprint":3}]' > viol.json
"$BRAIN" schedule-load viol.json v-old >/dev/null
{ "$BRAIN" check || true; } | grep -q "strict-rule violations 1" || fail violation-detected
if "$BRAIN" check >/dev/null 2>&1; then fail "check must exit 1 on a violation"; fi
# a corrupt line is reported as file:line and the old index survives a failed build
cp .brain/brain.sqlite keep.sqlite
printf '%s\n' '{"key":"T-9"' >> .brain/tickets.jsonl
{ "$BRAIN" build 2>&1 || true; } | grep -q "tickets.jsonl:4:" || fail build-error-has-line
cmp -s .brain/brain.sqlite keep.sqlite || fail "failed build must keep the old index"
ls .brain | grep -q "tmp-" && fail "failed build left a temp file"
sed -i.bak '$d' .brain/tickets.jsonl && rm -f .brain/tickets.jsonl.bak
"$BRAIN" build >/dev/null || fail rebuild-after-fix
# solver repairs it (needs uv or a python with ortools; the launcher exits 3 when neither exists)
cat > .brain/config.json <<'E'
{"first_sprint":1,"end_sprint":4,"caps":{"default":20},"min_per_sprint":{},"minimize_load_of":"Ben","ignore_link_kinds":[],"time_limit_seconds":20,"workers":2}
E
set +e; "$HERE/bin/brain-solve-run" --out solved.json --time 20 | tail -1; rc=${PIPESTATUS[0]}; set -e
if [ "$rc" = "3" ]; then echo "skipped solver test (no uv and no python with ortools)"
else
  [ "$rc" = "0" ] || fail "solver exit code $rc"
  "$BRAIN" verify solved.json | grep -q "OK plan valid" || fail solver-output-verifies
  "$BRAIN" schedule-load solved.json v-solved >/dev/null && "$BRAIN" check | grep -q "strict-rule violations 0" || fail solver
fi
# integrations: exits 0 with a fake HOME that has no plugins, and reports every tool as absent
FAKEHOME="$(mktemp -d)"
HOME="$FAKEHOME" "$BRAIN" integrations > integrations.out || fail integrations-exit
grep -q "^superpowers: absent$" integrations.out || fail integrations-superpowers-absent
grep -q "^gitkraken: absent$" integrations.out || fail integrations-gitkraken-absent
# superpowers ingest on the synthetic fixtures: one summary line, idempotent, a loud failure exits 2 and writes nothing
FX="$HERE/test/fixtures/superpowers"; SPP=docs/superpowers/plans/2026-11-20-widget-export.md
mkdir -p docs/superpowers/plans docs/superpowers/specs .superpowers/sdd/2026-11-20-widget-export
cp "$FX/plans/2026-11-20-widget-export.md" docs/superpowers/plans/ && cp "$FX/specs/2026-11-20-widget-export-design.md" docs/superpowers/specs/
cp "$FX/ledger-7x/progress.md" "$FX/ledger-7x/plan-path" .superpowers/sdd/2026-11-20-widget-export/
"$BRAIN" sp-ingest "$SPP" | grep -qx "ingested sp:2026-11-20-widget-export: 3 tasks, 2 edges, 6 findings, 3 statuses from ledger" || fail sp-ingest
cat .brain/tickets.jsonl .brain/edges.jsonl .brain/findings.jsonl .brain/refs.jsonl > sp1.txt
"$BRAIN" sp-ingest "$SPP" >/dev/null || fail sp-ingest-again
cat .brain/tickets.jsonl .brain/edges.jsonl .brain/findings.jsonl .brain/refs.jsonl | cmp -s - sp1.txt || fail sp-ingest-idempotent
cp "$FX/negative/1-unclosed-fence.md" docs/superpowers/plans/neg.md
set +e; out="$("$BRAIN" sp-ingest docs/superpowers/plans/neg.md --ledger none 2>&1)"; rc=$?; set -e
[ "$rc" = "2" ] || fail "sp-ingest unclosed fence exit $rc"; case "$out" in "error: "*"unclosed fence"*) ;; *) fail "sp-ingest unclosed fence message: $out";; esac
cat .brain/tickets.jsonl .brain/edges.jsonl .brain/findings.jsonl .brain/refs.jsonl | cmp -s - sp1.txt || fail sp-ingest-loud-failure-wrote
"$BRAIN" sp-link T-1 "$SPP" --tasks 1 | grep -q "^linked T-1 to $SPP: 1 task$" || fail sp-link
"$BRAIN" build | grep -q "tickets" || fail sp-build
# sp: keys are implementation tasks: unplaced ones do not fail verify, and ready reads impl_status from the ledger
"$BRAIN" verify | grep -q "^OK plan valid" || fail sp-verify-unplaced-ok
"$BRAIN" ready sp:2026-11-20-widget-export/3 | grep -qx "READY TO START sp:2026-11-20-widget-export/3" || fail sp-ready-impl-status
# a task hidden in an HTML comment is never silent (shown without -v)
mkdir -p docs/superpowers/plans
printf '# Hidden Demo Implementation Plan\n\n### Task 1: a\nbody\n\n<!--\n### Task 2: hidden\nbody\n-->\n\n### Task 3: c\nbody\n' > docs/superpowers/plans/2026-11-22-hidden-demo.md
"$BRAIN" sp-ingest docs/superpowers/plans/2026-11-22-hidden-demo.md --ledger none | grep -q "swallows a task heading" || fail sp-hidden-task-warning-visible
# unknown record fields survive build then export (kept in the index extra column), and a SQL-looking key is only data
cp .brain/tickets.jsonl keep-tickets.jsonl
printf '%s\n' '{"key":"X-9","summary":"x","zz_unknown":{"b":1,"a":[2]},"summary) VALUES(1,2);--":"v"}' >> .brain/tickets.jsonl
"$BRAIN" build | grep -q "tickets" || fail build-unknown-fields
"$BRAIN" export >/dev/null
grep -q '"zz_unknown":{"a":\[2\],"b":1}' .brain/tickets.jsonl || fail unknown-field-roundtrip
grep -q '"summary) VALUES(1,2);--":"v"' .brain/tickets.jsonl || fail sql-key-roundtrip
cp keep-tickets.jsonl .brain/tickets.jsonl && "$BRAIN" build >/dev/null && "$BRAIN" export >/dev/null

# OpenWolf read-through on the synthetic fixtures: rules --repo shows stable handles and is fenced, card --line is one line, learn refuses a bare number
WFX="$HERE/test/fixtures/openwolf"; mkdir -p .wolf && cp "$WFX/cerebrum.drifted.md" .wolf/cerebrum.md && cp "$WFX/status.handoff.md" .wolf/STATUS.md
"$BRAIN" rules --repo > wolf-rules.out || fail rules-repo-exit
grep -qE '^w[0-9a-f]{6} \[wolf:do-not-repeat\] 2031-04-02 ' wolf-rules.out || fail rules-repo
grep -q '^<untrusted src="wolf-do-not-repeat"' wolf-rules.out || fail rules-repo-fenced
"$BRAIN" card --line > card-line.out || fail card-line-exit
grep -qE '^brain: [0-9]+ tickets, last sprint [0-9]+, [0-9]+ violations @[0-9a-f]{8}$' card-line.out || fail card-line
[ "$(wc -l < card-line.out | tr -d ' ')" = "1" ] || fail card-line-one-line
cp .brain/learnings.jsonl learn-before.jsonl
set +e; out="$("$BRAIN" learn --from-wolf 99 2>&1)"; rc=$?; set -e
[ "$rc" = "2" ] || fail "learn number exit $rc"; [ "$out" = "$(printf '%s\n%s' 'error: a position number is not accepted (positions shift): use the handle from `brain rules --repo` or the exact text' 'try: brain explain learn')" ] || fail "learn number message: $out"
cmp -s .brain/learnings.jsonl learn-before.jsonl || fail learn-number-wrote
echo "OK: all smoke checks passed in $T"
