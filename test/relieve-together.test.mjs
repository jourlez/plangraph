// Review M1: a relief whose moves only work together. brain applies one move at a time (`brain whatif KEY ... --apply-plan --write`, each
// with its own repair), so "apply together" is not supported; the text says so plainly, says why, and names the safe manual path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.mjs';
import { relieve, renderRelieve, whatif } from '../lib/whatif.mjs';

// T1 and T2 need each other (a loop), both in Ana S2 (cap 2) with T3 (2 SP): either one leaving alone breaks the other's link.
const m = buildModel({
  tickets: [{ key: 'T1', sp: 0 }, { key: 'T2', sp: 1 }, { key: 'T3', sp: 2 }],
  edges: [{ consumer: 'T1', producer: 'T2', kind: 'x' }, { consumer: 'T1', producer: 'T3', kind: 'x' }, { consumer: 'T2', producer: 'T1', kind: 'x' }],
  schedule: [{ key: 'T1', owner: 'Ana', sprint: 2 }, { key: 'T2', owner: 'Ana', sprint: 2 }, { key: 'T3', owner: 'Ana', sprint: 2 }],
  config: { first_sprint: 1, end_sprint: 3, caps: { default: 2 } },
});

test('a together-only relief says plainly that apply together is not supported, why, and what to do instead', () => {
  const r = relieve(m, { person: 'Ana', sprint: 2 });
  assert.deepEqual([r.status, r.order, r.moves.map((x) => `${x.key}>${x.to.owner} S${x.to.sprint}`)], ['relief', 'together', ['T1>Ana S3', 'T2>Ana S3']]);
  for (const x of r.moves) assert.equal(whatif(m, { key: x.key, sprint: x.to.sprint }, { noSuggest: true }).ok, false, `${x.key} alone is refused`);
  const lines = renderRelieve(r, { cmd: (x) => `brain whatif ${x.key} --sprint ${x.to.sprint}` });
  assert.equal(lines.at(-1), '(dry run, nothing changed: these moves only work together, and brain cannot apply them together: it applies one move at a time with its own repair (brain whatif KEY --sprint N --apply-plan --write), and each of these moves alone breaks a link or a capacity, so no command above says OK on its own. To apply them, edit schedule.json by hand, check it with brain verify FILE, then brain schedule-load FILE NAME)');
});
