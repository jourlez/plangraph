// scripts/ts-migrate.ts on temp git repositories only (no real plugin file is renamed by this test).
// Covered: the file is renamed with git mv; relative imports (static, dynamic, export-from, bare) are rewritten only when they resolve to a
// renamed file; exact repo-relative paths are rewritten in docs, config, goldens and string literals of code; never by basename alone
// (other/b.mjs, sub/lib/b.mjs and ../lib/b.mjs stay); test/fixtures/** is untouched; a second call does nothing; a half-finished run
// (renamed, not rewritten) is completed by the next call; a dry run changes nothing; bad input throws; the CLI works.
// NOT covered: a path assembled from pieces at run time (the type check and the tests find those).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { migrate } from '../scripts/ts-migrate.ts';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'ts-migrate.ts');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

const FILES = {
  'a.mjs': "import { b } from './lib/b.mjs';\nexport const lazy = () => import('./lib/b.mjs');\nexport { b } from './lib/b.mjs';\nimport './lib/b.mjs';\n",
  'lib/b.mjs': 'export const b = 1;\n',
  'lib/d.mjs': "import { b } from './b.mjs';\nimport { o } from '../other/b.mjs';\nimport fs from 'node:fs';\nexport { b, o, fs };\n",
  'other/b.mjs': 'export const o = 2;\n',
  'sub/e.mjs': "import './lib/b.mjs';\nexport const note = 'sub/lib/b.mjs';\n",
  'c.mjs': "export const c = 3; // mentions nothing\n",
  'docs.md': 'See lib/b.mjs and ./lib/b.mjs here, but not sub/lib/b.mjs, ../lib/b.mjs, lib/b.mjs.map or other/b.mjs.\n',
  'cfg.json': '{ "entry": "lib/b.mjs", "other": "other/b.mjs" }\n',
  'run.js': "const f = 'lib/b.mjs';\nconst g = './lib/b.mjs';\nmodule.exports = [f, g];\n",
  'test/fixtures/x.md': 'fixture mentions lib/b.mjs\n',
  'test/fixtures/p.mjs': "import './lib/b.mjs';\n",
  'test/golden/g.txt': 'golden lib/b.mjs and other/b.mjs\n',
  'bin/tool': "#!/usr/bin/env node\nawait import('../lib/b.mjs');\n",
  'blob.bin': Buffer.from([0, 1, 2, 0x6c, 0x69, 0x62, 0x2f, 0x62, 0x2e, 0x6d, 0x6a, 0x73]),
};

function makeRepo(files: Record<string, string | Buffer> = FILES) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-migrate-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'a@example.test');
  git(dir, 'config', 'user.name', 'tester');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

test('renames with git mv and rewrites imports, paths and literals, only for exact repo-relative paths', () => {
  const dir = makeRepo();
  try {
    const r = migrate(['lib/b.mjs'], { root: dir });
    assert.deepEqual(r.renamed, ['lib/b.mjs']);
    assert.ok(fs.existsSync(path.join(dir, 'lib/b.ts')) && !fs.existsSync(path.join(dir, 'lib/b.mjs')));
    assert.match(git(dir, 'status', '--porcelain'), /R {2}lib\/b\.mjs -> lib\/b\.ts/);
    assert.equal(read(dir, 'a.mjs'), FILES['a.mjs'].replaceAll('./lib/b.mjs', './lib/b.ts'));
    assert.equal(read(dir, 'lib/d.mjs'), FILES['lib/d.mjs'].replace("'./b.mjs'", "'./b.ts'"), 'sibling import rewritten, ../other/b.mjs kept');
    assert.equal(read(dir, 'sub/e.mjs'), FILES['sub/e.mjs'], './lib/b.mjs from sub/ resolves to sub/lib/b.mjs: not a renamed file');
    assert.equal(read(dir, 'bin/tool'), FILES['bin/tool'].replace('b.mjs', 'b.ts'), 'extension-less node entry points are code');
    assert.equal(read(dir, 'docs.md'), 'See lib/b.ts and ./lib/b.ts here, but not sub/lib/b.mjs, ../lib/b.mjs, lib/b.mjs.map or other/b.mjs.\n');
    assert.equal(read(dir, 'cfg.json'), '{ "entry": "lib/b.ts", "other": "other/b.mjs" }\n');
    assert.equal(read(dir, 'run.js'), "const f = 'lib/b.ts';\nconst g = './lib/b.ts';\nmodule.exports = [f, g];\n", 'repo-path literal and ./ literal that resolves to the renamed file');
    assert.equal(read(dir, 'test/golden/g.txt'), 'golden lib/b.ts and other/b.mjs\n');
    assert.equal(read(dir, 'test/fixtures/x.md'), FILES['test/fixtures/x.md']);
    assert.equal(read(dir, 'test/fixtures/p.mjs'), FILES['test/fixtures/p.mjs']);
    assert.equal(read(dir, 'c.mjs'), FILES['c.mjs']);
    assert.equal(read(dir, 'other/b.mjs'), FILES['other/b.mjs']);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'blob.bin')), FILES['blob.bin'], 'binary files are skipped');
    assert.deepEqual(r.rewritten, ['a.mjs', 'bin/tool', 'cfg.json', 'docs.md', 'lib/d.mjs', 'run.js', 'test/golden/g.txt']);
    // a second call renames and rewrites nothing
    assert.deepEqual(migrate(['lib/b.mjs'], { root: dir }), { renamed: [], rewritten: [], skipped: [] });
    assert.equal(read(dir, 'docs.md'), 'See lib/b.ts and ./lib/b.ts here, but not sub/lib/b.mjs, ../lib/b.mjs, lib/b.mjs.map or other/b.mjs.\n');
  } finally { cleanup(dir); }
});

test('several files at once; a path inside another renamed path is rewritten once and never doubled', () => {
  const dir = makeRepo({ 'lib/x.mjs': 'export const x = 1;\n', 'lib/xx.mjs': "import { x } from './x.mjs';\nexport { x };\n", 'n.md': 'lib/xx.mjs lib/x.mjs\n' });
  try {
    const r = migrate(['lib/xx.mjs', 'lib/x.mjs'], { root: dir });
    assert.deepEqual(r.renamed, ['lib/x.mjs', 'lib/xx.mjs']);
    assert.equal(read(dir, 'n.md'), 'lib/xx.ts lib/x.ts\n');
    assert.equal(read(dir, 'lib/xx.ts'), "import { x } from './x.ts';\nexport { x };\n");
    assert.deepEqual(migrate(['lib/x.mjs', 'lib/xx.mjs'], { root: dir }), { renamed: [], rewritten: [], skipped: [] });
  } finally { cleanup(dir); }
});

test('a half-finished run (renamed by hand, nothing rewritten) is completed by the next call', () => {
  const dir = makeRepo();
  try {
    git(dir, 'mv', 'lib/b.mjs', 'lib/b.ts');
    const r = migrate(['lib/b.mjs'], { root: dir });
    assert.deepEqual(r.renamed, []);
    assert.ok(r.rewritten.includes('docs.md') && r.rewritten.includes('a.mjs'));
    assert.equal(read(dir, 'cfg.json'), '{ "entry": "lib/b.ts", "other": "other/b.mjs" }\n');
  } finally { cleanup(dir); }
});

test('a dry run reports the same result and changes nothing', () => {
  const dir = makeRepo();
  try {
    const dry = migrate(['lib/b.mjs'], { root: dir, dryRun: true });
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.ok(fs.existsSync(path.join(dir, 'lib/b.mjs')));
    assert.deepEqual(migrate(['lib/b.mjs'], { root: dir }), dry);
  } finally { cleanup(dir); }
});

test('bad input throws: not .mjs, absolute, outside the repo, untracked, target already there', () => {
  const dir = makeRepo({ 'a.mjs': 'export {};\n', 'a.ts': 'export {};\n', 'b.md': 'x\n' });
  try {
    for (const bad of ['b.md', path.join(dir, 'a.mjs'), '../a.mjs', 'missing.mjs']) assert.throws(() => migrate([bad], { root: dir }), /ts-migrate/, bad);
    assert.throws(() => migrate(['a.mjs'], { root: dir }), /a\.ts already exists/);
    assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing changed');
  } finally { cleanup(dir); }
});

test('CLI: renames and reports; usage error exits 2; a bad file exits 1', () => {
  const dir = makeRepo();
  try {
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: dir, encoding: 'utf8' });
    let r = run();
    assert.equal(r.status, 2); assert.match(r.stderr, /usage:/);
    r = run('nope.mjs');
    assert.equal(r.status, 1); assert.match(r.stderr, /not a tracked file/);
    r = run('--dry-run', 'lib/b.mjs');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /would rename 1 file\(s\)/);
    r = run('lib/b.mjs');
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^renamed 1 file\(s\), rewrote 7 file\(s\)/);
    assert.ok(fs.existsSync(path.join(dir, 'lib/b.ts')));
  } finally { cleanup(dir); }
});

/** one repo, one renamed file lib/x.mjs, importers given as {path: text}; returns the text of each importer after migrate */
function after(importers: Record<string, string>, target = 'lib/x.mjs') {
  const dir = makeRepo({ [target]: 'export const x = 1;\n', ...importers });
  try {
    const r = migrate([target], { root: dir });
    return { out: Object.fromEntries(Object.keys(importers).map((f) => [f, read(dir, f)])), r };
  } finally { cleanup(dir); }
}

test('every reference form that resolves to the renamed file is rewritten; query and hash suffixes are kept', () => {
  const forms = [
    "new URL('./lib/x.mjs', import.meta.url)", 'new URL("./lib/x.mjs", import.meta.url)', "new URL('./lib/x.mjs?v=1', import.meta.url)",
    "require('./lib/x.mjs')", "import.meta.resolve('./lib/x.mjs')", 'import(`./lib/x.mjs`)', "path.join(root, './lib/x.mjs')",
    "'./lib/x.mjs?x=1'", "'./lib/x.mjs#h'", "import a from './lib/x.mjs'", 'import a from "./lib/x.mjs"', "export * from './lib/x.mjs'",
    "import './lib/x.mjs'", "import {a,\n b} from\n'./lib/x.mjs'", "await import('./lib/x.mjs')",
  ];
  const { out } = after({ 'top.mjs': `${forms.map((f) => `${f};`).join('\n')}\n` });
  assert.equal(out['top.mjs'], `${forms.map((f) => `${f.replace('lib/x.mjs', 'lib/x.ts')};`).join('\n')}\n`);
  const nested = after({ 'test/t.mjs': "new URL('../lib/x.mjs', import.meta.url); new URL(\"../lib/x.mjs\", import.meta.url); import('../lib/x.mjs?q#h');\n", 'lib/sib.mjs': "require('./x.mjs'); import.meta.resolve('./x.mjs');\n" });
  assert.equal(nested.out['test/t.mjs'], "new URL('../lib/x.ts', import.meta.url); new URL(\"../lib/x.ts\", import.meta.url); import('../lib/x.ts?q#h');\n");
  assert.equal(nested.out['lib/sib.mjs'], "require('./x.ts'); import.meta.resolve('./x.ts');\n");
});

test('look-alikes are not rewritten: ./x.mjs.bak, ./x.mjs2, lib/xy.mjs, other directories, template substitutions, run-time pieces', () => {
  const src = [
    "import './lib/x.mjs.bak';", "import './lib/x.mjs2';", "import './lib/xy.mjs';", "import './other/lib/x.mjs';", "import '../lib/x.mjs';",
    "import(`./lib/${name}.mjs`);", "path.join('lib', 'x.mjs');", "'x' + '.mjs';", "import 'pkg/lib/x.mjs';",
  ].join('\n') + '\n';
  const { out } = after({ 'top.mjs': src, 'lib/xy.mjs': 'export {};\n' });
  assert.equal(out['top.mjs'], src);
});

test('docs: x/lib/a.mjs, ../lib/a.mjs and lib/ab.mjs stay; a path in a code fence, in CRLF text and without a trailing newline is rewritten byte for byte', () => {
  const dir = makeRepo({
    'lib/a.mjs': 'export {};\n', 'lib/ab.mjs': 'export {};\n',
    'doc.md': 'x/lib/a.mjs ../lib/a.mjs lib/ab.mjs and lib/a.mjs\n```js\nimport "./lib/a.mjs"; // lib/a.mjs\n```\n',
    'crlf.md': 'one lib/a.mjs\r\ntwo\r\nlast lib/a.mjs', 'tool': "#!/usr/bin/env node\nimport './lib/a.mjs'", 'empty.md': '',
  });
  try {
    migrate(['lib/a.mjs'], { root: dir });
    assert.equal(read(dir, 'doc.md'), 'x/lib/a.mjs ../lib/a.mjs lib/ab.mjs and lib/a.ts\n```js\nimport "./lib/a.ts"; // lib/a.ts\n```\n');
    assert.equal(read(dir, 'crlf.md'), 'one lib/a.ts\r\ntwo\r\nlast lib/a.ts');
    assert.equal(read(dir, 'tool'), "#!/usr/bin/env node\nimport './lib/a.ts'");
    assert.equal(read(dir, 'lib/ab.mjs'), 'export {};\n');
  } finally { cleanup(dir); }
});

test('a symlink is skipped (never followed or rewritten)', () => {
  const dir = makeRepo({ 'lib/a.mjs': 'export {};\n', 'real.md': 'see lib/a.mjs\n' });
  try {
    fs.symlinkSync('real.md', path.join(dir, 'link.md'));
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'link');
    const r = migrate(['lib/a.mjs'], { root: dir });
    assert.deepEqual(r.rewritten, ['real.md']);
    assert.equal(fs.readlinkSync(path.join(dir, 'link.md')), 'real.md');
  } finally { cleanup(dir); }
});

test('a batch with a bad file leaves the repository untouched (validation before any move)', () => {
  const dir = makeRepo({ 'a.mjs': 'export {};\n', 'b.mjs': 'export {};\n', 'b.ts': 'export {};\n', 'd.md': 'a.mjs\n' });
  try {
    assert.throws(() => migrate(['a.mjs', 'b.mjs'], { root: dir }), /b\.ts already exists/);
    assert.throws(() => migrate(['a.mjs', 'nope.mjs'], { root: dir }), /not a tracked file/);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.ok(fs.existsSync(path.join(dir, 'a.mjs')));
    assert.equal(read(dir, 'd.md'), 'a.mjs\n');
  } finally { cleanup(dir); }
});

test('a non-UTF-8 file that names a renamed path is left byte for byte and reported in skipped; a clean Latin-1 file is not reported', () => {
  const latin = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' lib/a.mjs\n')]);
  const clean = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' nothing here\n')]);
  const dir = makeRepo({ 'lib/a.mjs': 'export {};\n', 'latin.txt': latin, 'clean.txt': clean, 'ok.md': 'lib/a.mjs\n' });
  try {
    const r = migrate(['lib/a.mjs'], { root: dir });
    assert.deepEqual(fs.readFileSync(path.join(dir, 'latin.txt')), latin);
    assert.deepEqual(r.skipped, ['latin.txt']);
    assert.deepEqual(r.rewritten, ['ok.md']);
  } finally { cleanup(dir); }
});

test('a tracked file deleted from the working tree is skipped and reported, not a crash', () => {
  const dir = makeRepo({ 'lib/a.mjs': 'export {};\n', 'gone.md': 'lib/a.mjs\n', 'here.md': 'lib/a.mjs\n' });
  try {
    fs.rmSync(path.join(dir, 'gone.md'));
    const r = migrate(['lib/a.mjs'], { root: dir });
    assert.deepEqual(r.skipped, ['gone.md']);
    assert.deepEqual(r.rewritten, ['here.md']);
    assert.ok(fs.existsSync(path.join(dir, 'lib/a.ts')));
  } finally { cleanup(dir); }
});
