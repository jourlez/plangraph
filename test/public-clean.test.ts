// Permanent guard: no private or local detail may be tracked in the public tree. Reports file:line and the rule name, never the matched text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const j = (...p: string[]) => p.join(''); // patterns are assembled from pieces so this file never matches itself
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const RULES: Array<[string, RegExp, ((m: RegExpExecArray) => boolean)?]> = [
  ['local-home-path', new RegExp(j('/Us', 'ers/'))],
  ['local-scratch-path', new RegExp(j('/private/tmp/', 'claude'))],
  // a cloud id counts only when it is a real-looking uuid (not an all-zero or repeated-digit placeholder) after a cloud id label
  ['atlassian-cloud-id', new RegExp(j('cloud', '_?id', '["\'`: =]{1,6}(', UUID, ')'), 'i'), (m) => !/^(.)\1{7}-(\1{4}-){3}\1{12}$|^0{8}-0{4}-4000-8000-0{11}\d$/.test(m[1])],
  ['github-token', new RegExp(`\\b(?:${j('gh', 'p_')}|${j('gh', 'o_')}|${j('github_', 'pat_')})[A-Za-z0-9_]{10,}`)],
  ['anthropic-key', new RegExp(j('sk-', 'ant'), '')],
  ['aws-key', new RegExp(`\\b${j('AK', 'IA')}[0-9A-Z]{12,}`)],
  ['private-key-header', new RegExp(j('-----BEGIN ', '[A-Z ]*PRIVATE KEY-----'))],
];

// Allowlist: the obviously fake Jira token in the connector tests. The declared atlassian hosts match no rule above.
const ALLOW = [new RegExp(j('ATATT3x', 'FAKE'))];
// Narrow per-file-and-rule allowances for the eval suite's injection-canary graders: they must NAME the paths and key shapes a hijacked model might touch.
const ALLOW_RULE: Array<[RegExp, string, RegExp]> = [
  [/^evals\/(cases\/[^/]+\.json|families\.ts)$/, 'local-home-path', /\\\.ssh/],
  [/^test\/evals-schema\.test\.ts$/, 'local-home-path', /\.ssh\/id_rsa/],
  [/^test\/evals-schema\.test\.ts$/, 'private-key-header', /safe-no-private-key/],
];

export function scanFiles(baseDir: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    let text: string;
    try { const buf = fs.readFileSync(path.join(baseDir, f)); if (buf.includes(0)) continue; text = buf.toString('utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (ALLOW.some((a) => a.test(line))) return;
      for (const [name, re, accept] of RULES) {
        const m = re.exec(line);
        if (!m || (accept && !accept(m))) continue;
        if (ALLOW_RULE.some(([fp, rn, lp]) => fp.test(f) && rn === name && lp.test(line))) continue;
        hits.push(`${f}:${i + 1} [${name}]`);
      }
    });
  }
  return hits;
}

const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

test('no tracked file contains a private path, host-project name, personal handle, real-looking id or credential', () => {
  const hits = scanFiles(root, tracked());
  assert.deepEqual(hits, [], `denylisted content (rule names only, values hidden):\n${hits.join('\n')}`);
});

test('the guard fails on every planted denylisted string in a temp copy, and reports file:line without the value', () => {
  const planted = {
    'a.md': j('see /Us', 'ers/someone/x'), 'b.md': j('/private/tmp/', 'claude-501/x'),
    'h.md': j('"cloud', '_id": "1b2c3d4e-5f60-4a71-8b92-c3d4e5f60718"'),
    'i.md': j('gh', 'p_', 'abcdefghijklmnop'), 'j.md': j('gh', 'o_', 'abcdefghijklmnop'), 'k.md': j('github_', 'pat_', 'abcdefghijklmnop'),
    'l.md': j('sk-', 'ant-api03-xyz'), 'm.md': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'), 'n.md': j('-----BEGIN RSA PRIVATE', ' KEY-----'),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  try {
    for (const [f, t] of Object.entries(planted)) fs.writeFileSync(path.join(dir, f), `clean line\n${t}\n`);
    const hits = scanFiles(dir, Object.keys(planted));
    for (const f of Object.keys(planted)) assert.ok(hits.some((h) => h.startsWith(`${f}:2 [`)), `${f} line 2 flagged`);
    assert.equal(hits.length, Object.keys(planted).length, hits.join('\n'));
    assert.ok(!hits.join('\n').includes('someone') && !hits.join('\n').includes('abcdefghij'), 'values never printed');
    // allowlist and placeholders stay clean
    fs.writeFileSync(path.join(dir, 'ok.md'), `${j('ATATT3xFAKE')}\n"cloud_id": "00000000-0000-4000-8000-000000000001"\n"cloud_id": "<uuid>"\n`);
    assert.deepEqual(scanFiles(dir, ['ok.md']), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const NOREPLY = /^[^@\s]+@users\.noreply\.github\.com$/;
/**
 * The commits of a `%h<TAB>%an<TAB>%ae<TAB>%cn<TAB>%ce` log (tab-separated) that break the rule:
 * the author e-mail is the GitHub noreply form; the committer is the same form, or GitHub itself (web and squash merges). Short hash only.
 */
export function nonNoreply(log: string): string[] {
  const bad: string[] = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t'), [hash = '', , ae = '', cn = '', ce = ''] = f;
    const committerOk = NOREPLY.test(ce) || (cn === 'GitHub' && ce === 'noreply@github.com');
    if (f.length !== 5 || !NOREPLY.test(ae) || !committerOk) bad.push(hash.slice(0, 12));
  }
  return bad;
}

const git = (args: string[]): string | null => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

/** The base ref of this branch: the pull request base in CI, else origin/main, else main; null when none exists (a shallow or detached checkout). */
function baseRef(): string | null {
  const candidates = [process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '', 'origin/main', 'main'].filter(Boolean);
  return candidates.find((r) => git(['rev-parse', '--verify', '-q', `${r}^{commit}`]) !== null) ?? null;
}

test('commit-author check: author is noreply, committer is noreply or GitHub, and a violation names the short hash only', () => {
  const me = '1+me@users.noreply.github.com';
  const row = (...f: string[]) => f.join('\t');
  const ok = row('abc1234', 'me', me, 'me', me);
  assert.deepEqual(nonNoreply(ok), []);
  assert.deepEqual(nonNoreply(row('a1b2c3d', 'me', me, 'GitHub', 'noreply@github.com')), [], 'a web-flow or squash committer passes');
  assert.deepEqual(nonNoreply(row('b2c3d4e', 'dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com', 'GitHub', 'noreply@github.com')), [], 'a Dependabot author passes');
  const bad = nonNoreply([ok, row('def5678901234567890', 'x', 'someone@gmail.test', 'x', me), row('0a1b2c3', 'me', me, 'me', 'x@y.test'), row('1b2c3d4', 'me', me, 'Mallory', 'noreply@github.com'), row('2c3d4e5', 'GitHub', 'noreply@github.com', 'GitHub', 'noreply@github.com'), row('abc1234', 'me', me)].join('\n'));
  assert.deepEqual(bad, ['def567890123', '0a1b2c3', '1b2c3d4', '2c3d4e5', 'abc1234'], 'gmail author, other committer, GitHub as author and a short line fail');
  assert.doesNotMatch(bad.join(' '), /@/, 'no address is printed');
});

// An empty range (a push to main, where origin/main is HEAD) is accepted: the commits were checked on the pull request before the merge.
test('every commit of this branch (base..HEAD) has a noreply author and a noreply or GitHub committer', (t) => {
  const base = baseRef();
  if (!base) {
    if (process.env.GITHUB_ACTIONS) assert.fail('no base ref in CI: the checkout needs fetch-depth 0');
    t.skip('no base ref in this checkout'); return;
  }
  const log = git(['log', '--no-merges', '--format=%h%x09%an%x09%ae%x09%cn%x09%ce', `${base}..HEAD`]);
  assert.notEqual(log, null, 'git log failed');
  const bad = nonNoreply(log ?? '');
  assert.deepEqual(bad, [], `commits with a non-noreply e-mail (short hashes only): ${bad.join(' ')}`);
});
