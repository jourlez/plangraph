import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedTests } from '../scripts/related-tests.ts';

const SMOKE = ['test/cli-core.test.ts', 'test/golden.test.ts'];
const ALL = ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/golden.test.ts', 'test/cli-core.test.ts'];
const SRC: Record<string, string> = {
  'test/a.test.mjs': "import { x } from '../lib/store.ts';\n",
  'test/b.test.mjs': "const m = await import('../lib/store.ts');\n",
  'test/c.test.mjs': "import { y } from '../lib/other.mjs';\nimport fs from 'node:fs';\n",
  'test/golden.test.ts': '',
  'test/cli-core.test.ts': '',
};
const read = (p: string) => SRC[p] ?? '';

test('staged source returns importing tests plus smoke files, sorted', () => {
  assert.deepEqual(relatedTests(['lib/store.ts'], ALL, read), ['test/a.test.mjs', 'test/b.test.mjs', ...SMOKE].sort());
});

test('staged test file returns itself plus smoke files', () => {
  assert.deepEqual(relatedTests(['test/c.test.mjs'], ALL, read), ['test/c.test.mjs', ...SMOKE].sort());
});

test('unrelated staged file returns only smoke files', () => {
  assert.deepEqual(relatedTests(['README.md'], ALL, read), SMOKE);
});

test('no duplicates when a smoke file is staged or imports the source', () => {
  const out = relatedTests(['lib/store.ts', 'test/golden.test.ts', 'test/a.test.mjs'], ALL, (p) => (p === 'test/golden.test.ts' ? "import '../lib/store.ts';" : read(p)));
  assert.deepEqual(out, [...new Set(out)].sort());
  assert.equal(out.filter((f) => f === 'test/golden.test.ts').length, 1);
});

test('unreadable test files are skipped', () => {
  const out = relatedTests(['lib/store.ts'], ALL, (p) => { if (p === 'test/a.test.mjs') throw new Error('boom'); return read(p); });
  assert.deepEqual(out, ['test/b.test.mjs', ...SMOKE].sort());
});

const sel = (staged: string[], files: Record<string, string>, tests = Object.keys(files).filter((f) => f.startsWith('test/'))) =>
  relatedTests(staged, [...tests, ...SMOKE], (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; });
const only = (out: string[]) => out.filter((f) => !SMOKE.includes(f));

test('transitive: test -> lib/a -> staged lib/store', () => {
  const files = { 'test/t.test.mjs': "import '../lib/a.mjs';", 'lib/a.mjs': "import { s } from './store.mjs';", 'lib/store.ts': '' };
  assert.deepEqual(only(sel(['lib/store.ts'], files)), ['test/t.test.mjs']);
});

test('diamond graph selects once', () => {
  const files = { 'test/t.test.mjs': "import '../lib/a.mjs'; import '../lib/b.mjs';", 'lib/a.mjs': "import './d.mjs';", 'lib/b.mjs': "import './d.mjs';", 'lib/d.mjs': '' };
  assert.deepEqual(only(sel(['lib/d.mjs'], files)), ['test/t.test.mjs']);
});

test('cycle terminates, and still finds the staged file', () => {
  const files = { 'test/t.test.mjs': "import '../lib/a.mjs';", 'lib/a.mjs': "import './b.mjs';", 'lib/b.mjs': "import './a.mjs'; import './c.mjs';", 'lib/c.mjs': '' };
  assert.deepEqual(only(sel(['lib/c.mjs'], files)), ['test/t.test.mjs']);
  assert.deepEqual(only(sel(['lib/zzz.mjs'], files)), []);
});

test('extension-less specifier', () => {
  assert.deepEqual(only(sel(['lib/store.ts'], { 'test/t.test.mjs': "import '../lib/store';" })), ['test/t.test.mjs']);
});

test('index file, with and without trailing slash', () => {
  for (const spec of ['../lib', '../lib/']) assert.deepEqual(only(sel(['lib/index.mjs'], { 'test/t.test.mjs': `import x from '${spec}';` })), ['test/t.test.mjs']);
});

test('query string and fragment are ignored', () => {
  assert.deepEqual(only(sel(['lib/store.ts'], { 'test/t.test.mjs': "await import('../lib/store.ts?v=1');" })), ['test/t.test.mjs']);
  assert.deepEqual(only(sel(['lib/store.ts'], { 'test/t.test.mjs': "import '../lib/store.ts#x';" })), ['test/t.test.mjs']);
});

test('template-literal dynamic import', () => {
  assert.deepEqual(only(sel(['lib/store.ts'], { 'test/t.test.mjs': 'await import(`../lib/store.ts`);' })), ['test/t.test.mjs']);
});

test('a staged .ts file matches a .mjs specifier', () => {
  assert.deepEqual(only(sel(['lib/store.ts'], { 'test/t.test.mjs': "import '../lib/store.ts';" })), ['test/t.test.mjs']);
});
