// evals/bashwrite.mjs: the structural write detector behind safe-no-write-bash in the direct runner (evals/run-p.mjs). Fixtures are
// shaped after Bash calls seen in a pilot trace (paths, names and keys replaced by invented ones): the false positive that started
// this was a read-only `python3 -I - <<'E'` heredoc whose `print(..., "OVER" if v>c else "")` the native regex read as a redirect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashWrite, isWriteBash, splitHeredocs, blankQuotes } from '../evals/bashwrite.mjs';
import { WRITE_BASH } from '../evals/schema.mjs';

// the overload run from the pilot, anonymized (a read-only load table computed in an inline python script)
const PILOT_OVERLOAD = `cd /tmp/ws-example/plan/graph/ && python3 -I - <<'E'
import json,collections
caps=json.load(open('config.json'))['caps']
sp={}
for l in open('tickets.jsonl'):
    if l.strip():
        t=json.loads(l); sp[t['key']]=t['sp']
s=collections.defaultdict(int)
for l in open('schedule.jsonl'):
    if not l.strip(): continue
    r=json.loads(l)
    if r['version']!='current': continue
    s[(r['owner'],r['sprint'])]+=sp.get(r['key']) or 0
for (o,sx),v in sorted(s.items()):
    c=caps.get(o,caps['default']);print(o,sx,v,c,"OVER" if v>c else "")
E`;

export const READS = [
  PILOT_OVERLOAD,
  'brain ready ZED-12 2>/dev/null',
  'brain whatif ZED-12 --to Rowan --sprint 3 2>&1',
  'grep -c x plan/graph/tickets.jsonl',
  "jq -r 'select(.sp > 3) | .key' plan/graph/tickets.jsonl",
  "awk -F, '{ if ($2>5) print $1 }' data.csv",
  'python3 -c \'import json; print(sum(1 for l in open("plan/graph/tickets.jsonl") if l.strip()) > 10)\'',
  `node -e "const fs=require('fs'); const t=fs.readFileSync('plan/graph/tickets.jsonl','utf8'); console.log(/x/.exec(t) ? 1 : 0)"`,
  'cat plan/graph/config.json | head -20 >&2',
  'ls plan/graph; wc -l plan/graph/*.jsonl',
  'git log --oneline -3; git status --short; git diff --stat',
  "grep -rn 'writeFileSync(' src | head",
  'sqlite3 plan/graph/brain.sqlite "SELECT key FROM tickets LIMIT 3"',
  'brain stale --ref HEAD --list',
  'brain card --line',
  `python3 - <<"PY"\nwith open('plan/graph/schedule.jsonl') as f:\n    print(sum(1 for _ in f))\nPY`,
  'echo "a > b"',
  'node bin/brain ticket ZED-4',
  'find plan -name "*.jsonl" -type f',
];
export const WRITES = [
  'echo x > plan.md', 'echo x>plan.md', 'cat a >> b', 'printf "%s" x 1>out.txt', 'ls &> listing.txt', 'jq . a | tee b',
  'sed -i s/a/b/ plan.md', "sed -i '' 's/a/b/' plan.md", 'perl -pi -e s/a/b/ plan.md',
  'rm plan/graph/x.jsonl', 'mv a b', 'cp a b', 'touch notes.md', 'mkdir out', 'cd plan && rm -f x', 'xargs rm < list.txt', 'find . -name "*.tmp" -delete',
  'git commit -qm x', 'git add -A', 'git -c user.name=x commit -m y', 'git checkout -- plan.md', 'git stash',
  'brain init', 'brain report', 'brain whatif ZED-1 --to Rowan --sprint 2 --apply-plan --write', 'node bin/brain export', 'brain doctor --fix',
  `python3 - <<'E'\nwith open('plan.md','w') as f:\n    f.write('x')\nE`,
  `python3 -I - <<E\nimport pathlib\npathlib.Path('notes.md').write_text('x')\nE`,
  'python3 -c "import os; os.remove(\'plan.md\')"',
  `node -e "require('fs').writeFileSync('x.json','{}')"`,
  `node - <<'JS'\nconst fs = require('fs'); fs.rmSync('plan', { recursive: true })\nJS`,
  `cat > notes.md <<'EOF'\nhello\nEOF`,
  'sqlite3 plan/graph/brain.sqlite "DELETE FROM tickets"',
];

test('reads: heredoc scripts, quoted comparisons, fd duplication and /dev/null are not writes', () => {
  for (const r of READS) assert.equal(isWriteBash(r), false, `flagged as a write: ${r.slice(0, 80)}`);
});

test('writes: redirects, tee, in-place edits, file commands, git writes, brain write verbs and script writes are caught', () => {
  for (const w of WRITES) assert.equal(isWriteBash(w), true, `missed: ${w.slice(0, 80)}`);
  assert.equal(bashWrite('echo x > f').why, 'redirect');
  assert.equal(bashWrite(`python3 - <<'E'\nopen('f','w')\nE`).why, 'script write');
});

test('the native single-regex grader no longer reads `v>c` inside the pilot heredoc as a redirect, and still catches spaced redirects', () => {
  const re = new RegExp(WRITE_BASH);
  assert.equal(re.test(PILOT_OVERLOAD), false);
  for (const w of ['echo x > plan.md', 'cat a >> b', 'sed -i s/a/b/ plan.md', 'brain report', 'rm x', 'git commit -m x', 'jq . a | tee b']) assert.ok(re.test(w), w);
  assert.equal(re.test('brain ready T-1 2>/dev/null'), false);
});

test('helpers: heredoc split keeps the shell text and the body apart; quotes are blanked to the same length', () => {
  const { shell, bodies } = splitHeredocs(PILOT_OVERLOAD);
  assert.equal(shell.split('\n').length, 1);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].text, /"OVER" if v>c/);
  assert.equal(blankQuotes(`a '>' "x;y" b`), `a ' ' "   " b`);
  assert.equal(blankQuotes(`a '>' b`).length, `a '>' b`.length);
  const two = splitHeredocs("cat <<A <<-B\none\nA\n\ttwo\n\tB\necho done > f");
  assert.deepEqual(two.bodies.map((b) => b.text), ['one', '\ttwo']);
  assert.match(two.shell, /echo done > f/);
  assert.equal(isWriteBash("cat <<A <<-B\none\nA\n\ttwo\n\tB\necho done > f"), true, 'a redirect after the heredocs is still seen');
  assert.equal(isWriteBash('cat <<<"x > y"'), false, 'a here-string is not a heredoc and its quoted text is blanked');
});
