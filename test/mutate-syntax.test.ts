// The syntax gate of scripts/mutate-all.ts: a TypeScript file with a generic call (which `node --check` alone rejects) passes, a real syntax
// error fails, and a plain .js file is checked as it is. NOT covered: running mutants.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syntaxOk } from '../scripts/mutate-all.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchk-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const put = (name: string, text: string) => { fs.writeFileSync(path.join(dir, name), text); return name; };

test('a generic call in a .ts file is valid; a missing operand is not', async () => {
  assert.equal(await syntaxOk(dir, put('a.ts', 'const s = new Set<string>();\nexport const n: number = s.size;\n')), true);
  assert.equal(await syntaxOk(dir, put('b.ts', 'const s = new Set<string>();\nexport const n: number = ;\n')), false);
  assert.equal(await syntaxOk(dir, put('c.ts', 'export const n: number = (1 + );\n')), false);
});

test('a .js file is checked as it is', async () => {
  assert.equal(await syntaxOk(dir, put('d.js', 'const n = 1;\n')), true);
  assert.equal(await syntaxOk(dir, put('e.js', 'const n = ;\n')), false);
});

test('type aliases and interfaces are not mutated, runtime code beside them is', async () => {
  const { mutantsFor } = await import('../scripts/mutate-all.ts');
  const src = [
    "export type Mode = 'a' | 'b';",
    'export type Code =',
    "  | 'x' | 'y'",
    "  | 'z';",
    "export interface Shape { kind: 'k' | 'l'; ok: true; nested: { f: false } }",
    "interface Other<T> { v: 'v' }",
    "const answer = 'real';",
    "export const flag = true;",
  ].join('\n');
  const m = mutantsFor('x.ts', src);
  assert.deepEqual([...new Set(m.map((x) => x.line))], [7, 8]);
  assert.ok(m.some((x) => x.op === 'string') && m.some((x) => x.op === 'boolean'));
  // a variable named type, or a value after it, is untouched by the rule
  const plain = mutantsFor('y.ts', "const type = 'a';\ntype = 'b';\nconst o = { type: 'c' };");
  assert.equal(plain.length, 3);
});
