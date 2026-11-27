// In-process CLI goldens (test/golden/mutation-kills/cli.json, UPDATE_GOLDEN=1 rewrites; regenerate and review after an intended output
// change), written to kill mutants of src/ that survived scripts/mutate-all.ts: every registered command runs through src/cli.ts main()
// in-process (no child node process) on a generated fixture repository, in its plain, -v and --json forms, plus its usage errors (unknown
// option, missing and extra positionals, bad option values). Read-only commands share one built fixture; each writing command gets a fresh
// copy; each run happens with the fixture as the process working directory. Captured: exit code, stdout lines, stderr lines, and for writing commands the bytes of the files they changed. Temp paths are
// replaced by <repo>. SOURCE_DATE_EPOCH pins the clock; HOME, plugin data and git config are private. All names are invented.
// NOT covered: jira-pull (never run here: on a machine with a keychain entry it would reach the network), the session hook wiring
// (test/hook.test.ts).
import { test, after, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { registry } from '../src/registry.ts';
import { golden } from './helpers/golden-json.ts';
import { made, run, state, fixture, copy, snapshot } from './helpers/cli-fixture.ts';
import { readPlanFile } from './helpers/plan-dir.ts';

after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
before(async () => { state.FIX = await fixture(); });

const READS = ([
  ['ticket', 'T-1'], ['ticket', 'T-99'], ['neighbors', 'T-5'], ['neighbors', 'T-5', '2'], ['neighbors', 'T-5', 'x'], ['chain', 'T-9'], ['sprint', '1'], ['sprint', 'x'], ['person', 'Ana'], ['person', 'Nobody'],
  ['blockers'], ['findings'], ['findings', 'T-2'], ['rules'], ['rules', 'db'], ['rules', '--repo'], ['rules', '--max', '1'], ['check'], ['verify'], ['verify', '--enforce-min'], ['ready', 'T-1'], ['ready', 'T-4'], ['ready', 'T-2'],
  ['card'], ['card', '--line'], ['doctor'], ['stale'], ['stale', '--list'], ['stale', '--full', '--list'], ['stale', '--ref', 'nope'], ['bundle', 'T-1'], ['bundle'], ['forecast'], ['simulate', '--runs', '200', '--seed', '2'],
  ['simulate', '--sigma', '0.3', '--limit', '3', '--runs', '200'], ['integrations'], ['explain'], ['explain', 'whatif'], ['explain', 'nope'], ['whatif', 'T-3', '--sprint', '4'], ['whatif', 'T-3', '--to', 'Ben'], ['whatif', 'T-3', '--sprint', '1', '--earlier', '--owner-change', '--slip'],
  ['whatif', 'T-3', '--sprint', 'x'], ['open-items'], ['open-items', '--mine', '--me', 'Ana'], ['open-items', '--sprint', '2'], ['open-items', '--suggest-from-status'], ['open-items', '--findings', 'missing.jsonl'], ['open-items', '--findings', 'docs'], ['open-items', '--findings', 'big.jsonl'],
  ['ready', 'T-1', '--jira', 'snap.jsonl'], ['simulate', '--runs', '0'], ['simulate', '--sigma', '6'], ['simulate', '--sigma', '5', '--runs', '100'], ['stale', '--ref', '-bad'], ['jira-import'], ['jira-text'], ['ready', 'T-2', '--jira', 'none.jsonl'], ['stale', '--jira', 'snap.jsonl'], ['stale', '--jira', 'none.jsonl'], ['nope'], ['tickt', 'T-1'], [],
] as Array<string[]>); // a literal list of these tuples

test('read-only commands: plain, -v and --json, on one fixture', async () => {
  const res: Record<string, unknown> = {};
  for (const argv of READS) {
    res[argv.join(' ') || '(none)'] = await run(state.FIX, argv);
    if (argv.length && !argv.includes('nope') && argv[0] !== 'tickt') { res[`${argv.join(' ')} -v`] = await run(state.FIX, [...argv, '-v']); res[`${argv.join(' ')} --json`] = await run(state.FIX, [...argv, '--json']); }
  }
  golden('cli', 'reads', res);
});

test('usage errors for every command: unknown option, missing and extra positionals', async () => {
  const res: Record<string, unknown> = {};
  for (const [name, spec] of registry) {
    const [lo, hi] = spec.positionals;
    res[`${name} --bogus`] = await run(state.FIX, [name, '--bogus']);
    if (lo > 0) res[`${name} (too few)`] = await run(state.FIX, [name]);
    if (Number.isFinite(hi)) res[`${name} (too many)`] = await run(state.FIX, [name, ...Array.from({ length: hi + 1 }, (_, i) => `a${i}`)]);
    for (const [opt, o] of Object.entries(spec.options || {})) if (o.type === 'integer' || o.type === 'number') res[`${name} --${opt} bad`] = await run(state.FIX, [name, `--${opt}`, 'bad']);
  }
  golden('cli', 'usage', res);
});

const WRITES = ([
  ['card', '--write'], ['card', '--refresh'], ['export'], ['build'], ['doctor', '--fix'], ['refs-update'], ['refs-update', '--full'],
  ['units', '--keys', 'T-1,T-2', '--out', 'units'], ['units', '--stale', '--out', 'units2'], ['units', '--keys', 'T-1', '--size', '1', '--out', 'u3', '--tokens-per-unit', '100'],
  ['open-items', '--write'], ['open-items', '--register', 'T-1', 'manual', '--text', 'call them', '--owner', 'Ana', '--due', '3'], ['open-items', '--close', 'T-2', 'risk', '--by', 'Ana', '--note', 'decided'],
  ['open-items', '--reopen', 'T-2', 'risk'], ['whatif', 'T-3', '--sprint', '4', '--write'], ['whatif', 'T-3', '--sprint', '4', '--apply-plan', '--write'], ['schedule-load', 'sched.json', 'v3'], ['schedule-load', 'bad-sched.json', 'v3'], ['schedule-load', 'frozen-sched.json', 'v4'],
  ['learn', '--from-wolf', 'w000000'], ['report'], ['report', '--out', 'docs'], ['sp-ingest', 'docs/superpowers/plans/2026-01-01-widget.md'], ['sp-ingest', 'docs/superpowers/plans/2026-01-01-widget.md', '--owner', 'Ana', '--sprint', '2'],
  ['sp-link', 'T-4', 'sp:2026-01-01-widget/1'], ['jira-text', 'ABC-1', 'ABC-2', '--from-json', 'keyed.json', '--out', 'jt2'], ['refs-update', '--ref', '-bad'], ['jira-text', 'ABC-1', '--from-json', 'issue.json', '--out', 'jt'], ['jira-import', 'issues.json', '--out', 'snap.jsonl'],
] as Array<string[]>); // a literal list of these tuples

test('writing commands: output and the files they change, each on a fresh copy', async () => {
  const res: Record<string, unknown> = {};
  for (const argv of WRITES) {
    const d = copy();
    // a valid schedule keeps every other ticket where it is (a Done ticket T-3 may not move or vanish: schedule-load refuses that, see frozen-sched.json)
    const current = readPlanFile(path.join(d, '.plangraph'), 'schedule.jsonl').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.version || r.version === 'current');
    const keep = current.filter((r) => r.key !== 'T-1' && r.key !== 'T-2').map((r) => ({ item: r.key, owner: r.owner, sprint: r.sprint }));
    fs.writeFileSync(path.join(d, 'sched.json'), JSON.stringify([...keep, { item: 'T-1', owner: 'Ben', sprint: 2 }, { item: 'T-2', owner: 'Ana', sprint: 1 }]));
    fs.writeFileSync(path.join(d, 'frozen-sched.json'), JSON.stringify([{ item: 'T-1', owner: 'Ben', sprint: 2 }, { item: 'T-2', owner: 'Ana', sprint: 1 }]));
    fs.writeFileSync(path.join(d, 'bad-sched.json'), JSON.stringify({ 'T-1': { owner: 'Ben', sprint: 2 } }));
    fs.writeFileSync(path.join(d, 'issue.json'), JSON.stringify({ fields: { summary: 'Imported', status: { name: 'Done' }, updated: '2026-01-01' } }));
    fs.writeFileSync(path.join(d, 'keyed.json'), JSON.stringify({ 'ABC-1': { fields: { summary: 'First' } }, 'ABC-2': { fields: { summary: 'Second' } } }));
    fs.writeFileSync(path.join(d, 'issues.json'), JSON.stringify([{ key: 'ABC-1', fields: { summary: 'One', status: { name: 'To Do' }, updated: '2026-01-02T00:00:00Z' } }]));
    const before = snapshot(d), r = await run(d, argv), after = snapshot(d);
    const changed = Object.fromEntries(Object.entries(after).filter(([f, t]) => before[f] !== t));
    res[argv.join(' ')] = { ...r, changed, removed: Object.keys(before).filter((f) => !(f in after)) };
  }
  golden('cli', 'writes', res);
});

