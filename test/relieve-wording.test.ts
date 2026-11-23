// Review M4: relieve wording. When the target cells together lack room the reason says `the targets have room for X of Y SP`; the try:
// line (and --json next) never suggests --earlier when sprint N is first_sprint (there is no earlier sprint).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { relieve, renderRelieve } from '../lib/whatif.ts';

// Ana S2 (cap 2): X 1, Y 1 movable, Z 2 Done. Excess 2: X and Y must both leave; the only target, Ana S3, has room for 1.
const roomModel = (first: number) => buildModel({
  tickets: [{ key: 'X', sp: 1 }, { key: 'Y', sp: 1 }, { key: 'Z', sp: 2, jira_status: 'Done' }, { key: 'W', sp: 1 }],
  schedule: [{ key: 'X', owner: 'Ana', sprint: 2 }, { key: 'Y', owner: 'Ana', sprint: 2 }, { key: 'Z', owner: 'Ana', sprint: 2 }, { key: 'W', owner: 'Ana', sprint: 3 }],
  config: { first_sprint: first, end_sprint: 3, caps: { default: 2 } },
});

test('the targets together lack room: "the targets have room for X of Y SP"', () => {
  const r = relieve(roomModel(1), { person: 'Ana', sprint: 2 });
  assert.equal(r.status, 'no_relief');
  assert.deepEqual(r.reasons, [{ code: 'FROZEN', keys: ['Z'] }, { code: 'NO_ROOM', keys: ['X', 'Y'], room: 1, needed: 2 }]);
  assert.deepEqual(renderRelieve(r, { cmd: () => null }), [
    'NO RELIEF: Ana S2 4/2: no relief found within the allowed moves (this cell\'s tickets, later sprints, same owner)',
    '- frozen (started or closed) 1: Z', '- the targets have room for 1 of 2 SP',
    'try: --earlier, --owner-change, or brain whatif KEY --sprint M --slip --apply-plan to shift other tickets too']);
});

test('sprint N is first_sprint: the try: line does not suggest --earlier', () => {
  const r = relieve(roomModel(2), { person: 'Ana', sprint: 2 });
  assert.equal(r.status, 'no_relief');
  assert.equal(renderRelieve(r, { cmd: () => null }).at(-1), 'try: --owner-change, or brain whatif KEY --sprint M --slip --apply-plan to shift other tickets too');
  const both = relieve(roomModel(2), { person: 'Ana', sprint: 2 }, { allowOwnerChange: true });
  assert.equal(renderRelieve(both, { cmd: () => null }).at(-1), 'try: brain whatif KEY --sprint M --slip --apply-plan to shift other tickets too');
});
