// Deterministic plugin icon: a 1024x1024 PNG drawn by a small software rasterizer (supersampled anti-aliasing) and a hand-written
// PNG encoder (CRC32 + node:zlib). No dependencies, no clock, no randomness: the same code always yields the same bytes.
// Usage: node scripts/make-icon.ts [--out <file>] [--check]
//   (default out: .claude-plugin/icon.png; --check regenerates in memory and exits 1 if the file on disk differs)
// The picture: a small directed graph (six nodes, arrowheads) on a deep indigo rounded square. One chain, the "critical path",
// is warm amber; the other edges and nodes are a cool light blue. No text, no logo.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SIZE = 1024;
const SS = 4; // 4x4 samples per pixel

// ---------- layout (in 1024 space) ----------
const OFF = { x: -8, y: -21 };
const P = (x: number, y: number) => ({ x: x + OFF.x, y: y + OFF.y });
export interface Disc { x: number; y: number; r: number; hot: boolean }
interface Shape { x0: number; y0: number; ux: number; uy: number; s: number; shaftEnd: number; tip: number; w: number; head: number; hw: number }
type Rgb = number[];
export const NODES: Record<string, Disc> = {
  a: { ...P(262, 700), r: 54, hot: true },
  b: { ...P(452, 470), r: 54, hot: true },
  c: { ...P(682, 562), r: 54, hot: true },
  d: { ...P(776, 300), r: 54, hot: true },
  e: { ...P(504, 772), r: 40, hot: false },
  f: { ...P(300, 300), r: 40, hot: false },
};
export const EDGES: Array<[string, string, boolean]> = [
  ['a', 'b', true], ['b', 'c', true], ['c', 'd', true],
  ['f', 'b', false], ['a', 'e', false], ['e', 'c', false],
];

// ---------- colours ----------
const hex = (h: number) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const BG_TL = hex(0x2a1f6b), BG_BR = hex(0x0b0e29);
const COOL = hex(0xaebfff), COOL_NODE = hex(0xcfd9ff);
const WARM_A = hex(0xffc15a), WARM_B = hex(0xff8a3c);
const mix = (a: Rgb, b: Rgb, t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------- geometry ----------
const GAP = 14;
function edgeShape(from: Disc, to: Disc, hot: boolean): Shape {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const w = hot ? 28 : 15, head = hot ? 56 : 38, hw = hot ? 38 : 26;
  const s = from.r + GAP, tip = len - to.r - GAP;
  return { x0: from.x, y0: from.y, ux, uy, s, shaftEnd: tip - head + 2, tip, w, head, hw };
}
const SHAPES = EDGES.map(([f, t, hot]) => ({ hot, ...edgeShape(NODES[f], NODES[t], hot) }));

// coverage test of one edge (shaft + arrowhead) at a point
function inEdge(e: Shape, px: number, py: number) {
  const rx = px - e.x0, ry = py - e.y0;
  const t = rx * e.ux + ry * e.uy, n = Math.abs(-rx * e.uy + ry * e.ux);
  if (t >= e.s && t <= e.shaftEnd && n <= e.w / 2) return true;
  if (t >= e.tip - e.head && t <= e.tip) return n <= (e.hw * (e.tip - t)) / e.head;
  return false;
}

const R_CORNER = 232;
function roundedSquareAlpha(x: number, y: number) {
  const c = SIZE / 2, h = c - R_CORNER;
  const qx = Math.abs(x - c) - h, qy = Math.abs(y - c) - h;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) <= R_CORNER ? 1 : 0;
}

// colour of one sample, or null when outside the rounded square
function sample(x: number, y: number) {
  if (!roundedSquareAlpha(x, y)) return null;
  // background: diagonal gradient plus a soft light in the upper left
  const g = Math.min(1, Math.max(0, (x + y) / (2 * SIZE)));
  let col = mix(BG_TL, BG_BR, g ** 0.9);
  const gl = Math.exp(-Math.hypot(x - 260, y - 220) / 380) * 0.22;
  col = mix(col, [120, 110, 230], gl);
  // glow under the critical path
  let glow = 0;
  for (const e of SHAPES) if (e.hot) {
    const rx = x - e.x0, ry = y - e.y0, t = Math.min(Math.max(rx * e.ux + ry * e.uy, e.s), e.tip);
    glow = Math.max(glow, Math.exp(-Math.hypot(rx - e.ux * t, ry - e.uy * t) / 34));
  }
  for (const n of Object.values(NODES)) if (n.hot) glow = Math.max(glow, Math.exp(-Math.max(Math.hypot(x - n.x, y - n.y) - n.r, 0) / 34));
  col = mix(col, [255, 150, 70], glow * 0.2);
  // cool edges, then cool nodes, then warm edges and nodes on top
  for (const e of SHAPES) if (!e.hot && inEdge(e, x, y)) col = mix(col, COOL, 0.9);
  for (const n of Object.values(NODES)) if (!n.hot && Math.hypot(x - n.x, y - n.y) <= n.r) col = COOL_NODE;
  const warm = mix(WARM_A, WARM_B, Math.min(1, Math.max(0, (x - 200 + (y - 250) * 0.0) / 700)));
  for (const e of SHAPES) if (e.hot && inEdge(e, x, y)) col = warm;
  for (const n of Object.values(NODES)) if (n.hot) {
    const d = Math.hypot(x - n.x, y - n.y);
    if (d <= n.r) col = d <= n.r * 0.36 ? BG_BR : warm; // hot nodes are rings: a dark core reads as a vertex at small sizes
  }
  return col;
}

// ---------- rasterizer: returns RGBA bytes (SIZE*SIZE*4) ----------
export function rasterize() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, hit = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
        const c = sample(x + (i + 0.5) * step, y + (j + 0.5) * step);
        if (c) { r += c[0]; g += c[1]; b += c[2]; hit++; }
      }
      const o = (y * SIZE + x) * 4;
      if (hit) { px[o] = Math.round(r / hit); px[o + 1] = Math.round(g / hit); px[o + 2] = Math.round(b / hit); px[o + 3] = Math.round((255 * hit) / (SS * SS)); }
    }
  }
  return px;
}

// ---------- PNG encoder ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf: Uint8Array) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng(rgba: Buffer, w: number, h: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- self-check: the highlighted path must survive downscaling ----------
export function downscale(rgba: Buffer, factor: number) {
  const n = SIZE / factor, out = new Float64Array(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < factor; j++) for (let i = 0; i < factor; i++) {
      const o = ((y * factor + j) * SIZE + x * factor + i) * 4, al = rgba[o + 3] / 255;
      r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al;
    }
    const o = (y * n + x) * 3;
    if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
  }
  return { n, data: out };
}
const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Returns measurements at 32 and 64 px; throws when the critical path is not clearly visible.
export interface Measure { worstShaft: number; worstHotNode: number; warmness: number; coolness: number }
export function selfCheck(rgba: Buffer): Record<number, Measure> {
  const report: Record<number, Measure> = {};
  for (const size of [32, 64]) {
    const { n, data } = downscale(rgba, SIZE / size);
    const at = (x: number, y: number) => { const px = Math.min(n - 1, Math.max(0, Math.floor((x / SIZE) * n))), py = Math.min(n - 1, Math.max(0, Math.floor((y / SIZE) * n))); const o = (py * n + px) * 3; return [data[o], data[o + 1], data[o + 2]]; };
    const bg = at(880, 140); // plain background near the corner, inside the rounded square
    const warmPts: number[][] = [];
    // sample along each critical shaft (the middle third) at the pixel it lands in
    for (const e of SHAPES) if (e.hot) { const t = (e.s + e.shaftEnd) / 2; warmPts.push(at(e.x0 + e.ux * t, e.y0 + e.uy * t)); }
    const nodeHot = Object.values(NODES).filter((nd) => nd.hot).map((nd) => at(nd.x + nd.r * 0.7, nd.y)); // the ring, off the dark core
    const coolNode = Object.values(NODES).filter((nd) => !nd.hot).map((nd) => at(nd.x, nd.y));
    const worstShaft = Math.min(...warmPts.map((c) => contrast(c, bg)));
    const worstHotNode = Math.min(...nodeHot.map((c) => contrast(c, bg)));
    const warmness = Math.min(...[...warmPts, ...nodeHot].map((c) => c[0] - c[2]));
    const coolness = Math.max(...coolNode.map((c) => c[0] - c[2]));
    report[size] = { worstShaft, worstHotNode, warmness, coolness };
    if (worstShaft < 2.5) throw new Error(`critical shaft contrast ${worstShaft.toFixed(2)} at ${size}px is below 2.5`);
    if (worstHotNode < 3.5) throw new Error(`critical node contrast ${worstHotNode.toFixed(2)} at ${size}px is below 3.5`);
    if (warmness < 60) throw new Error(`critical path is not warm enough at ${size}px (R-B ${warmness.toFixed(0)})`);
    if (coolness > 0) throw new Error(`cool nodes are not cool at ${size}px (R-B ${coolness.toFixed(0)})`);
  }
  return report;
}

export function render() { const px = rasterize(); return { png: encodePng(px, SIZE, SIZE), rgba: px }; }

if (import.meta.main) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const out = oi >= 0 ? args[oi + 1] : path.join(import.meta.dirname, '..', '.claude-plugin', 'icon.png');
  const { png, rgba } = render();
  const rep = selfCheck(rgba);
  for (const [s, r] of Object.entries(rep)) console.log(`${s}px: shaft contrast ${r.worstShaft.toFixed(2)}, hot node contrast ${r.worstHotNode.toFixed(2)}, warm R-B ${r.warmness.toFixed(0)}, cool R-B ${r.coolness.toFixed(0)}`);
  if (args.includes('--check')) {
    if (!fs.existsSync(out) || !fs.readFileSync(out).equals(png)) { console.error(`${out} differs from the regenerated icon`); process.exit(1); }
    console.log('icon is up to date');
  } else { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, png); console.log(`wrote ${out} (${png.length} bytes)`); }
}
