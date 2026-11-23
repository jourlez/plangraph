// The plugin icon: valid PNG, square, 1024 px, under 2 MB, and the committed file is exactly what scripts/make-icon.mjs generates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { render, crc32, selfCheck, encodePng, SIZE } from '../scripts/make-icon.mjs';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, '.claude-plugin/icon.png');
const png = fs.readFileSync(file);
const generated = render();

function chunks(buf) {
  const out = []; let o = 8;
  while (o < buf.length) { const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8); out.push({ type, data: buf.subarray(o + 8, o + 8 + len), crc: buf.readUInt32BE(o + 8 + len), crcBody: buf.subarray(o + 4, o + 8 + len) }); o += 12 + len; }
  return out;
}

test('icon.png is a valid PNG: signature, IHDR, IDAT and IEND with correct CRCs', () => {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const cs = chunks(png);
  assert.equal(cs[0].type, 'IHDR');
  assert.equal(cs.at(-1).type, 'IEND');
  assert.ok(cs.some((c) => c.type === 'IDAT'));
  for (const c of cs) assert.equal(crc32(c.crcBody), c.crc, `bad CRC in ${c.type}`);
  const ih = cs[0].data;
  assert.equal(ih.readUInt32BE(0), ih.readUInt32BE(4), 'must be square');
  assert.equal(ih.readUInt32BE(0), 1024);
  assert.equal(ih[8], 8); assert.equal(ih[9], 6);
  const raw = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.equal(raw.length, (1024 * 4 + 1) * 1024);
});

test('icon.png is under 2 MB (the validator limit) and within 512 to 2048 px', () => {
  assert.ok(png.length < 2 * 1024 * 1024, `${png.length} bytes`);
  assert.ok(SIZE >= 512 && SIZE <= 2048);
});

test('regenerating is deterministic: two renders are byte-identical and equal the committed icon', () => {
  const again = render();
  assert.ok(generated.png.equals(again.png), 'two renders differ');
  assert.ok(generated.png.equals(png), 'committed icon.png differs from node scripts/make-icon.mjs output: regenerate it');
});

test('the self-check passes on the real icon and fails when the critical path is erased', () => {
  const rep = selfCheck(generated.rgba);
  assert.ok(rep[32].worstShaft >= 2.5 && rep[64].worstShaft >= 2.5);
  // mutation: paint the whole canvas plain background; the path vanishes and the check must throw
  const blank = Buffer.from(generated.rgba);
  for (let i = 0; i < blank.length; i += 4) { blank[i] = 20; blank[i + 1] = 20; blank[i + 2] = 60; blank[i + 3] = 255; }
  assert.throws(() => selfCheck(blank), /contrast|warm/);
  assert.ok(encodePng(Buffer.alloc(4 * 4 * 4), 4, 4).length > 40);
});

test('plugin.json points at the icon and the file exists', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(m.icon, './.claude-plugin/icon.png');
  assert.ok(fs.existsSync(path.join(root, m.icon)));
});
