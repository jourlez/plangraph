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
