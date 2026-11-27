// EntityStore addRows/removeRows on rows that already exist: the replace-by-identity filters and the removal filters of every kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntityStore } from '../lib/store2/entitystore.ts';
import { validators } from '../lib/schema.ts';

const tmps: string[] = [];
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const store = (): EntityStore => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-gap-')));
  tmps.push(d);
  fs.writeFileSync(path.join(d, 'format.json'), '{"format_version":2,"min_reader":2,"storage":"entity"}\n');
  return new EntityStore({ dir: d, root: d });
};

test('addRows replaces an edge, a capacity and a link row by identity; removeRows drops exactly the named ones', () => {
  const s = store();
  s.addRows('ticket', [{ key: 'T-1' }, { key: 'T-2' }]);
  s.addRows('edge', [{ consumer: 'T-1', producer: 'T-2', kind: 'plan_need' }, { consumer: 'T-1', producer: 'T-3', kind: 'plan_need' }]);
  s.addRows('edge', [{ consumer: 'T-1', producer: 'T-2', kind: 'jira_link' }]);
  const edges = s.readKind('edge');
  assert.equal(edges.length, 2);
  assert.equal(edges.find((e) => e.producer === 'T-2')?.kind, 'jira_link');
  s.removeRows('edge', [{ consumer: 'T-1', producer: 'T-2' }]);
  assert.deepEqual(s.readKind('edge').map((e) => e.producer), ['T-3']);

  s.addRows('capacity', [{ person: 'Ana', sprint: 1, sp: 5 }, { person: 'Ana', sprint: 2, sp: 4 }]);
  s.addRows('capacity', [{ person: 'Ana', sprint: 1, sp: 9 }]);
  const cap = s.readKind('capacity');
  assert.equal(cap.length, 2);
  assert.equal(cap.find((c) => c.sprint === 1)?.sp, 9);
  s.removeRows('capacity', [{ person: 'Ana', sprint: 1 }]);
  assert.deepEqual(s.readKind('capacity').map((c) => c.sprint), [2]);

  const l1 = { from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'repo:a', to_type: 'repo' };
  const l2 = { from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'repo:b', to_type: 'repo' };
  s.addRows('link', [l1, l2]);
  s.addRows('link', [l1]);
  assert.equal(s.readKind('link').length, 2);
  s.removeRows('link', [{ from: 'T-1', from_type: 'ticket', rel: 'touches', to: 'repo:a' }]);
  assert.deepEqual(s.readKind('link').map((l) => l.to), ['repo:b']);
});

test('addRows replaces a ref and an xref by identity and removeRows drops them', () => {
  const s = store();
  s.addRows('ticket', [{ key: 'T-1' }]);
  const ref = { plans: [], files: {}, fp_files: '', jira_updated: '', audited_at: '' };
  s.addRows('ref', [{ key: 'T-1', ...ref }]);
  s.addRows('ref', [{ key: 'T-1', ...ref, fp_files: 'f2' }]);
  assert.equal(s.readKind('ref').length, 1);
  assert.equal(s.readKind('ref')[0]?.fp_files, 'f2');
  s.removeRows('ref', [{ key: 'T-1' }]);
  assert.equal(s.readKind('ref').length, 0);

  const x = { type: 'ticket', id: 'T-1', sys: 'jira', xid: 'X-1' };
  s.addRows('xref', [x, { ...x, xid: 'X-2' }]);
  s.removeRows('xref', [x]);
  assert.deepEqual(s.readKind('xref').map((r) => r.xid), ['X-2']);
});

test('the requirement, decision, team and repo validators accept a plain row and reject a bad optional field', () => {
  const good: Record<string, Record<string, unknown>> = {
    'requirements.jsonl': { id: 'R-1', text: 't', kind: 'ears', status: 'proposed', source: 'confluence:1', acceptance: ['a'], priority: 'p1' },
    'decisions.jsonl': { id: 'D-1', title: 't', status: 'accepted', date: '2026-01-01', affects: ['a/**'], source: 's', derivation: 'd' },
    'teams.jsonl': { id: 'T-1', name: 'n', members: ['a'], owns: ['b'] },
  };
  for (const [f, row] of Object.entries(good)) assert.equal(validators[f]?.(row as never), null, f);
  assert.notEqual(validators['requirements.jsonl']?.({ id: 'R-1', text: 5, version: 1 } as never), null);
  assert.notEqual(validators['decisions.jsonl']?.({ id: 'D-1', title: 5 } as never), null);
  assert.notEqual(validators['teams.jsonl']?.({ id: 'T-1', name: 5 } as never), null);
  assert.notEqual(validators['teams.jsonl']?.({ id: 'T-1', members: 5 } as never), null);
  assert.notEqual(validators['teams.jsonl']?.({ id: 'T-1', owns: 5 } as never), null);
});
