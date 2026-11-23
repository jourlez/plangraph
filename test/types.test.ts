// Negative-type suite: proves that the exported types REJECT misuse, which no runtime test can show. Every test/types-fixtures/*-bad.ts
// file starts with `// expect: TS2322,TS2345` (the error codes it must produce, in source order). One tsc run (child process) checks all
// fixtures with test/types-fixtures/tsconfig.json (the final strict flags); each fixture must produce exactly its listed codes, in order,
// and nothing else. Errors in the library files a fixture imports are not counted here (scripts/typecheck.ts owns those); an error
// without a file position (a broken tsconfig) fails every fixture. Adding a layer = adding one `<layer>-bad.ts` file; never edit this runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'test/types-fixtures');
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');
const EXPECT = /^\/\/ expect: (TS\d+(?:,TS\d+)*)\s*$/;
const DIAG = /^(.+?)\(\d+,\d+\): error (TS\d+):/;

/** The codes named on a fixture's first line; throws when the line is missing or malformed. */
function expectedCodes(text: string, name: string): string[] {
  const m = EXPECT.exec(text.split('\n', 1)[0] ?? '');
  if (!m?.[1]) throw new Error(`${name}: the first line must be "// expect: TS1234[,TS5678...]"`);
  return m[1].split(',');
}

/** tsc's plain-text output grouped by file (repo-relative, posix), codes in output order; '(tsc)' holds errors without a position. */
function codesByFile(output: string): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const line of output.split('\n')) {
    const m = DIAG.exec(line);
    const file = m?.[1] ? path.relative(ROOT, path.resolve(ROOT, m[1])).split(path.sep).join('/') : /^error TS\d+:/.test(line) ? '(tsc)' : null;
    const code = m?.[2] ?? /^error (TS\d+):/.exec(line)?.[1];
    if (file === null || code === undefined) continue;
    const list = by.get(file) ?? [];
    list.push(code);
    by.set(file, list);
  }
  return by;
}

test('expectedCodes reads the first line and refuses a fixture without one', () => {
  assert.deepEqual(expectedCodes('// expect: TS2322,TS2345\nconst x = 1;\n', 'a-bad.ts'), ['TS2322', 'TS2345']);
  assert.deepEqual(expectedCodes('// expect: TS2741,TS2741\n', 'a-bad.ts'), ['TS2741', 'TS2741']);
  for (const bad of ['', 'const x = 1;\n// expect: TS2322', '// expect: 2322', '// expect: TS2322, TS2345', '// expects: TS2322'])
    assert.throws(() => expectedCodes(bad, 'a-bad.ts'), /a-bad\.ts: the first line must be/);
});

test('codesByFile groups positioned errors by file and keeps position-less errors apart', () => {
  const out = 'test/types-fixtures/a-bad.ts(3,7): error TS2322: no.\ntest/types-fixtures/a-bad.ts(5,1): error TS2554: no.\n  continuation line\nlib/x.ts(1,1): error TS7006: x.\nerror TS5023: Unknown compiler option.\n';
  assert.deepEqual([...codesByFile(out)], [['test/types-fixtures/a-bad.ts', ['TS2322', 'TS2554']], ['lib/x.ts', ['TS7006']], ['(tsc)', ['TS5023']]]);
});

test('every negative-type fixture produces exactly the error codes on its first line', { timeout: 300000 }, (t) => {
  const fixtures = fs.readdirSync(DIR).filter((f) => f.endsWith('-bad.ts')).sort();
  assert.ok(fixtures.length > 0, 'no *-bad.ts fixture found');
  assert.ok(fs.existsSync(TSC), 'typescript is not installed (run `npm ci`)');
  const r = spawnSync(process.execPath, [TSC, '--noEmit', '--pretty', 'false', '-p', path.join(DIR, 'tsconfig.json')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 280000 });
  assert.equal(r.error, undefined, `tsc did not run: ${r.error?.message}`);
  const by = codesByFile(`${r.stdout}\n${r.stderr}`);
  assert.deepEqual(by.get('(tsc)') ?? [], [], `tsc reported a configuration error:\n${r.stdout}${r.stderr}`);
  for (const f of fixtures) {
    const rel = `test/types-fixtures/${f}`;
    const want = expectedCodes(fs.readFileSync(path.join(DIR, f), 'utf8'), f);
    t.diagnostic(`${f}: expects ${want.join(',')}`);
    assert.deepEqual(by.get(rel) ?? [], want, `${f}: tsc output for this file:\n${r.stdout.split('\n').filter((l) => l.startsWith(rel)).join('\n')}`);
  }
});
