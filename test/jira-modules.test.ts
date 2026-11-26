// The module layout of lib/jira/ (one responsibility per module): each module loads alone, the sibling imports follow the documented order
// and stay acyclic, lib/jira.ts re-exports the frozen public list, and the helpers shared between modules (registerSecret, str) stay out
// of it. Also pins that the D11 window pass stays the last redaction pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'lib/jira');
const MODULES = ['types', 'redact', 'error', 'host', 'registry', 'credentials', 'client', 'snapshot', 'render', 'index'];
const read = (m: string) => fs.readFileSync(path.join(DIR, `${m}.ts`), 'utf8');

interface SiblingImport { from: string; typeOnly: boolean }
/** The sibling modules a lib/jira module imports (static `import` and `export ... from` declarations of `./x.ts`). */
function siblingImports(m: string): SiblingImport[] {
  const out: SiblingImport[] = [];
  for (const x of read(m).matchAll(/^(import|export)\s+(type\s+)?[^;]*?\sfrom\s+'\.\/([a-z]+)\.ts';/gms)) out.push({ from: x[3] as string, typeOnly: Boolean(x[2]) });
  for (const x of read(m).matchAll(/import\(\s*['"`]\.\/([a-z]+)\.ts/g)) out.push({ from: x[1] as string, typeOnly: false });
  return out;
}
const siblings = (m: string) => [...new Set(siblingImports(m).map((i) => i.from))].sort();
const valueSiblings = (m: string) => [...new Set(siblingImports(m).filter((i) => !i.typeOnly).map((i) => i.from))].sort();

test('the directory holds exactly the ten modules', () => {
  assert.deepEqual(fs.readdirSync(DIR).sort(), MODULES.map((m) => `${m}.ts`).sort());
});

test('each module imports alone in a child process', () => {
  for (const m of MODULES) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(DIR, `${m}.ts`))});`], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `${m}: ${r.stderr}`);
  }
});

test('every sibling import names one of the ten modules', () => {
  for (const m of MODULES) for (const s of siblings(m)) assert.ok(MODULES.includes(s) && s !== 'index', `${m} imports ./${s}.ts`);
});

test('types and redact import no sibling; error imports only redact (and types, type-only)', () => {
  assert.deepEqual(siblings('types'), []);
  assert.deepEqual(siblings('redact'), []);
  assert.deepEqual(valueSiblings('error'), ['redact']);
  for (const i of siblingImports('error')) assert.ok(i.from === 'redact' || (i.from === 'types' && i.typeOnly), `error imports ./${i.from}.ts`);
});

test('client is imported only by snapshot, render and index', () => {
  const importers = MODULES.filter((m) => siblings(m).includes('client'));
  for (const m of importers) assert.ok(['snapshot', 'render', 'index', 'provider'].includes(m), `${m} imports client`);
  assert.ok(importers.includes('index'));
});

test('the sibling imports have no cycle (a topological order exists)', () => {
  const deps = new Map(MODULES.map((m) => [m, siblings(m)]));
  const order: string[] = [];
  const left = new Set(MODULES);
  while (left.size) {
    const ready = [...left].filter((m) => (deps.get(m) ?? []).every((d) => !left.has(d)));
    assert.ok(ready.length > 0, `cycle among ${[...left].join(', ')}`);
    for (const m of ready) { left.delete(m); order.push(m); }
  }
  assert.equal(order[order.length - 1], 'index');
});

test('lib/jira.ts re-exports lib/jira/index.ts and index.ts uses explicit named re-exports', async () => {
  const facade = fs.readFileSync(path.join(ROOT, 'lib/jira.ts'), 'utf8').split('\n').filter((l) => l && !l.startsWith('//'));
  assert.deepEqual(facade, ["export * from './jira/index.ts';"]);
  const code = read('index').split('\n').filter((l) => !l.startsWith('//')).join('\n');
  assert.ok(!/export\s*\*/.test(code), 'index.ts must not use export *');
  const a = Object.keys(await import('../lib/jira.ts')).sort(), b = Object.keys(await import('../lib/jira/index.ts')).sort();
  assert.deepEqual(a, b);
  assert.equal(a.length, 25);
});

test('registerSecret and str are not exported by lib/jira.ts or lib/jira/index.ts', async () => {
  for (const mod of [await import('../lib/jira.ts'), await import('../lib/jira/index.ts')]) {
    assert.ok(!('registerSecret' in mod));
    assert.ok(!('str' in mod));
  }
  const code = read('index').split('\n').filter((l) => !l.startsWith('//')).join('\n');
  assert.ok(!/\bregisterSecret\b/.test(code));
  assert.ok(!/\bstr\b/.test(code));
});

test('the module-private helpers stay private', async () => {
  const R = await import('../lib/jira/redact.ts'), C = await import('../lib/jira/credentials.ts');
  for (const k of ['secrets', 'base64Cores']) assert.ok(!(k in R), k);
  for (const k of ['defaultExec', 'finishCreds']) assert.ok(!(k in C), k);
});

test('the D11 window pass is the last redaction pass in redact()', () => {
  const src = read('redact');
  const body = src.slice(src.indexOf('export function redact('));
  const end = body.indexOf('\n}\n');
  const fn = body.slice(0, end);
  const lastReplace = fn.lastIndexOf('s = s.replace('), lastSplit = fn.lastIndexOf('.split(sec)'), ranges = fn.indexOf('rawRanges(s)');
  assert.ok(ranges > 0 && lastReplace > 0 && lastSplit > 0);
  assert.ok(ranges > lastReplace && ranges > lastSplit, 'rawRanges must run after every other redaction pass');
  assert.equal(fn.match(/rawRanges\(/g)?.length, 1);
});

test('registerSecret makes redact hide the value, its base64 and its hex form', async () => {
  const { registerSecret, redact } = await import('../lib/jira/redact.ts');
  const v = 'modules-test-secret-Zq81';
  const b64 = Buffer.from(v).toString('base64'), hex = Buffer.from(v).toString('hex');
  assert.equal(redact(`a ${v} b ${b64} c ${hex} d`), `a ${v} b ${b64} c ${hex} d`, 'nothing is redacted before registration');
  registerSecret(v);
  assert.equal(redact(`a ${v} b ${b64} c ${hex} d`), 'a [redacted] b [redacted] c [redacted] d');
});

test('str returns a string unchanged and an empty string for any other value', async () => {
  const { str } = await import('../lib/jira/snapshot.ts');
  assert.equal(str('x y'), 'x y');
  assert.equal(str(''), '');
  for (const v of [undefined, null, 0, 1, true, {}, [], ['a'], new String('s')]) assert.equal(str(v), '');
});
