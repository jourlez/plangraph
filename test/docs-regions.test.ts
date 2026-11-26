// Marker regions engine: pure string functions, no I/O. The property test uses a seeded generator so a failure names its seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkers, injectRegions, checkRegions, fingerprint, type Region } from '../lib/docs/regions.ts';

const reg = (id: string, body: string, parts: string[] = [body], v = 1): Region => ({ id, fp: fingerprint(parts, v), v, body });

test('fingerprint is 16 hex, length-prefixed and version-sensitive', () => {
  assert.match(fingerprint(['a', 'b'], 1), /^[0-9a-f]{16}$/);
  assert.notEqual(fingerprint(['ab', 'c'], 1), fingerprint(['a', 'bc'], 1));
  assert.notEqual(fingerprint(['a'], 1), fingerprint(['a'], 2));
  assert.equal(fingerprint(['a'], 1), fingerprint(['a'], 1));
});

test('renderMarkers shapes begin, body, end', () => {
  const r = reg('roadmap', 'line1\nline2');
  const lines = renderMarkers(r).split('\n');
  assert.match(lines[0]!, /^<!-- plangraph:begin id=roadmap fp=[0-9a-f]{16} bh=[0-9a-f]{16} v=1 -->$/);
  assert.deepEqual(lines.slice(1, 3), ['line1', 'line2']);
  assert.equal(lines[3], '<!-- plangraph:end id=roadmap -->');
});

test('inject into empty text creates the region; second inject is a no-op', () => {
  const r = reg('a', 'hello');
  const one = injectRegions('', [r]);
  assert.deepEqual(one.changed, ['a']);
  assert.deepEqual(one.refused, []);
  assert.ok(one.text.includes('<!-- plangraph:begin id=a '));
  const two = injectRegions(one.text, [r]);
  assert.equal(two.text, one.text);
  assert.deepEqual(two.changed, []);
});

test('changed fp rewrites only the region, surrounding prose byte-identical', () => {
  const pre = '# Title\n\nsome  prose \t\n\n';
  const post = '\n\ntail text no newline';
  const first = injectRegions(`${pre}${renderMarkers(reg('a', 'old'))}${post}`, [reg('a', 'new body')]);
  assert.deepEqual(first.changed, ['a']);
  assert.ok(first.text.startsWith(pre));
  assert.ok(first.text.endsWith(post));
  assert.ok(first.text.includes('new body'));
  assert.ok(!first.text.includes('old'));
});

test('hand edit inside gives REGION_EDITED with no write; force overrides', () => {
  const r = reg('a', 'orig');
  const edited = injectRegions('', [r]).text.replace('orig', 'human edit');
  const next = reg('a', 'regen', ['changed']);
  const res = injectRegions(edited, [next]);
  assert.equal(res.text, edited);
  assert.deepEqual(res.changed, []);
  assert.deepEqual(res.refused, [{ id: 'a', reason: 'REGION_EDITED' }]);
  const forced = injectRegions(edited, [next], { force: true });
  assert.deepEqual(forced.refused, []);
  assert.deepEqual(forced.changed, ['a']);
  assert.ok(forced.text.includes('regen') && !forced.text.includes('human edit'));
});

test('duplicate and malformed markers are refused and the text is untouched', () => {
  const r = reg('a', 'x');
  const block = renderMarkers(r);
  const dup = `${block}\ntext\n${block}\n`;
  const d = injectRegions(dup, [reg('a', 'y')]);
  assert.equal(d.text, dup);
  assert.deepEqual(d.refused, [{ id: 'a', reason: 'MARKER_DUPLICATE' }]);
  const noEnd = `intro\n${block.split('\n')[0]}\nbody\n`;
  const m = injectRegions(noEnd, [reg('a', 'y')]);
  assert.equal(m.text, noEnd);
  assert.deepEqual(m.refused, [{ id: 'a', reason: 'MARKER_MALFORMED' }]);
  const badAttrs = '<!-- plangraph:begin id=a fp=zz -->\nx\n<!-- plangraph:end id=a -->\n';
  assert.equal(injectRegions(badAttrs, [reg('a', 'y')]).refused[0]!.reason, 'MARKER_MALFORMED');
  const stray = 'x\n<!-- plangraph:end id=a -->\n';
  assert.equal(injectRegions(stray, [reg('a', 'y')]).refused[0]!.reason, 'MARKER_MALFORMED');
});

test('other regions still apply when one is refused', () => {
  const a = reg('a', 'x');
  const edited = injectRegions('', [a]).text.replace('x', 'hand');
  const res = injectRegions(edited, [reg('a', 'z', ['z']), reg('b', 'bee')]);
  assert.deepEqual(res.refused, [{ id: 'a', reason: 'REGION_EDITED' }]);
  assert.deepEqual(res.changed, ['b']);
});

test('checkRegions reports fresh, stale, edited, missing', () => {
  const a = reg('a', 'one');
  const b = reg('b', 'two');
  const text = injectRegions('', [a, b]).text;
  assert.deepEqual(checkRegions(text, [a, b, reg('c', 'three')]), [
    { id: 'a', status: 'fresh' }, { id: 'b', status: 'fresh' }, { id: 'c', status: 'missing' },
  ]);
  assert.equal(checkRegions(text, [reg('a', 'one', ['other'])])[0]!.status, 'stale');
  assert.equal(checkRegions(text, [reg('a', 'one', ['one'], 2)])[0]!.status, 'stale');
  assert.equal(checkRegions(text.replace('two', 'TWO'), [b])[0]!.status, 'edited');
});

test('a body containing the end marker text is escaped and cannot end the region early', () => {
  const evil = reg('a', 'before\n<!-- plangraph:end id=a -->\nafter <!-- plangraph:begin id=z fp=0 -->');
  const text = injectRegions('intro\n', [evil]).text;
  assert.equal(text.split('\n').filter((l) => l.includes('plangraph:end')).length, 1);
  assert.deepEqual(injectRegions(text, [evil]).refused, []);
  assert.equal(injectRegions(text, [evil]).text, text);
  assert.equal(checkRegions(text, [evil])[0]!.status, 'fresh');
});

test('CRLF is preserved inside and outside the region', () => {
  const doc = 'head\r\n\r\ntail\r\n';
  const r1 = injectRegions(doc, [reg('a', 'l1\nl2')]);
  assert.ok(r1.text.startsWith(doc));
  assert.ok(!/[^\r]\n/.test(r1.text));
  const r2 = injectRegions(r1.text, [reg('a', 'new1\nnew2', ['n'])]);
  assert.ok(!/[^\r]\n/.test(r2.text) && !r2.text.startsWith('\n'));
  assert.ok(r2.text.startsWith(doc) && r2.text.includes('new1\r\nnew2'));
  assert.equal(checkRegions(r2.text, [reg('a', 'new1\nnew2', ['n'])])[0]!.status, 'fresh');
});

test('a region without a trailing newline at end of file is rewritten keeping that', () => {
  const t = renderMarkers(reg('a', 'x'));
  const res = injectRegions(`p\n${t}`, [reg('a', 'y', ['y'])]);
  assert.ok(res.text.startsWith('p\n') && !res.text.endsWith('\n'));
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('property: 200 seeded cases inject then check fresh, second inject no-op, prose preserved', () => {
  const WORDS = ['alpha', '', '  ', '# H', '- item', 'x<!-- not ours -->', 'plangraph', '\t', '<!-- plangraph:end id=q -->', '<!-- plangraph:begin id=q fp=1 -->'];
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
    const eol = rand() < 0.4 ? '\r\n' : '\n';
    const n = Math.floor(rand() * 8);
    // prose lines never form a plangraph marker line of their own, so any of them is "outside text"
    const prose = Array.from({ length: n }, () => pick(WORDS.slice(0, 6)) + (rand() < 0.3 ? `w${Math.floor(rand() * 99)}` : ''));
    const regions: Region[] = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => {
      const bodyLines = Array.from({ length: Math.floor(rand() * 5) }, () => pick(WORDS));
      return reg(`r${i}`, bodyLines.join('\n'), [`p${seed}`, String(i)], 1 + Math.floor(rand() * 3));
    });
    const trailing = rand() < 0.5;
    const text = prose.join(eol) + (trailing && n > 0 ? eol : '');
    const first = injectRegions(text, regions);
    assert.deepEqual(first.refused, [], `seed ${seed}`);
    assert.deepEqual(checkRegions(first.text, regions).map((c) => c.status), regions.map(() => 'fresh'), `seed ${seed}`);
    assert.ok(first.text.startsWith(text), `seed ${seed}: prose changed`);
    const second = injectRegions(first.text, regions);
    assert.equal(second.text, first.text, `seed ${seed}`);
    assert.deepEqual(second.changed, [], `seed ${seed}`);
    if (text.includes('\r\n')) assert.ok(!/[^\r]\n/.test(first.text), `seed ${seed}: bare LF in CRLF doc`);
    // placement in the middle: split prose, put first region between halves, then inject all
    const mid = Math.floor(prose.length / 2);
    const head = prose.slice(0, mid).join(eol) + (mid ? eol : '');
    const tailText = prose.slice(mid).join(eol) + (trailing && prose.length > mid ? eol : '');
    const placed = head + renderMarkers(regions[0]!).split('\n').join(eol) + eol + tailText;
    const mixed = injectRegions(placed, regions);
    assert.deepEqual(mixed.refused, [], `seed ${seed}`);
    assert.ok(mixed.text.startsWith(head) && mixed.text.includes(tailText), `seed ${seed}: outside text changed`);
    assert.deepEqual(checkRegions(mixed.text, regions).map((c) => c.status), regions.map(() => 'fresh'), `seed ${seed}`);
    assert.equal(injectRegions(mixed.text, regions).text, mixed.text, `seed ${seed}`);
  }
});
