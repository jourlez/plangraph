// The solver's time budget must not include the first import of OR-Tools: after an install that import can take 30 s on a cold machine,
// which is longer than the default budget, and a first run would then return a schedule that is feasible but not proved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('the solver starts its budget clock after the OR-Tools import, and nowhere before it', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'bin', 'plangraph-solve'), 'utf8');
  const imp = src.indexOf('        import ortools\n');
  const starts = [...src.matchAll(/^ {4}t_start = time\.time\(\)/gm)].map((m) => m.index as number);
  assert.ok(imp > 0, 'the import line is found');
  assert.equal(starts.length, 1, 'one place starts the clock');
  assert.ok((starts[0] as number) > imp, 'the clock starts after the import');
  assert.ok(src.indexOf('clock = Clock(total, a.deterministic, t_start)') > (starts[0] as number), 'the clock is built from that start');
});
