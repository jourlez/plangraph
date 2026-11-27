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
test('spawnLines: output of exactly maxBytes passes, one byte more is TOO_LARGE', async () => {
  const got: string[] = [];
  await spawnLines(node, ['-e', "process.stdout.write('x'.repeat(99)+'\\n')"], (l) => got.push(l), { maxBytes: 100 });
  assert.equal(got.length, 1);
  await assert.rejects(spawnLines(node, ['-e', "process.stdout.write('x'.repeat(100)+'\\n')"], () => {}, { maxBytes: 100 }), (e: NodeJS.ErrnoException) => e.code === 'TOO_LARGE');
});
test('spawnLines: the cap counts bytes across chunks, not one chunk', async () => {
  await assert.rejects(spawnLines(node, ['-e', "process.stdout.write('a'.repeat(60)+'\\n');setTimeout(()=>process.stdout.write('b'.repeat(60)+'\\n'),40)"], () => {}, { maxBytes: 100 }), (e: NodeJS.ErrnoException) => e.code === 'TOO_LARGE');
});
test('spawnLines: a non-zero exit rejects with GIT_FAILED after the lines it printed, and the last unterminated line is not delivered', async () => {
  const got: string[] = [];
  await assert.rejects(spawnLines(node, ['-e', "process.stdout.write('a\\nb');process.exit(5)"], (l) => got.push(l)), (e: NodeJS.ErrnoException) => e.code === 'GIT_FAILED' && /exited 5/.test(e.message));
  assert.deepEqual(got, ['a']);
});
test('spawnLines: a line split across chunks is delivered once and whole', async () => {
  const got: string[] = [];
  await spawnLines(node, ['-e', "process.stdout.write('ab');setTimeout(()=>{process.stdout.write('cd\\nef');setTimeout(()=>process.stdout.write('gh\\n'),30)},30)"], (l) => got.push(l));
  assert.deepEqual(got, ['abcd', 'efgh']);
});
test('spawnLines: only the first 400 bytes of stderr reach the message', async () => {
  await assert.rejects(spawnLines(node, ['-e', "console.error('E'.repeat(5000));process.exit(1)"], () => {}), (e: Error) => !e.message.includes('E'.repeat(201)) && e.message.includes('E'.repeat(150)));
});
test('spawnLines refuses one token over the per-line cap (1 MiB) quickly and kills the child', async () => {
  const t = Date.now();
  await assert.rejects(
    spawnLines(node, ['-e', "const c='x'.repeat(65536);let n=0;const w=()=>{while(n++<80){if(!process.stdout.write(c)){process.stdout.once('drain',w);return;}}setInterval(()=>{},1000)};w()"], () => {}),
    (e: NodeJS.ErrnoException) => e.code === 'LINE_TOO_LONG' && /line over 1048576 bytes/.test(e.message));
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});
test('spawnLines accepts a line just under the cap split over many chunks, and honors lineMax', async () => {
  const got: number[] = [];
  const prog = "const c='y'.repeat(8192);for(let i=0;i<100;i++)process.stdout.write(c);process.stdout.write('\\n'+'z'.repeat(10)+'\\n')";
  await spawnLines(node, ['-e', prog], (l) => got.push(l.length));
  assert.deepEqual(got, [819200, 10]);
  await assert.rejects(spawnLines(node, ['-e', prog], () => {}, { lineMax: 100000 }), (e: NodeJS.ErrnoException) => e.code === 'LINE_TOO_LONG');
});
test('spawnLines: a delimited token longer than lineMax inside one chunk raises LINE_TOO_LONG; a token exactly at lineMax passes', async () => {
  const at: string[] = [];
  await spawnLines(node, ['-e', "process.stdout.write('y'.repeat(1000)+'\\nz\\n')"], (l) => at.push(l.length === 1 ? l : String(l.length)), { lineMax: 1000 });
  assert.deepEqual(at, ['1000', 'z'], 'exactly lineMax is accepted');
  const got: string[] = [];
  await assert.rejects(
    spawnLines(node, ['-e', "process.stdout.write('y'.repeat(1001)+'\\nz\\n')"], (l) => got.push(l), { lineMax: 1000 }),
    (e: NodeJS.ErrnoException) => e.code === 'LINE_TOO_LONG' && /line over 1000 bytes/.test(e.message));
  assert.deepEqual(got, [], 'the oversized line is never delivered');
});
