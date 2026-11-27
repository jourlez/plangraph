// `plangraph resolve` called through the `commands` export with a minimal fake ctx: the exit code, the missing plan directory and the line caps.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands } from '../src/commands/resolve.ts';
import { nodePath } from '../lib/store2/layout.ts';

const bases: string[] = [];
after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
function fixture(planDir = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-resolve-'))); bases.push(root);
  const dir = path.join(root, '.plangraph'); if (planDir) fs.mkdirSync(dir);
  const out: string[] = [], data: Array<Record<string, unknown>> = [];
  const ctx = { root, dir, flags: {}, env: {}, config: () => ({}), io: { out: (s: string) => out.push(s), err: () => undefined, raw: () => undefined, outBlock: () => undefined, data: (d: Record<string, unknown>) => data.push(d) } } as never;
  const put = (id: string, text: string) => { const p = nodePath(dir, 'ticket', id); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return { ctx, dir, out, data, put };
}
const run = (ctx: never) => (commands.resolve as { run: (c: never, a: never) => number }).run(ctx, { values: {}, positionals: [] } as never);
const SCALAR = (id: string) => `id "${id}"\n<<<<<<< HEAD\nowner "x"\n=======\nowner "y"\n>>>>>>> t\n`;
const LINKS = (id: string) => `id "${id}"\n<<<<<<< HEAD\nmembers "a"\n=======\nmembers "b"\n>>>>>>> t\n`;

test('resolve is a soft text writer taking no argument', () => {
  assert.equal(commands.resolve?.guard, 'soft');
  assert.equal(commands.resolve?.writes, 'text');
  assert.deepEqual(commands.resolve?.positionals, [0, 0]);
});
test('resolve without a plan directory is refused', () => {
  assert.throws(() => run(fixture(false).ctx), (e: Error & { code?: string }) => e.code === 'NO_PLANGRAPH');
});
test('a union-resolvable conflict exits 0 and says how many files were resolved', () => {
  const f = fixture(); f.put('T-1', LINKS('T-1'));
  assert.equal(run(f.ctx), 0);
  assert.deepEqual(f.out.at(-1), 'resolve: 1 file resolved');
  assert.equal(f.data[0]?.resolved, 1); assert.equal(f.data[0]?.left, 0);
});
test('a scalar conflict is left for a person: exit 1 and a line naming the field', () => {
  const f = fixture(); f.put('T-1', SCALAR('T-1'));
  assert.equal(run(f.ctx), 1);
  assert.ok(f.out.some((l) => /^left .*: field owner \(line 2\) needs a person$/.test(l)), f.out.join('|'));
  assert.equal(f.out.at(-1), 'resolve: 0 resolved, 1 left for a person');
});
test('a clean store prints one line and exits 0', () => {
  const f = fixture();
  assert.equal(run(f.ctx), 0);
  assert.equal(f.out.length, 1);
});
test('the printed lines and the json lists are capped (20 lines, 50 entries) while the counts are exact', () => {
  const f = fixture();
  for (let i = 0; i < 55; i++) f.put(`S-${i}`, SCALAR(`S-${i}`));
  for (let i = 0; i < 25; i++) f.put(`M-${i}`, LINKS(`M-${i}`));
  assert.equal(run(f.ctx), 1);
  assert.equal(f.out.filter((l) => l.startsWith('resolved ')).length, 20);
  assert.equal(f.out.filter((l) => l.startsWith('left ')).length, 20);
  const d = f.data[0] as { resolved: number; left: number; files: unknown[]; conflicts: unknown[] };
  assert.equal(d.resolved, 25); assert.equal(d.left, 55);
  assert.equal(d.files.length, 25); assert.equal(d.conflicts.length, 50);
});
