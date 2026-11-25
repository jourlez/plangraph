// In-process CLI goldens, part 2 (test/golden/mutation-kills/cli-more.json, UPDATE_GOLDEN=1 rewrites): the format gate on
// legacy and newer data, an empty repository and the freshness warning; companion tools with real inputs (a populated home and .wolf,
// learn from a cerebrum handle, sp-ingest with a ledger, sp-link); bundle and units with Jira text, many files and findings and the key cap.
// Same fixture and runner as part 1 (test/helpers/cli-fixture.ts). All names are invented.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { golden } from './helpers/golden-json.ts';
import { made, tmp, jl, git, run, state, fixture, copy } from './helpers/cli-fixture.ts';

after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
before(async () => { state.FIX = await fixture(); });

test('format gate, missing index and freshness: legacy data, an empty repository, open items newer than the index', async () => {
  const res: Record<string, unknown> = {};
  const legacy = copy(); fs.rmSync(path.join(legacy, '.plangraph', 'format.json'));
  for (const argv of [['export'], ['ticket', 'T-1'], ['migrate'], ['doctor'], ['card']]) res[`legacy ${argv.join(' ')}`] = await run(legacy, argv);
  const newer = copy(); fs.writeFileSync(path.join(newer, '.plangraph', 'format.json'), '{"format_version":9,"min_reader":9}\n');
  for (const argv of [['export'], ['ticket', 'T-1'], ['migrate', '--write']]) res[`newer ${argv.join(' ')}`] = await run(newer, argv);
  const empty = tmp(); git(empty, 'init', '-q');
  for (const argv of [['card'], ['card', '--if-present'], ['ticket', 'T-1'], ['forecast']]) res[`empty ${argv.join(' ')}`] = await run(empty, argv);
  const fresh = copy(); const later = new Date(Date.now() + 60000);
  fs.writeFileSync(path.join(fresh, '.plangraph', 'open-items.jsonl'), ''); fs.utimesSync(path.join(fresh, '.plangraph', 'open-items.jsonl'), later, later);
  for (const argv of [['forecast'], ['forecast', '--if-present']]) res[`open-items newer ${argv.join(' ')}`] = await run(fresh, argv);
  golden('cli-more', 'gates', res);
});


test('companion tools with real inputs: integrations over a populated home and .wolf, learn from a cerebrum handle, sp-ingest with a ledger, sp-link', async () => {
  const { handleOf } = await import('../lib/integrations/openwolf.ts');
  const res: Record<string, unknown> = {};
  const d = copy(), home = tmp();
  const put = (f: string, t: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'superpowers@m': [{ scope: 'user', installPath: '/x', version: '5.0.0' }], 'caveman@m': [{ scope: 'user', installPath: '/x', version: '1.0.0' }], 'gitkraken-hooks@m': [{ scope: 'user', installPath: '/x', version: '2.0.0' }] } }));
  put(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@m': true, 'gitkraken-hooks@m': false } }));
  put(path.join(d, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'caveman@m': true }, hooks: { SessionStart: [{ hooks: [{ command: 'node $CLAUDE_PROJECT_DIR/.wolf/hooks/session-start.js' }] }] } }));
  const rule = 'Never run migrations from the app root.';
  put(path.join(d, '.wolf/cerebrum.md'), `# Cerebrum\n\n## Do-Not-Repeat\n\n- [2031-01-02] ${rule}\n\n## Key Learnings\n\n- Use integer cents.\n`);
  put(path.join(d, '.wolf/hooks/session-start.js'), '');
  put(path.join(d, '.wolf/hooks/runtime.json'), JSON.stringify({ version: '1.2.3' }));
  const env = { HOME: home };
  for (const argv of [['integrations'], ['integrations', '-v'], ['integrations', '--json'], ['rules', '--repo'], ['rules', '--repo', '--max', '1']]) res[argv.join(' ')] = await run(d, argv, env);
  const learnDir = copy(); fs.cpSync(path.join(d, '.wolf'), path.join(learnDir, '.wolf'), { recursive: true });
  res['learn handle'] = await run(learnDir, ['learn', '--from-wolf', handleOf(rule)], env);
  res['learn handle again'] = await run(learnDir, ['learn', '--from-wolf', handleOf(rule)], env);
  res['learn bad handle'] = await run(learnDir, ['learn', '--from-wolf', 'x'], env);
  res['learnings after'] = fs.readFileSync(path.join(learnDir, '.plangraph', 'learnings.jsonl'), 'utf8').split(learnDir).join('<repo>');
  const sp = copy();
  put(path.join(sp, '.superpowers/sdd/progress.md'), '# Plan: docs/superpowers/plans/2026-01-01-widget.md\nTask 1: complete (abc123..def456)\nTask 2: in progress\n');
  res['sp-ingest with ledger'] = await run(sp, ['sp-ingest', 'docs/superpowers/plans/2026-01-01-widget.md']);
  res['sp-ingest explicit ledger'] = await run(sp, ['sp-ingest', 'docs/superpowers/plans/2026-01-01-widget.md', '--ledger', '.superpowers/sdd/progress.md']);
  res['sp-ingest missing'] = await run(sp, ['sp-ingest', 'docs/nope.md']);
  res['sp-ingest outside'] = await run(sp, ['sp-ingest', '../outside.md']);
  res['sp-link'] = await run(sp, ['sp-link', 'T-4', 'sp:2026-01-01-widget/2']);
  res['sp-link tasks'] = await run(sp, ['sp-link', 'T-5', '--tasks', 'sp:2026-01-01-widget/1,sp:2026-01-01-widget/2']);
  res['sp-link plan'] = await run(sp, ['sp-link', 'T-4', 'docs/superpowers/plans/2026-01-01-widget.md', '--tasks', '1,2']);
  res['sp-link plan all'] = await run(sp, ['sp-link', 'T-6', 'docs/superpowers/plans/2026-01-01-widget.md']);
  res['sp-link bad task'] = await run(sp, ['sp-link', 'T-4', 'docs/superpowers/plans/2026-01-01-widget.md', '--tasks', '9']);
  res['sp-link bad'] = await run(sp, ['sp-link', 'NOPE-1', 'sp:2026-01-01-widget/9']);
  res['sp files'] = Object.fromEntries(['tickets.jsonl', 'edges.jsonl', 'schedule.jsonl'].map((f) => [f, fs.readFileSync(path.join(sp, '.plangraph', f), 'utf8').split('\n').filter((l) => l.includes('sp:'))]));
  golden('cli-more', 'companions', res);
});

test('audit preparation: bundles with Jira text, many files and findings, a missing plan section; units from a keys file; the key cap', async () => {
  const res: Record<string, unknown> = {};
  const d = copy(), b = path.join(d, '.plangraph');
  const refs = [{ key: 'T-1', plans: [{ plan: 'docs/plan.md', task: '1' }, { plan: 'docs/plan.md', task: '9' }], files: Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`src/f${String(i).padStart(2, '0')}.js`, 1])), fp_files: '', jira_updated: '', audited_at: '' }];
  fs.writeFileSync(path.join(b, 'refs.jsonl'), jl(refs));
  fs.writeFileSync(path.join(b, 'findings.jsonl'), jl(Array.from({ length: 55 }, (_, i) => ({ key: 'T-2', kind: `k${'x'.repeat(i % 3 ? 2 : 45)}${i}`, text: `finding ${i}` }))));
  assert.equal((await run(d, ['build'])).code, 0);
  fs.mkdirSync(path.join(d, 'jt')); fs.writeFileSync(path.join(d, 'jt', 'T-1.txt'), 'Jira text for T-1'); fs.mkdirSync(path.join(d, 'jt', 'T-2.txt'));
  for (const argv of [['bundle', 'T-1', '--text', 'jt'], ['bundle', 'T-2', '--text', 'jt'], ['bundle', 'T-3', 'T-99'], ['bundle', ...Array.from({ length: 101 }, (_, i) => `T-${i + 1}`)]]) {
    const r = await run(d, argv); res[argv.slice(0, 4).join(' ') + (argv.length > 4 ? ` (+${argv.length - 4})` : '')] = { ...r, out: r.out.join('\n').split('\n').filter((l) => /TICKET|Needs|Summary|Finding|PLAN|Files|JIRA|error|more/.test(l)) };
  }
  const hundred = await run(d, ['bundle', ...Array.from({ length: 100 }, (_, i) => `T-${(i % 14) + 1}`)]);
  res['bundle exactly 100 keys'] = { code: hundred.code, tickets: hundred.out.join('\n').split('\n').filter((l) => l.includes('=== TICKET')).length, err: hundred.err };
  fs.writeFileSync(path.join(d, 'keys.txt'), 'T-1\nT-2  T-3\n');
  for (const argv of [['units', '--keys-file', 'keys.txt', '--out', 'u1'], ['units', '--keys-file', 'none.txt', '--out', 'u2'], ['units', '--out', 'u3'], ['units', '--keys', 'T-1', '--size', '0', '--out', 'u4'], ['units', '--keys', ' , T-2 ,', '--out', 'u5', '--text', 'jt']]) res[argv.join(' ')] = await run(d, argv);
  res['u1 files'] = fs.existsSync(path.join(d, 'u1')) ? fs.readdirSync(path.join(d, 'u1')).sort() : null;
  golden('cli-more', 'audit-prep', res);
});

