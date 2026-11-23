import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { assertInside, resolveBrainDir, writeAtomicSafe } from '../lib/fsafe.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'fsafe-'));
test('resolveBrainDir keeps the directory inside the repo', () => {
  const root = tmp(); assert.equal(resolveBrainDir(root, '.brain'), join(root, '.brain'));
  for (const bad of ['../x', '/etc', 'a/../../b']) assert.throws(() => resolveBrainDir(root, bad), (/** @type {any} */ e) => /outside the repository/.test(e.message) && e.code === 'OUTSIDE_REPO', bad);
});
test('resolveBrainDir truncates a long directory in the message', () => {
  const root = tmp(); const bad = '../' + 'x'.repeat(200);
  assert.throws(() => resolveBrainDir(root, bad), (/** @type {any} */ e) => e.message.length < 140);
});
test('a symlink target is never written through', () => {
  const root = tmp(), victim = join(root, 'victim.txt'); writeFileSync(victim, 'KEEP'); mkdirSync(join(root, '.brain'));
  symlinkSync(victim, join(root, '.brain', 'findings.jsonl'));
  assert.throws(() => writeAtomicSafe(join(root, '.brain', 'findings.jsonl'), 'x', { root }), (/** @type {any} */ e) => /symlink/.test(e.message) && e.code === 'SYMLINK');
  assert.throws(() => writeAtomicSafe(join(root, '.brain', 'findings.jsonl'), 'x'), /symlink/);
  assert.equal(readFileSync(victim, 'utf8'), 'KEEP');
  assert.deepEqual(readdirSync(join(root, '.brain')), ['findings.jsonl']);
});
test('a path whose parent is a symlink out of the repo is refused', () => {
  const root = tmp(), out = tmp(); symlinkSync(out, join(root, '.brain'));
  assert.throws(() => assertInside(root, join(root, '.brain', 'x.jsonl')), (/** @type {any} */ e) => /outside the repository/.test(e.message) && e.code === 'OUTSIDE_REPO');
  assert.throws(() => writeAtomicSafe(join(root, '.brain', 'x.jsonl'), 'x', { root }), /outside the repository/);
  assert.equal(existsSync(join(out, 'x.jsonl')), false);
});
test('assertInside works for missing nested paths and a symlinked root', () => {
  const real = tmp(), holder = tmp(), link = join(holder, 'link'); symlinkSync(real, link);
  const got = assertInside(link, join(link, 'a', 'b', 'c.jsonl'));
  assert.ok(got.endsWith(join('a', 'b', 'c.jsonl')));
  assert.equal(got, join(realpathSync(real), 'a', 'b', 'c.jsonl'));
});
test('writeAtomicSafe does not mkdir: parents must exist', () => {
  const root = tmp(); const f = join(root, 'a', 'b', 'f.txt');
  assert.throws(() => writeAtomicSafe(f, 'x', { root }), (/** @type {any} */ e) => e.code === 'ENOENT');
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeAtomicSafe(f, 'x', { root }); assert.equal(readFileSync(f, 'utf8'), 'x');
});
test('files named like real leftovers (<file>.tmp-<pid>-<hex>) are untouched and do not break a write', () => {
  const root = tmp(), f = join(root, 'f.txt');
  const left = [`${f}.tmp-${process.pid}-deadbeef`, `${f}.tmp-1-cafebabe`, `${f}.tmp-${process.pid}-00000000`];
  for (const l of left) writeFileSync(l, 'stale');
  writeFileSync(f, 'old');
  writeAtomicSafe(f, 'new content\n', { root });
  assert.equal(readFileSync(f, 'utf8'), 'new content\n');
  for (const l of left) assert.equal(readFileSync(l, 'utf8'), 'stale', `${l} was touched`);
  assert.deepEqual(readdirSync(root).sort(), ['f.txt', ...left.map((l) => l.slice(root.length + 1))].sort());
});
test('a dangling symlink anywhere in the path is refused, even with a missing tail', () => {
  const root = tmp(); symlinkSync('/nonexistent-brain-target', join(root, 'dangle'));
  for (const t of [join(root, 'dangle'), join(root, 'dangle', 'sub', 'x')])
    assert.throws(() => assertInside(root, t), (/** @type {any} */ e) => e.code === 'OUTSIDE_REPO' && /dangling symlink/.test(e.message), t);
  assert.throws(() => writeAtomicSafe(join(root, 'dangle', 'x'), 'x', { root }), (/** @type {any} */ e) => e.code === 'OUTSIDE_REPO');
  assert.equal(existsSync('/nonexistent-brain-target'), false);
  const out = tmp(); symlinkSync(join(out, 'later'), join(root, 'later')); // dangling today, would be created outside the repo
  assert.throws(() => assertInside(root, join(root, 'later', 'x')), /dangling symlink/);
});
test('a symlink to an existing directory inside the repo is followed; a chain of symlinks resolves', () => {
  const root = tmp(); mkdirSync(join(root, 'real')); symlinkSync('real', join(root, 'a')); symlinkSync('a', join(root, 'b'));
  assert.equal(assertInside(root, join(root, 'b', 'new', 'x')), join(realpathSync(root), 'real', 'new', 'x'));
});
test('a symlink loop is refused rather than looping', () => {
  const root = tmp(); symlinkSync('l2', join(root, 'l1')); symlinkSync('l1', join(root, 'l2'));
  assert.throws(() => assertInside(root, join(root, 'l1', 'x')), (/** @type {any} */ e) => e.code === 'OUTSIDE_REPO');
});
// realpathSync.native asks the OS for the on-disk spelling, so on a case-insensitive volume (default macOS) a differently-cased path to the
// same place is still inside. Skipped on case-sensitive filesystems, where the two spellings are different paths.
test('case-insensitive volumes: a differently-cased spelling of the root is still inside', (t) => {
  const parent = tmp(); mkdirSync(join(parent, 'Repo'));
  if (!existsSync(join(parent, 'rEPO'))) { t.skip('case-sensitive filesystem'); return; }
  assert.doesNotThrow(() => assertInside(join(parent, 'Repo'), join(parent, 'rEPO', 'a.txt')));
  assert.doesNotThrow(() => assertInside(join(parent, 'rEPO'), join(parent, 'Repo', 'a.txt')));
});
test('content is exact UTF-8 with mode 0644 and no temp files remain', () => {
  const root = tmp(), f = join(root, 'f.txt'), text = 'café ñ \u{1F600}\n';
  writeAtomicSafe(f, text, { root }); writeAtomicSafe(f, text + 'two', { root });
  assert.equal(readFileSync(f, 'utf8'), text + 'two');
  assert.equal(statSync(f).mode & 0o777, 0o644 & ~process.umask()); // temp files are created 0644 and the umask applies, so the test must not assume 022
  assert.deepEqual(readdirSync(root), ['f.txt']);
});
