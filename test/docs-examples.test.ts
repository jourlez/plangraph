// Documentation examples: every fenced command marked `# runs` in docs/GETTING-STARTED.md and in the README is executed, in order, in a temp
// copy of one small synthetic project (a scripted git repository: two authors, a plan document, three source files), and its output is compared
// with the fenced block that follows it. Fingerprints, nonces-of-the-index and the temp path are normalized (normalizeGolden), so a moved
// temp directory or a changed hash does not break a doc, while any changed word, count or line does.
// Format of a doc: a block holding one line `plangraph ARGS   # runs` (or `# runs exit N` for a command that exits non-zero on purpose), then the
// next fenced block is the expected output (stdout, then stderr when there is any). Blocks are run top to bottom in one project per document.
// NOT covered: the commands that need a network, `gh` or Jira (takeover runs with --no-fetch), the interactive prompt of uninstall, and how GitHub
// renders the page. The synthetic project is built here, so a doc that names another project is not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeProject, docsEnv, normalizeDoc } from './helpers/docs-project.ts';

const root = path.resolve(import.meta.dirname, '..');
const BIN = path.join(root, 'bin/plangraph');

export interface Step { line: number; args: string[]; exit: number; expected: string }
/** The runnable steps of a document: a fenced block whose only content is `plangraph ARGS # runs`, and the fenced block right after it. */
export function parseSteps(md: string): Step[] {
  const blocks = [...md.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].map((m) => ({ body: m[1], line: md.slice(0, m.index).split('\n').length }));
  const steps: Step[] = [];
  blocks.forEach((b, i) => {
    const m = /^plangraph ([^\n#]*?)\s+# runs(?: exit (\d))?\n?$/.exec(b.body);
    if (!m) return;
    const next = blocks[i + 1];
    assert.ok(next, `line ${b.line}: a runs block has no output block after it`);
    steps.push({ line: b.line, args: m[1].split(/\s+/).filter(Boolean), exit: m[2] ? Number(m[2]) : 0, expected: next.body.replace(/\s+$/, '') });
  });
  return steps;
}

function runDoc(file: string, mustRun: string[][]): void {
  const md = fs.readFileSync(path.join(root, file), 'utf8'); // throws before the document exists
  const steps = parseSteps(md);
  const seen = steps.map((s) => s.args[0]);
  for (const want of mustRun) assert.ok(steps.some((s) => want.every((w, i) => s.args[i] === w)), `${file} has no runs block for: plangraph ${want.join(' ')}`);
  const p = makeProject();
  try {
    for (const s of steps) {
      const r = spawnSync(process.execPath, [BIN, ...s.args], { cwd: p.dir, env: docsEnv(p.home), encoding: 'utf8', timeout: 120000 });
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.status, s.exit, `${file}:${s.line} plangraph ${s.args.join(' ')} exited ${r.status}: ${r.stderr}`);
      const got = normalizeDoc(r.stdout + (r.stderr ? `--- stderr\n${r.stderr}` : ''), p.dir);
      assert.equal(got, normalizeDoc(s.expected, p.dir), `${file}:${s.line} the output of plangraph ${s.args.join(' ')} differs from the document`);
    }
  } finally { p.cleanup(); }
  assert.ok(seen.length >= mustRun.length);
}

test('the example parser finds runs blocks, their exit code and the block after them', () => {
  const steps = parseSteps('x\n\n```bash\nplangraph check   # runs\n```\n\n```text\nok\n```\n\n```bash\nplangraph verify --strict # runs exit 1\n```\n```text\nbad\n```\n\n```bash\nplangraph map\n```\n');
  assert.deepEqual(steps.map((s) => [s.args, s.exit, s.expected]), [[['check'], 0, 'ok'], [['verify', '--strict'], 1, 'bad']]);
  assert.throws(() => parseSteps('```bash\nplangraph map # runs\n```\n'), /no output block/);
});

test('normalization keeps a changed count and drops only a fingerprint and the temp path', () => {
  assert.equal(normalizeDoc('plangraph 0123abcd | 4 tickets in /tmp/x/p', '/tmp/x/p'), 'plangraph <FP> | 4 tickets in <repo>');
  assert.notEqual(normalizeDoc('plangraph 0123abcd | 4 tickets', '/x'), normalizeDoc('plangraph 0123abcd | 5 tickets', '/x'));
});

test('docs/GETTING-STARTED.md: every runs block prints what the document shows', () => {
  runDoc('docs/GETTING-STARTED.md', [['init'], ['takeover', '--no-fetch'], ['build'], ['check'], ['map'], ['context'], ['flow', 'next'], ['docs-build'], ['docs', 'check']]);
});

test('README.md: every runs block prints what the README shows', () => {
  runDoc('README.md', [['init'], ['sp-ingest'], ['build'], ['check'], ['verify'], ['ready'], ['whatif']]);
});
