// M4: globRe is a linear matcher (no regex backtracking), identical in meaning to the former regex, and the schema refuses a glob with more than 8 wildcards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { globRe, ownersFor, parseCodeowners } from '../lib/graph/repo.ts';
import { validators } from '../lib/schema.ts';

// the former implementation, kept here as the oracle for the semantics
const oldRe = (pattern: string): RegExp => {
  const dirOnly = pattern.endsWith('/'), p = dirOnly ? pattern.slice(0, -1) : pattern, anchored = p.startsWith('/') || p.includes('/'), body = (p.startsWith('/') ? p.slice(1) : p)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*');
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:/|$)'}`);
};

test('the catastrophic pattern returns at once', () => {
  const t = Date.now();
  assert.equal(globRe('/' + '**a'.repeat(12) + 'c').test('a'.repeat(60)), false);
  assert.equal(globRe('/' + '*a'.repeat(30) + 'c').test('a'.repeat(200)), false);
  assert.ok(Date.now() - t < 50, `${Date.now() - t} ms`);
  assert.equal(globRe('/' + '**a'.repeat(12) + 'c').test(`${'a'.repeat(60)}c`), true);
});

test('matching is identical to the former regex on a table of patterns and paths', () => {
  const patterns = ['*', '**', '/', '/*', '/**', 'src', 'src/', '/src', '/src/', 'src/api/', 'src/**', '**/x.ts', 'a/**/b', 'a/**b', '*.md', '/docs/*.md', 'docs/', 'a?c', '/a?c/', 'a.b', 'a+b', '(x)', 'a[b]', 'x/*/y', '***', 'a**', '**a', '*/', '**/', 'a\\b', '$x', '^x', '', 'x/y/'];
  const paths = ['', '/', 'src', 'src/', 'src/x.ts', 'src/api/h.ts', 'a/b', 'a/x/b', 'a/x/y/b', 'a/xb', 'axb', 'a.b', 'a+b', 'aXb', '(x)', 'a[b]', 'x/y', 'x/q/y', 'x/q/r/y', 'docs/a.md', 'docs/sub/a.md', 'a.md', 'z/a.md', 'abc', 'a/c', 'a/bc/', 'a\\b', '$x', '^x', 'x/y/z', 'lib/x.ts', 'x.ts', 'a\nb', 'sub/src/x', 'sub/src/', 'ab/', 'dir/'];
  for (const pat of patterns) {
    const old = oldRe(pat), now = globRe(pat);
    for (const p of paths) assert.equal(now.test(p), old.test(p), `${JSON.stringify(pat)} vs ${JSON.stringify(p)}`);
  }
});

test('matching equals the former regex on random small patterns and paths', () => {
  let seed = 7; const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pa = ['a', 'b', '*', '**', '?', '/', '.', 'ab'], pp = ['a', 'b', '/', '.', 'ab', 'c'];
  for (let i = 0; i < 3000; i++) {
    const pat = Array.from({ length: 1 + rnd(6) }, () => pa[rnd(pa.length)]).join(''), old = oldRe(pat), now = globRe(pat);
    for (let j = 0; j < 8; j++) {
      const s = Array.from({ length: rnd(8) }, () => pp[rnd(pp.length)]).join('');
      assert.equal(now.test(s), old.test(s), `${JSON.stringify(pat)} vs ${JSON.stringify(s)}`);
    }
  }
});

test('ownersFor keeps working and a hostile CODEOWNERS pattern is fast', () => {
  const rules = parseCodeowners(`* @a\n/docs/ @b\n${'/' + '**a'.repeat(12) + 'c'} @evil\n`);
  const t = Date.now();
  assert.deepEqual(ownersFor(rules, `${'a'.repeat(60)}`), ['@a']);
  assert.ok(Date.now() - t < 50);
});

test('the schema refuses a glob with more than 8 wildcards as a bad schema, in repos paths and decision affects', () => {
  const ok = { id: 'repo:x', paths: [{ glob: 'a/**/b/*.ts', sub: 'a' }] };
  assert.equal(validators['repos.jsonl']?.(ok), null);
  const bad = { id: 'repo:x', paths: [{ glob: `/${'**a'.repeat(12)}c`, sub: 'a' }] };
  assert.match(String(validators['repos.jsonl']?.(bad)), /wildcards/);
  assert.equal(validators['decisions.jsonl']?.({ id: 'd', affects: ['a/**/b'] }), null);
  assert.match(String(validators['decisions.jsonl']?.({ id: 'd', affects: [`${'*a'.repeat(9)}`] })), /wildcards/);
  assert.equal(validators['repos.jsonl']?.({ id: 'repo:x', paths: [{ glob: '*a'.repeat(8), sub: 'a' }] }), null, 'exactly 8 is allowed');
});
