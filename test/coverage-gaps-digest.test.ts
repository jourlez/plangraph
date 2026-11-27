// buildMap and buildContext on the thin and odd inputs: nothing set, missing optional fields, ids that need fencing, a repo filter, verbose, no-tests. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, buildContext, render, mapJson, contextJson, ticketFromBranch } from '../lib/digest.ts';
import type { Extras } from '../lib/digest.ts';
import { buildModel } from '../lib/model.ts';

const model = buildModel({
  tickets: [
    { key: 'A-1', summary: 'one', epic: 'E-1', jira_status: 'Done' }, { key: 'A-2', summary: 'two', epic: 'E-1' }, { key: 'A-3', summary: 'three', epic: 'E-0' },
    { key: 'A-4', epic: '' }, { key: 'A-5', summary: 'five', sp: 3 },
  ],
  edges: [{ consumer: 'A-2', producer: 'A-1', kind: 'plan_need' }, { consumer: 'A-2', producer: 'A-3', kind: 'plan_need' }],
  schedule: [{ key: 'A-1', owner: 'Ana', sprint: 1 }, { key: 'A-2', owner: 'Ana', sprint: 2 }, { key: 'A-3', owner: 'Bo', sprint: 2 }, { key: 'A-4', owner: '', sprint: 1 }],
});

test('an empty graph and no extras give the nudge, a graph with only extras does not', () => {
  const e = buildMap(buildModel({ tickets: [] }));
  assert.equal(render(e).text.startsWith('plangraph: empty graph'), true);
  assert.deepEqual(mapJson(e), { empty: true });
  const m = buildMap(buildModel({ tickets: [] }), { extras: { teams: [{ id: 'T-1' }] } });
  assert.match(render(m).text, /^plangraph map \| 0 tickets, 0 repos, 0 people/);
  assert.match(render(m).text, /teams: T-1 0m\/0r/);
  assert.match(render(m).text, /cache age unknown/);
});

test('map: one person, requirement states, decisions without date or title, epics, hot modules and the stack lines', () => {
  const extras: Extras = {
    teams: [{ id: 'T-2', members: ['a'], owns: ['r', 's'] }, { id: 'T-1' }],
    requirements: [{ id: 'R-1' }, { id: 'R-2', status: 'accepted', state: 'orphan' }, { id: 'R-3', status: 'accepted', state: 'orphan' }],
    decisions: [{ id: 'D-1' }, { id: 'D-2', date: '2026-02-01', title: 'two' }, { id: 'D-3', date: '2026-02-01' }, { id: 'D-4', date: '2026-03-01', title: 'four' }, { id: 'D-5', date: '2026-01-01' }],
    repos: [{ id: 'web', pm: 'npm', cmds: { test: 'npm test' } }, { id: 'api', pm: 'NPM', cmds: { test: 'make check' } }, { id: 'lib', cmds: { test: '' } }, { id: 'bare bone' }, { id: 'odd', pm: 'cargo', cmds: { test: 'cargo test' } }],
    modules: [
      { repo: 'web', path: 'a.ts', hotspot: true, churn: 3 }, { repo: 'web', path: 'b.ts', hotspot: true, churn: 3, bus1: true }, { repo: 'api', path: 'c.ts', hotspot: true },
      { repo: 'api', path: 'd.ts', hotspot: false, churn: 99 }, { repo: 'api', path: 'x'.repeat(250), hotspot: true, churn: 50 },
    ],
  };
  const d = buildMap(model, { extras, fresh: { fp: 'zz-abc123-9', ageDays: 2.7 } });
  const t = render(d, 5000).text;
  assert.match(t, /5 tickets, 5 repos, 2 people/);
  assert.match(t, /owners: Ana 2, Bo 1/);
  assert.match(t, /teams: T-1 0m\/0r, T-2 1m\/2r/);
  assert.match(t, /requirements: 3 \(accepted 2, proposed 1\); orphan 2/);
  assert.match(t, /latest D-4 <untrusted[^>]*>four/);
  assert.ok(t.indexOf('latest D-4') < t.indexOf('latest D-3') && t.indexOf('latest D-3') < t.indexOf('latest D-2'));
  assert.doesNotMatch(t, /latest D-1|latest D-5/);
  assert.match(t, /epics: E-1 1\/2, E-0 0\/1/);
  assert.match(t, /hot api:<untrusted[^>]*>x+…\[\+210 chars\]<\/untrusted> churn 50/);
  assert.ok(t.indexOf('hot web:a.ts churn 3') < t.indexOf('hot web:b.ts churn 3 bus1'));
  assert.match(t, /hot api:c.ts churn 0/);
  assert.doesNotMatch(t, /d\.ts/);
  assert.match(t, /stack differs/);
  assert.match(t, /api test=<untrusted[^>]*>make check/);
  assert.doesNotMatch(t, /web test=|odd test=|lib test=/);
  assert.match(t, /fresh: index abc1239,/);
  assert.match(t, /cache 2d old/);
  const j = mapJson(d) as { hotspots: Array<{ path: string }>; repos: unknown[]; fp: string };
  assert.ok(j.hotspots.some((h) => h.path.length < 250), 'a path over 200 characters is shortened');
  assert.equal(j.repos.length, 1);
  assert.equal(j.fp, 'abc1239');
  const v = render(buildMap(model, { extras, verbose: true }), 5000).text;
  assert.match(v, /web test=<untrusted[^>]*>npm test/);
  assert.match(v, /<untrusted[^>]*>bare bone<\/untrusted>/);
  assert.match(v, /cache age unknown/);
  const one = render(buildMap(model, { extras, repo: 'web', fresh: { ageDays: Number.NaN } }), 5000).text;
  assert.doesNotMatch(one, /api:/);
  assert.match(one, /cache age unknown/);
  assert.match(one, /fresh: index unbuilt/);
  assert.match(render(buildMap(model, { extras, fresh: { ageDays: -4 } }), 5000).text, /cache 0d old/);
});

test('context: unowned, unplaced, no commands, a repo found by touched paths only, authors, and a ticket outside the graph', () => {
  const extras: Extras = {
    repos: [{ id: 'web', touched: { 'A-5': ['src/x.ts'] }, owners: ['Zoe', 'Zoe', 'Al'] }, { id: 'api', tickets: ['A-5'], cmds: { build: 'make' } }, { id: 'other', tickets: ['A-1'] }],
    requirements: [{ id: 'R-1', satisfiedBy: ['A-5'] }],
    decisions: [{ id: 'D-1', affects: ['./src/**/*.ts'] }, { id: 'D-2', affects: ['src/?.ts'] }, { id: 'D-3', affects: ['src/x.ts/'] }, { id: 'D-4', affects: ['lib/**'] }, { id: 'D-5' }, { id: 'D-6', affects: ['src/*'], title: 'six' }, { id: 'D-7', affects: ['src/**'] }],
    modules: [{ repo: 'web', path: 'src/x.ts', bus1: true, authors: [{ person: 'Cy', share: 0.1 }, { person: 'Al', share: 0.6 }, { person: 'Di', share: 0.6 }] }, { repo: 'web', path: 'src/x.ts', hotspot: true }, { repo: 'web', path: 'src/y.ts', hotspot: true }],
  };
  const d = buildContext(model, 'A-5', { extras });
  const t = render(d, 5000).text;
  assert.match(t, /^context A-5 <untrusted[^>]*>five<\/untrusted> \| unowned \| unplaced \| 3sp/);
  assert.match(t, /blockers: none/);
  assert.match(t, /repo api data: build=<untrusted[^>]*>make/);
  assert.match(t, /repo web data: no commands/);
  assert.doesNotMatch(t, /repo other/);
  assert.match(t, /req R-1 proposed/);
  for (const id of ['D-1', 'D-2', 'D-6', 'D-7']) assert.match(t, new RegExp(`decision ${id} proposed`));
  assert.doesNotMatch(t, /decision D-4|decision D-5/);
  assert.match(t, /hotspot web:src\/x.ts bus1/);
  assert.match(t, /ask: Al, Zoe, Di/);
  assert.equal((contextJson(d) as { ask: string[] }).ask.length >= 3, true);
  const filtered = render(buildContext(model, 'A-5', { extras, repo: 'api' }), 5000).text;
  assert.doesNotMatch(filtered, /repo web/);
  assert.match(render(buildContext(model, 'A-2', { extras }), 5000).text, /blockers: A-3\n|blockers: A-3$/m);
  assert.match(render(buildContext(model, 'ZZ-9', { extras })).text, /no ticket ZZ-9/);
  assert.match(render(buildContext(model, null, { extras })).text, /no task detected/);
  assert.match(render(buildContext(buildModel({ tickets: [] }), 'A-1')).text, /empty graph/);
});

test('render drops whole low-priority lines under a tight bound and says how many', () => {
  const extras: Extras = { requirements: [{ id: 'R-1' }], teams: [{ id: 'T-1' }], decisions: [{ id: 'D-1', title: 'one' }] };
  const d = buildMap(model, { extras });
  const full = render(d, 5000);
  assert.equal(full.omitted, 0);
  const tight = render(d, 40);
  assert.ok(tight.omitted > 0);
  assert.match(tight.text, /omitted \d+, narrow with --repo or -v/);
});

test('ticketFromBranch picks the longest whole key and ignores glued ones', () => {
  assert.equal(ticketFromBranch('feat/abc-12-x', ['ABC-1', 'ABC-12']), 'ABC-12');
  assert.equal(ticketFromBranch('feat/abc-123', ['ABC-12']), null);
  assert.equal(ticketFromBranch('xabc-12', ['ABC-12']), null);
  assert.equal(ticketFromBranch('feat/abc-12-abc-12', ['ABC-12', '']), 'ABC-12');
  assert.equal(ticketFromBranch(undefined as unknown as string, ['A-1']), null);
});
