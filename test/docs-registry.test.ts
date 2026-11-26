// buildDocs / checkDocs over an in-memory file system and a fake generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.ts';
import { buildDocs, checkDocs, checkOut, listDocs, planDocs, type FsLike } from '../lib/docs/registry.ts';
import { defineGenerator } from '../lib/docs/generators/common.ts';

const memfs = (): FsLike & { files: Map<string, string>; dirs: string[] } => {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  return { files, dirs, read: (p) => files.get(p) as string, write: (p, t) => void files.set(p, t), exists: (p) => files.has(p), mkdirp: (d) => void dirs.push(d) };
};
const model = (status = 'todo', key = 'A-1') => buildModel({ tickets: [{ key, impl_status: status as 'todo' }] });
const fake = (id: string, pick: (m: ReturnType<typeof model>) => string) => defineGenerator({
  id, title: () => `# ${id}`, v: 1, out: () => `${id}.md`,
  data: (m) => pick(m as ReturnType<typeof model>), view: (d) => [`value ${d}`],
});
const gens = [fake('one', (m) => [...m.tickets.values()].map((t) => t.impl_status).join()), fake('two', () => 'constant')];
const cfg = {};

test('build writes one file per generator under docs/plangraph, then check is ok', () => {
  const fs = memfs();
  const r = buildDocs(model(), cfg, fs, {}, { generators: gens });
  assert.deepEqual(r.written, ['docs/plangraph/one.md', 'docs/plangraph/two.md']);
  assert.deepEqual(r.refused, []);
  assert.ok(fs.files.get('docs/plangraph/one.md')!.startsWith('# one\n'));
  assert.equal(checkDocs(model(), cfg, fs, {}, { generators: gens }).ok, true);
  assert.deepEqual(listDocs(model(), cfg, {}, gens), ['docs/plangraph/one.md one', 'docs/plangraph/two.md two']);
});

test('a second build changes nothing', () => {
  const fs = memfs();
  buildDocs(model(), cfg, fs, {}, { generators: gens });
  const snap = new Map(fs.files);
  const r = buildDocs(model(), cfg, fs, {}, { generators: gens });
  assert.deepEqual(r.written, []);
  assert.deepEqual(fs.files, snap);
});

test('changing a fact makes exactly the dependent generator stale', () => {
  const fs = memfs();
  buildDocs(model('todo'), cfg, fs, {}, { generators: gens });
  const c = checkDocs(model('done'), cfg, fs, {}, { generators: gens });
  assert.deepEqual(c.rows.map((r) => `${r.id}:${r.status}`), ['one:stale', 'two:fresh']);
  assert.equal(c.ok, false);
  buildDocs(model('done'), cfg, fs, {}, { generators: gens });
  assert.equal(checkDocs(model('done'), cfg, fs, {}, { generators: gens }).ok, true);
});

test('a hand edit inside a region is refused and the file unchanged; --force overwrites; prose outside survives', () => {
  const fs = memfs();
  buildDocs(model('todo'), cfg, fs, {}, { generators: gens });
  const p = 'docs/plangraph/one.md';
  fs.files.set(p, `${fs.files.get(p)!.replace('value todo', 'value HAND')}\nmy notes\n`);
  const edited = fs.files.get(p)!;
  const r = buildDocs(model('done'), cfg, fs, {}, { generators: gens });
  assert.deepEqual(r.refused, [{ path: p, id: 'one', reason: 'REGION_EDITED' }]);
  assert.equal(fs.files.get(p), edited);
  assert.equal(checkDocs(model('todo'), cfg, fs, {}, { generators: gens }).rows[0]!.status, 'edited');
  const f = buildDocs(model('done'), cfg, fs, {}, { generators: gens, force: true });
  assert.deepEqual(f.refused, []);
  assert.ok(fs.files.get(p)!.includes('value done') && fs.files.get(p)!.includes('my notes'));
});

test('a violation stops the whole build and writes nothing', () => {
  const fs = memfs();
  const r = buildDocs(model('todo', 'see-https://evil.example/x'), cfg, fs, {}, { generators: [gens[1]!, fake('leak', (m) => [...m.tickets.keys()].join())] });
  assert.ok(r.violations.some((v) => v.code === 'D24_VIOLATION' && v.id === 'leak'));
  assert.equal(fs.files.size, 0);
  assert.deepEqual(r.written, []);
});

test('docs.out must stay inside the repo', () => {
  for (const out of ['/abs', '../up', 'a/../../b', '.']) assert.throws(() => checkOut({ docs: { out } }), { code: 'OUT_OUTSIDE_ROOT' });
  assert.equal(checkOut({ docs: { out: 'x/y/' } }), 'x/y');
  assert.equal(planDocs(model(), { docs: { out: 'x/y' } }, {}, gens)[0]!.path, 'x/y/one.md');
});

test('output does not depend on the cwd and has no absolute path', () => {
  const a = memfs(), b = memfs();
  buildDocs(model(), cfg, a, {}, { generators: gens });
  const cwd = process.cwd();
  process.chdir('/');
  try { buildDocs(model(), cfg, b, {}, { generators: gens }); } finally { process.chdir(cwd); }
  assert.deepEqual(a.files, b.files);
});

test('docs.include changes the fingerprint (policy change makes documents stale)', () => {
  const fs = memfs();
  buildDocs(model(), cfg, fs, {}, { generators: gens });
  const c = checkDocs(model(), { docs: { include: ['names'] } }, fs, {}, { generators: gens });
  assert.ok(c.rows.every((r) => r.status === 'stale'));
});
