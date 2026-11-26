// spawnLines: streaming line reader over spawn, byte cap, no shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnLines } from '../lib/gitsafe.ts';

const node = process.execPath;

test('spawnLines streams lines, including a last line with no terminator', async () => {
  const got: string[] = [];
  await spawnLines(node, ['-e', "process.stdout.write('a\\nbb\\n\\nlast')"], (l) => got.push(l));
  assert.deepEqual(got, ['a', 'bb', '', 'last']);
});
test('spawnLines streams a large output past the 30 second sync limit without buffering it', async () => {
  let n = 0, bytes = 0;
  await spawnLines(node, ['-e', "for(let i=0;i<200000;i++)process.stdout.write('line '+i+'\\n')"], (l) => { n++; bytes += l.length; }, { maxBytes: 64 << 20 });
  assert.equal(n, 200000);
  assert.ok(bytes > 1_000_000);
});
test('spawnLines handles a multi-byte character split across chunks and a NUL delimiter', async () => {
  const got: string[] = [];
  await spawnLines(node, ['-e', "const b=Buffer.from('a\\0é\\0z');process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),30)"], (l) => got.push(l), { delimiter: '\0' });
  assert.deepEqual(got, ['a', 'é', 'z']);
});
test('spawnLines kills the child and rejects TOO_LARGE over the byte cap', async () => {
  await assert.rejects(
    spawnLines(node, ['-e', "setInterval(()=>process.stdout.write('x'.repeat(1000)+'\\n'),1)"], () => {}, { maxBytes: 5000 }),
    (e: NodeJS.ErrnoException) => e.code === 'TOO_LARGE');
});
test('spawnLines rejects on a non-zero exit with a short message, and on a missing program', async () => {
  await assert.rejects(spawnLines(node, ['-e', "console.error('boom');process.exit(3)"], () => {}), /exited 3: boom/);
  await assert.rejects(spawnLines('/nonexistent/prog', [], () => {}), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
});
test('spawnLines runs no shell: metacharacters in argv stay data', async () => {
  const got: string[] = [];
  await spawnLines(node, ['-e', 'console.log(process.argv[1])', '$(echo pwned); `x`'], (l) => got.push(l));
  assert.deepEqual(got, ['$(echo pwned); `x`']);
});
test('spawnLines: an onLine that throws rejects and stops', async () => {
  await assert.rejects(spawnLines(node, ['-e', "console.log('a\\nb')"], () => { throw new Error('stop'); }), /stop/);
});
