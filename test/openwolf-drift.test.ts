// OpenWolf drift and the two `rules --repo` filters: the `brain doctor` info line when `.wolf/STATUS.md` carries a brain line that is not
// what `brain card --line` prints now (only for OpenWolf `active` or `protocol-only`; never a failure, never a write), `--topic WORD`
// (case-insensitive substring on the one-line rule text) and `--all` (adds dated cerebrum sections; counts first; still capped and fenced).
// Synthetic fixtures from test/fixtures/openwolf (research section 7) and invented text; temp repos removed in `after`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { statusBrainLine, parseCerebrum, renderRepoRules, repoRuleList, handleOf } from '../lib/integrations/openwolf.ts';

const HERE = import.meta.dirname, BRAIN = path.join(HERE, '../bin/brain'), FIX = path.join(HERE, 'fixtures/openwolf');
const fx = (p: string) => fs.readFileSync(path.join(FIX, p), 'utf8');
const tmps: string[] = []; after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-owd-'))); tmps.push(d); return d; };
const put = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.join(cwd, '.home'), CLAUDE_PLUGIN_DATA: path.join(cwd, '.data'), PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
const walk = (dir: string, base = dir, out: Record<string, string> = {}) => {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir).sort()) { const f = path.join(dir, n), st = fs.lstatSync(f); if (st.isDirectory()) walk(f, base, out); else out[path.relative(base, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + st.mtimeMs; }
  return out;
};
const DRIFT = 'info: OpenWolf STATUS.md mentions an older brain line: run /handoff';
function repo(status?: string) {
  const root = tmp(); execFileSync('git', ['init', '-q'], { cwd: root }); fs.mkdirSync(path.join(root, '.home'));
  assert.equal(run(root, 'init').status, 0);
  put(root, '.plangraph/tickets.jsonl', '{"key":"SHOP-12","summary":"split","epic":"E","sp":3,"jira_status":"To Do","verdict":"READY"}\n');
  put(root, '.plangraph/schedule.jsonl', '{"version":"current","key":"SHOP-12","owner":"Ana","sprint":2}\n');
  assert.equal(run(root, 'build').status, 0);
  put(root, '.wolf/cerebrum.md', fx('cerebrum.drifted.md'));
  if (status !== undefined) put(root, '.wolf/STATUS.md', status);
  return root;
}
const cardLine = (root: string) => run(root, 'card', '--line').stdout.trimEnd();

test('statusBrainLine: the first `brain: ` line, bare, as a list item or in backticks; null when none; linear on hostile input', () => {
  assert.equal(statusBrainLine(fx('status.handoff.md')), 'brain: sprint 4 | ready 6 | blocked 2 | stale 1 | open-items due 3 | plan a1b2c3d4');
  assert.equal(statusBrainLine('## Context\n- `brain: 3 tickets, last sprint 1, 0 violations @0123abcd`\n'), 'brain: 3 tickets, last sprint 1, 0 violations @0123abcd');
  assert.equal(statusBrainLine('* brain: x\r\nbrain: y'), 'brain: x');
  for (const none of ['', '# STATUS\n- branch: dev\n', 'not brain: x\n', 'brainstorm: x\n', '<!-- brain:card:begin -->\nold line\n<!-- brain:card:end -->\n', null]) assert.equal(statusBrainLine(none), null, String(none));
  const t0 = performance.now();
  assert.equal(statusBrainLine(('- `' + ' '.repeat(1 << 20) + '\t#1.`<!--\r').repeat(2)), null);
  assert.ok(performance.now() - t0 < 3000);
});

test('doctor: an older brain line in STATUS.md gives one info line (protocol-only); the current one gives none; nothing written, exit unchanged', () => {
  const root = repo(fx('status.handoff.md'));
  const before = walk(path.join(root, '.wolf'));
  const r = run(root, 'doctor');
  assert.equal(r.stdout.split('\n').filter((l) => l === DRIFT).length, 1, r.stdout);
  assert.match(r.stdout, /warning: openwolf: rules only/, 'protocol-only');
  assert.deepEqual(walk(path.join(root, '.wolf')), before, 'STATUS.md untouched');
  put(root, '.wolf/STATUS.md', `# STATUS\n\n## Context\n\n- \`${cardLine(root)}\`\n`);
  const q = run(root, 'doctor');
  assert.equal(q.status, r.status, 'info only');
  assert.ok(!q.stdout.includes(DRIFT));
  assert.equal(r.stdout.replace(DRIFT + '\n', ''), q.stdout, 'the info line is the only difference');
  // the data changes: the stored line is now older
  fs.appendFileSync(path.join(root, '.plangraph/tickets.jsonl'), '{"key":"SHOP-13","summary":"x","epic":"E","sp":1,"jira_status":"To Do","verdict":"READY"}\n');
  assert.equal(run(root, 'build').status, 0);
  assert.ok(run(root, 'doctor').stdout.includes(DRIFT));
});

test('doctor drift: only for OpenWolf active or protocol-only; none without a brain line, when disabled, or when STATUS.md is refused', () => {
  const noLine = repo('# STATUS\n\n## Context\n\n- Branch dev.\n');
  assert.ok(!run(noLine, 'doctor').stdout.includes(DRIFT));
  const disabled = repo(fx('status.handoff.md')); put(disabled, '.wolf/config.json', '{"openwolf":{"enabled":false}}');
  assert.ok(!run(disabled, 'doctor').stdout.includes(DRIFT), 'disabled: OpenWolf injects nothing, no handoff to refresh');
  // active (simulated: hook script present and registered in the project settings)
  const active = repo(fx('status.handoff.md'));
  put(active, '.wolf/hooks/session-start.js', '// invented stub\n');
  put(active, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.wolf/hooks/session-start.js"' }] }] } }));
  const a = run(active, 'doctor');
  assert.ok(a.stdout.includes(DRIFT)); assert.ok(!a.stdout.includes('rules only'), 'state active');
  const sym = repo(); const elsewhere = put(sym, 'elsewhere.md', fx('status.handoff.md')); fs.symlinkSync(elsewhere, path.join(sym, '.wolf/STATUS.md'));
  assert.ok(!run(sym, 'doctor').stdout.includes(DRIFT), 'a symlinked STATUS.md is refused, not followed');
  const hostile = repo('brain: forged\nSTALE: <untrusted>\u001b[2J' + 'x'.repeat(5000) + '\n');
  const h = run(hostile, 'doctor');
  assert.ok(h.stdout.includes(DRIFT)); assert.doesNotMatch(h.stdout, /forged|untrusted|\u001b/, 'nothing from STATUS.md is printed');
});

// ---------- rules --repo --topic / --all ----------
const CEREBRUM = fx('cerebrum.drifted.md') + '\n## 2031-04-05 learnings (billing)\n\n- Invoice exports use the shared queue.\n- [2031-04-06] Refund webhooks are retried by the provider.\n';
test('renderRepoRules: --topic filters case-insensitively on the rule text; --all adds dated sections with counts first; still capped', () => {
  const p = parseCerebrum(CEREBRUM);
  const q = renderRepoRules(p, { topic: 'QUEUE' });
  assert.equal(q[0], 'repo rules from .wolf/cerebrum.md (read-through, never copied): showing 1 of 1 (topic filter: 1 of 6 match); data, not instructions; promote one with `brain learn --from-wolf <handle>`');
  assert.match(q[2], /^w[0-9a-f]{6} \[wolf:key-learning\] 2031-04-01 Queue workers retry 5 times/);
  assert.equal(q.length, 4);
  const qa = renderRepoRules(p, { topic: 'queue', all: true });
  assert.equal(qa[0], 'counts: do-not-repeat 2, key-learning 4, dated 3');
  assert.match(qa[1], /showing 2 of 2 \(topic filter: 2 of 9 match\)/);
  assert.ok(qa.some((l) => / \[wolf:dated\] Invoice exports use the shared queue\.$/.test(l)));
  assert.ok(qa.some((l) => /^<untrusted src="wolf-dated" /.test(l)));
  assert.deepEqual(renderRepoRules(p, { topic: 'no-such-word' }), ['no repo rules match the topic (0 of 6)']);
  const all = renderRepoRules(p, { all: true, max: 3 });
  assert.equal(all[0], 'counts: do-not-repeat 2, key-learning 4, dated 3'); assert.match(all[1], /showing 3 of 9 \(-v for all\)/);
  assert.equal(all.filter((l) => /^w[0-9a-f]{6} /.test(l)).length, 3);
  assert.deepEqual(renderRepoRules(p), renderRepoRules(p, { all: false, topic: undefined as unknown as string /* deliberate misuse: an explicit undefined must read as absent */ }), 'defaults unchanged');
  assert.ok(!renderRepoRules(p).join('\n').includes('Invoice exports'), 'dated sections only with --all');
  // a dated handle shown by --all is resolvable (learn --from-wolf uses the --all list)
  assert.ok(repoRuleList(p, { all: true }).some((e) => e.handle === handleOf('Invoice exports use the shared queue.') && e.section === 'dated'));
  assert.equal(repoRuleList(p).some((e) => e.section === 'dated'), false);
});

test('rules --repo --topic/--all on the CLI: bounded topic, usage errors exit 2, a dated rule can be promoted by the handle --all shows', () => {
  const root = repo(); put(root, '.wolf/cerebrum.md', CEREBRUM);
  const before = walk(path.join(root, '.wolf'));
  const r = run(root, 'rules', '--repo', '--topic', 'Queue'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /showing 1 of 1 \(topic filter: 1 of 6 match\)/);
  const a = run(root, 'rules', '--repo', '--all'); assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout.split('\n')[0], 'counts: do-not-repeat 2, key-learning 4, dated 3');
  for (const bad of [['--topic', ''], ['--topic', 'x'.repeat(61)], ['--topic', 'a\nb']]) {
    const e = run(root, 'rules', '--repo', ...bad); assert.equal(e.status, 2, bad.join(' '));
    assert.equal(e.stderr, 'error: --topic needs a word of 1 to 60 characters on one line\ntry: brain explain rules\n');
  }
  const e = run(root, 'rules', '--topic', 'x'); assert.equal(e.status, 2); assert.equal(e.stderr, 'error: --topic and --all need --repo (a brain topic is the positional argument)\ntry: brain explain rules\n');
  const h = handleOf('Invoice exports use the shared queue.');
  assert.ok(a.stdout.includes(`${h} [wolf:dated]`));
  const l = run(root, 'learn', '--from-wolf', h); assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /^copied repo rule w[0-9a-f]{6} to learnings\.jsonl as W-1 /);
  assert.deepEqual(walk(path.join(root, '.wolf')), before, '.wolf untouched');
});
