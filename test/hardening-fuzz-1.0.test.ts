// Hardening (task 33, Review Focus 4 and 6): malformed bytes in every kind of file the 1.0 formats add (entity files under nodes/, event, run and
// schedule batch files, CURRENT, config.json, format.json, the git-ignored caches, the index, generated documents, ADR and requirement documents) and
// every new command run over each. Every command exits with a known code (0, 1, 2 or 4, never a crash or a thrown error), prints no stack trace and
// no raw system error, keeps its messages to a few short lines, and `check` names the damaged file. A FIFO in a data directory must not hang anything.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { trustFile } from '../lib/fetch/trust.ts';
import { world, run, git, cleanup } from './helpers/hook-world.ts';

const BIN = path.join(import.meta.dirname, '../bin/plangraph');
const env = { PLANGRAPH_STRICT_OUT: '1', PLANGRAPH_PROMPT_HOOK: 'on' };
let BASE: { root: string; dir: string };
const copies: string[] = [];

const nodeFile = (dir: string, kind: string): string => {
  const base = path.join(dir, 'nodes', kind);
  for (const h of fs.readdirSync(base).sort()) for (const f of fs.readdirSync(path.join(base, h)).sort()) if (f.endsWith('.pg')) return path.join(base, h, f);
  throw new Error(`no ${kind} node`);
};
const rel = (dir: string, f: string): string => path.relative(dir, f).split(path.sep).join('/');

before(async () => {
  BASE = world();
  const { root, dir } = BASE;
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/reqs.md'), '# R\n\nThe system shall be fast.\n\nThe system shall be safe.\n');
  fs.writeFileSync(path.join(root, 'docs/adr/0001-x.md'), '# 1. Use x\n\nDate: 2026-01-01\n\n## Status\n\nAccepted\n\n## Decision\n\nWe use x.\n');
  for (const argv of [['ingest', 'requirements', 'docs/reqs.md'], ['ingest', 'docs', 'docs/adr/0001-x.md'], ['build'], ['flow-claim', 'ABC-1', '--by', 'ana'], ['flow-progress', 'ABC-1', '--to', 'in_progress', '--by', 'ana'], ['flow-link', 'ABC-2', 'jira', 'ABC-2'], ['docs-build'], ['refresh', '--fast', '--quiet']]) {
    const r = await run(root, argv, { env });
    assert.ok(r.code === 0, `${argv.join(' ')}: ${r.code} ${r.err.join('|')}`);
  }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'documents and plan nodes');
  // an event batch the fixture knows how to read, a run file, a git cache and a trust record
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cache/git.jsonl'), `${JSON.stringify({ repo: 'repo:x', path: 'src', churn: 3, authors: [], bus1: false, hotspot: false })}\n`);
});
after(() => { cleanup(); for (const d of copies) fs.rmSync(d, { recursive: true, force: true }); });

/** A fresh copy of the base world (the plan lives in `.plangraph`, the repository around it). */
function copy(): { root: string; dir: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(BASE.root), 'fz-'))); copies.push(root);
  fs.cpSync(BASE.root, root, { recursive: true });
  return { root, dir: path.join(root, '.plangraph') };
}

type Mut = { name: string; apply: (w: { root: string; dir: string }) => string | null; spawn?: boolean };
const BADLINES = ['not json', '{"task":5}', '[1,2]', 'null', '{"at":"x","task":"ABC-1","to":"done"}', '', '{', '\u0000\u0000', 'x'.repeat(2 * 1024 * 1024)].join('\n') + '\n';
const mutateNode = (kind: string, f: (t: string) => string): Mut['apply'] => ({ dir }) => { const p = nodeFile(dir, kind); fs.writeFileSync(p, f(fs.readFileSync(p, 'utf8'))); return rel(dir, p); };
const caseSensitive = ((): boolean => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')); try { fs.writeFileSync(path.join(d, 'a'), ''); return !fs.existsSync(path.join(d, 'A')); } finally { fs.rmSync(d, { recursive: true, force: true }); } })();

const MUTS: Mut[] = [
  { name: 'ticket node: id line missing', apply: mutateNode('ticket', (t) => t.split('\n').slice(1).join('\n')) },
  { name: 'ticket node: a field with no value', apply: mutateNode('ticket', (t) => `${t}summary\n`) },
  { name: 'ticket node: a repeated scalar field', apply: mutateNode('ticket', (t) => `${t}summary "a"\nsummary "b"\n`) },
  { name: 'ticket node: wrong JSON types (sp string, summary number, links object)', apply: mutateNode('ticket', (t) => `${t.replace(/^sp .*$/m, 'sp "five"').replace(/^summary .*$/m, 'summary 7')}links {"rel":1}\nxrefs "x"\n`) },
  { name: 'ticket node: conflict markers', apply: mutateNode('ticket', (t) => `<<<<<<< HEAD\n${t}=======\n${t}>>>>>>> other\n`) },
  { name: 'ticket node: a 100 KB line', apply: mutateNode('ticket', (t) => `${t}note "${'x'.repeat(100 * 1024)}"\n`) },
  { name: 'ticket node: NUL bytes', apply: mutateNode('ticket', (t) => `${t}note "a\u0000b"\n\u0000\n`) },
  { name: 'ticket node: binary garbage', apply: ({ dir }) => { const p = nodeFile(dir, 'ticket'); fs.writeFileSync(p, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) & 255))); return rel(dir, p); } },
  { name: 'ticket node: empty file', apply: mutateNode('ticket', () => '') },
  { name: 'ticket node: CRLF and no trailing newline', apply: mutateNode('ticket', (t) => t.replace(/\n/g, '\r\n').trimEnd()) },
  { name: 'requirement node: wrong types (status number, acceptance object, text array)', apply: mutateNode('requirement', (t) => `${t.replace(/^status .*$/m, 'status 5').replace(/^text .*$/m, 'text ["a"]')}acceptance {"a":1}\n`) },
  { name: 'requirement node: conflict markers', apply: mutateNode('requirement', (t) => `${t}<<<<<<< HEAD\nlinks {"rel":"a","to":"b"}\n=======\nlinks {"rel":"c","to":"d"}\n>>>>>>> x\n`) },
  { name: 'ticket node: a field name with a bad character', apply: ({ dir }) => { const p = nodeFile(dir, 'ticket'); fs.writeFileSync(p, `${fs.readFileSync(p, 'utf8')}bad!name 1\n`); return rel(dir, p); } },
  { name: 'duplicate ids: the same node under a second directory', apply: ({ dir }) => { const p = nodeFile(dir, 'requirement'), q = path.join(dir, 'nodes/requirement/zz'); fs.mkdirSync(q); fs.copyFileSync(p, path.join(q, path.basename(p))); return rel(dir, path.join(q, path.basename(p))); } },
  { name: 'a node file under a name that does not match its id', apply: ({ dir }) => { const p = nodeFile(dir, 'requirement'), q = p.replace('~', '~0'); fs.renameSync(p, q); return rel(dir, q); } },
  { name: 'case-colliding file names', apply: ({ dir }) => { if (!caseSensitive) return null; const p = nodeFile(dir, 'requirement'); fs.copyFileSync(p, path.join(path.dirname(p), path.basename(p).toUpperCase().replace('.PG', '.pg'))); return rel(dir, path.join(path.dirname(p), path.basename(p).toUpperCase().replace('.PG', '.pg'))); } },
  { name: 'a node file that is a symlink to another file', apply: ({ dir }) => { const p = nodeFile(dir, 'ticket'), t = path.join(dir, 'config.json'); fs.rmSync(p); fs.symlinkSync(t, p); return rel(dir, p); } },
  { name: 'a node file that is a symlink to /etc/passwd', apply: ({ dir }) => { const p = nodeFile(dir, 'ticket'); fs.rmSync(p); fs.symlinkSync('/etc/passwd', p); return rel(dir, p); } },
  { name: 'a node file that is a dangling symlink', apply: ({ dir }) => { const p = nodeFile(dir, 'ticket'); fs.rmSync(p); fs.symlinkSync('/nonexistent/x', p); return rel(dir, p); } },
  { name: 'a symlink loop in nodes/', apply: ({ dir }) => { const p = path.join(dir, 'nodes/ticket/loop'); fs.symlinkSync(path.join(dir, 'nodes/ticket'), p); return rel(dir, p); } },
  { name: 'a node directory that is a symlink out of the plan', apply: ({ dir }) => { const p = path.join(dir, 'nodes/requirement/76'); fs.rmSync(p, { recursive: true }); fs.symlinkSync('/tmp', p); return rel(dir, p); } },
  { name: 'a FIFO where a node file should be', spawn: true, apply: ({ dir }) => { const p = nodeFile(dir, 'ticket'); fs.rmSync(p); execFileSync('mkfifo', [p]); return rel(dir, p); } },
  { name: 'a FIFO named like an events batch', spawn: true, apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'events/2026-11'), { recursive: true }); const p = path.join(dir, 'events/2026-11/ana.aaaaaaaa.01.jsonl'); execFileSync('mkfifo', [p]); return rel(dir, p); } },
  { name: 'a FIFO as schedules/CURRENT', spawn: true, apply: ({ dir }) => { const p = path.join(dir, 'schedules/CURRENT'); fs.rmSync(p); execFileSync('mkfifo', [p]); return rel(dir, p); } },
  { name: 'a FIFO as the cache file git.jsonl', spawn: true, apply: ({ dir }) => { const p = path.join(dir, 'cache/git.jsonl'); fs.rmSync(p); execFileSync('mkfifo', [p]); return null; } },
  { name: 'events file: bad lines of every kind', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'events/2026-11'), { recursive: true }); const f = path.join(dir, 'events/2026-11/ana.aaaaaaaa.01.jsonl'); fs.writeFileSync(f, BADLINES); return rel(dir, f); } },
  { name: 'events file: conflict markers', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'events/2026-11'), { recursive: true }); const f = path.join(dir, 'events/2026-11/ana.bbbbbbbb.01.jsonl'); fs.writeFileSync(f, '<<<<<<< HEAD\n{"at":"2026-11-26T10:00:00Z","seq":1,"actor":"ana","task":"ABC-1","to":"claimed","by":"ana","bh8":"bbbbbbbb"}\n=======\n>>>>>>> x\n'); return rel(dir, f); } },
  { name: 'events file: a symlink', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'events/2026-11'), { recursive: true }); const f = path.join(dir, 'events/2026-11/ana.cccccccc.01.jsonl'); fs.symlinkSync('/etc/passwd', f); return rel(dir, f); } },
  { name: 'events file: a compact file with bad lines', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'events/2026-10'), { recursive: true }); const f = path.join(dir, 'events/2026-10/_compact.dddddddd.jsonl'); fs.writeFileSync(f, BADLINES); return rel(dir, f); } },
  { name: 'runs file: bad lines', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'runs/learnings/2026-11'), { recursive: true }); const f = path.join(dir, 'runs/learnings/2026-11/ffffffff.jsonl'); fs.writeFileSync(f, BADLINES); return rel(dir, f); } },
  { name: 'runs file: an unknown kind with garbage', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, 'runs/zzz/2026-11'), { recursive: true }); const f = path.join(dir, 'runs/zzz/2026-11/eeeeeeee.jsonl'); fs.writeFileSync(f, BADLINES); return rel(dir, f); } },
  { name: 'schedules/CURRENT missing', apply: ({ dir }) => { fs.rmSync(path.join(dir, 'schedules/CURRENT')); return 'schedules/CURRENT'; } },
  { name: 'schedules/CURRENT names a version that does not exist', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'schedules/CURRENT'), 'v9-deadbeef\n'); return 'schedules/CURRENT'; } },
  { name: 'schedules/CURRENT with conflict markers', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'schedules/CURRENT'), '<<<<<<< HEAD\nv1-c7deadbd\n=======\nv2-aaaaaaaa\n>>>>>>> x\n'); return 'schedules/CURRENT'; } },
  { name: 'schedules/CURRENT with NUL bytes and a huge line', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'schedules/CURRENT'), `\u0000${'v'.repeat(100000)}\n`); return 'schedules/CURRENT'; } },
  { name: 'a schedule version file with bad lines', apply: ({ dir }) => { const v = fs.readdirSync(path.join(dir, 'schedules')).find((n) => n.startsWith('v1-')) as string; fs.writeFileSync(path.join(dir, 'schedules', v), BADLINES); return `schedules/${v}`; } },
  { name: 'schedules directory missing', apply: ({ dir }) => { fs.rmSync(path.join(dir, 'schedules'), { recursive: true }); return null; } },
  { name: 'config.json: not JSON', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'config.json'), '{ nope'); return null; } },
  { name: 'config.json: wrong types for docs, fetch, history, identity', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ first_sprint: 1, docs: 5, fetch: [], history: 'x', identity: [1], project_keys: 7, jira: { tenant: 4, jql: [] } })); return null; } },
  { name: 'config.json: a docs.out that leaves the repository', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ first_sprint: 1, docs: { out: '../../outside', commit_out: '/etc' } })); return null; } },
  { name: 'config.json: a symlink', apply: ({ dir }) => { fs.rmSync(path.join(dir, 'config.json')); fs.symlinkSync('/etc/passwd', path.join(dir, 'config.json')); return null; } },
  { name: 'format.json: garbage', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'format.json'), '\u0000\u0000{'); return null; } },
  { name: 'format.json: a future version', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'format.json'), '{"format":99}'); return null; } },
  { name: 'meta.jsonl: bad lines', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'meta.jsonl'), BADLINES); return null; } },
  { name: 'cache/git.jsonl: bad lines', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'cache/git.jsonl'), BADLINES); return null; } },
  { name: 'cache/github.jsonl and confluence.jsonl: bad lines', apply: ({ dir }) => { for (const n of ['github', 'confluence', 'jira']) fs.writeFileSync(path.join(dir, `cache/${n}.jsonl`), BADLINES); return null; } },
  { name: 'cache/trusted.json, identities.json and prompt-seen: garbage', apply: ({ dir }) => { for (const n of ['identities.json', 'prompt-seen', 'takeover.json', 'github.cursor', 'jira.cursor']) fs.writeFileSync(path.join(dir, 'cache', n), '\u0000{"a":[1,'); return null; } },
  { name: 'cache is a file, not a directory', apply: ({ dir }) => { fs.rmSync(path.join(dir, 'cache'), { recursive: true }); fs.writeFileSync(path.join(dir, 'cache'), 'x'); return null; } },
  { name: 'the index file is garbage', apply: ({ dir }) => { fs.writeFileSync(path.join(dir, 'plangraph.sqlite'), Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 13) & 255))); return null; } },
  { name: 'the index file is a symlink', apply: ({ dir }) => { fs.rmSync(path.join(dir, 'plangraph.sqlite')); fs.symlinkSync('/etc/passwd', path.join(dir, 'plangraph.sqlite')); return null; } },
  { name: 'a stale transaction directory with a half-written file', apply: ({ dir }) => { fs.mkdirSync(path.join(dir, '.txn/dead/nodes'), { recursive: true }); fs.writeFileSync(path.join(dir, '.txn/dead/nodes/x.pg'), 'id "x"\n'); return null; } },
  { name: 'a generated document edited inside a region, with a broken marker', apply: ({ root }) => { const d = path.join(root, 'docs/plangraph'); const f = fs.readdirSync(d)[0] as string; fs.writeFileSync(path.join(d, f), `<!-- plangraph:begin x -->\nhand edit\n<!-- plangraph:begin y -->\n\u0000`); return null; } },
  { name: 'docs/plangraph is a symlink out of the repository', apply: ({ root }) => { fs.rmSync(path.join(root, 'docs/plangraph'), { recursive: true }); fs.symlinkSync('/tmp', path.join(root, 'docs/plangraph')); return null; } },
  { name: 'the ADR and requirements documents: NUL bytes, a 2 MB line, a symlink to /etc/passwd', apply: ({ root }) => { fs.writeFileSync(path.join(root, 'docs/adr/0001-x.md'), `# 1. a\u0000b\n\n## Status\n\nAccepted\n\n${'y'.repeat(2 * 1024 * 1024)}\n`); fs.rmSync(path.join(root, 'docs/reqs.md')); fs.symlinkSync('/etc/passwd', path.join(root, 'docs/reqs.md')); return null; } },
  { name: 'the documents are FIFOs', spawn: true, apply: ({ root }) => { fs.rmSync(path.join(root, 'docs/reqs.md')); execFileSync('mkfifo', [path.join(root, 'docs/reqs.md')]); return null; } },
  { name: 'a hook script directory that is a file', apply: ({ root }) => { fs.writeFileSync(path.join(root, '.githooks'), 'x'); return null; } },
];

const CMDS: string[][] = [
  ['check'], ['build'], ['map'], ['map', '-v'], ['context', 'ABC-1'], ['context', '--branch'], ['flow', 'next'], ['flow', 'brief', 'ABC-1'], ['flow', 'status'], ['flow', 'actions'],
  ['flow-claim', 'ABC-4', '--by', 'bo'], ['flow-progress', 'ABC-1', '--to', 'done', '--evidence', 'test:x', '--by', 'ana'], ['flow-done', 'ABC-2', '--evidence', 'test:x', '--by', 'ana'], ['flow-link', 'ABC-3', 'jira', 'ABC-3'],
  ['docs', 'list'], ['docs', 'check'], ['docs', 'export', 'roadmap'], ['docs-build'], ['docs-build', '--commit-ready'],
  ['ingest', 'docs'], ['ingest', 'docs', 'docs/adr/0001-x.md'], ['ingest', 'requirements', 'docs/reqs.md'], ['ingest', 'requirements', 'docs/reqs.md', '--prune'], ['ingest', 'links'], ['ingest', 'git'],
  ['identity', 'list'], ['identity', 'propose'], ['identity-map', 'jira:x', 'Ana'], ['sync-fetch'], ['trust', 'github:example/widgets'],
  ['refresh', '--fast'], ['refresh', '--fast', '--quiet'], ['hook-prompt'], ['githooks-install', '--dry-run'], ['githooks-install'], ['resolve'], ['fmt'], ['compact', '--ci'], ['takeover', '--no-fetch'],
];

const CRASH = /\n\s+at\s+\S+.*:\d+|\b(TypeError|ReferenceError|RangeError|SyntaxError|AssertionError)\b|node:internal|\bE(NOENT|ISDIR|LOOP|ACCES|NXIO|PERM|XDEV)\b|\.ts:\d+|Cannot read prop|undefined is not|\[object Object\]|SQLITE_|unhandled/;
type R = { code: number | string | null; out: string[]; err: string[]; timedOut?: boolean };
function viaChild(root: string, argv: string[], stdin = ''): R {
  const r = spawnSync(process.execPath, [BIN, ...argv], { cwd: root, input: stdin, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: path.join(root, '..'), LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env } });
  return { code: r.error ? 'timeout' : r.status, out: (r.stdout ?? '').split('\n').filter(Boolean), err: (r.stderr ?? '').split('\n').filter(Boolean), timedOut: Boolean(r.error) };
}
const KNOWN = new Set([0, 1, 2, 4]);
function verdict(m: string, argv: string[], r: R): string[] {
  const at = `[${m}] plangraph ${argv.join(' ')}`;
  const bad: string[] = [];
  if (!(typeof r.code === 'number' && KNOWN.has(r.code))) bad.push(`${at}: exit ${String(r.code)} ${r.err.slice(0, 2).join(' | ')}`);
  const text = [...r.out, ...r.err].join('\n');
  if (CRASH.test(text)) bad.push(`${at}: crash text: ${text.match(CRASH)?.[0]} in ${text.slice(0, 300)}`);
  if (r.err.length > 30) bad.push(`${at}: ${r.err.length} error lines`);
  if (r.err.some((l) => l.length > 600)) bad.push(`${at}: an error line over 600 characters`);
  return bad;
}

for (const m of MUTS) {
  test(`fuzz: ${m.name}: every command exits cleanly and check names the file`, async () => {
    const w = copy();
    const target = m.apply(w);
    if (target === null && m.name.startsWith('case-colliding')) return; // a case-insensitive file system cannot hold both names
    const bad: string[] = [];
    if (target !== null) { // first, before a repairing command (resolve, fmt, build) changes the damage
      const c = m.spawn ? viaChild(w.root, ['check']) : await run(w.root, ['check'], { env });
      const text = [...c.out, ...c.err].join('\n');
      assert.ok(text.includes(target) || text.includes(path.basename(target)), `check does not name ${target}: ${text.slice(0, 400)}`);
      bad.push(...verdict(m.name, ['check'], c as R));
    }
    for (const argv of CMDS) {
      const stdin = argv[0] === 'hook-prompt' ? JSON.stringify({ session_id: 'z', prompt: 'look at ABC-1' }) : undefined;
      const r = m.spawn ? viaChild(w.root, argv, stdin ?? '') : await run(w.root, argv, { env, ...(stdin !== undefined ? { stdin } : {}) });
      bad.push(...verdict(m.name, argv, r as R));
    }
    assert.deepEqual(bad, []);
    // the damage never reached git as a side effect of a read command: nothing outside the plan and the generated documents changed
    const dirty = git(w.root, 'status', '--porcelain', '--', ':!.plangraph', ':!docs/plangraph', ':!docs/generated', ':!docs/adr', ':!docs/reqs.md', ':!.githooks').trim();
    assert.equal(dirty, '', 'a command changed a tracked file outside the plan');
  });
}

test('the trust list outside the work tree (garbage in its config directory): trust, sync-fetch and every command exit cleanly', async () => {
  const w = copy(), cfg = path.join(w.root, '..', `${path.basename(w.root)}-cfg`); copies.push(cfg);
  fs.mkdirSync(cfg, { recursive: true });
  const e = { ...env, CLAUDE_PLUGIN_DATA: cfg };
  const tr = await run(w.root, ['trust', 'github:example/widgets'], { env: e });
  const f = trustFile(w.root, e);
  assert.ok(fs.existsSync(f) && f.startsWith(cfg), `trust wrote its list in the config directory: ${tr.code} ${[...tr.out, ...tr.err].join('|')}`);
  fs.writeFileSync(f, '\u0000{"a":[1,');
  const bad: string[] = [];
  for (const argv of CMDS) bad.push(...verdict('trust list garbage', argv, (await run(w.root, argv, { env: e })) as R));
  assert.deepEqual(bad, []);
});

test('no plan directory, no repository: every new command exits 0 or 2 with one short message', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(BASE.root), 'fz-'))); copies.push(root);
  const bad: string[] = [];
  for (const argv of CMDS) {
    const r = await run(root, argv, { env, ...(argv[0] === 'hook-prompt' ? { stdin: '{"prompt":"ABC-1"}' } : {}) });
    bad.push(...verdict('empty', argv, r as R));
    if ((r.code as number) > 2 && r.code !== 4) bad.push(`empty ${argv.join(' ')}: ${r.code}`);
  }
  assert.deepEqual(bad, []);
});
