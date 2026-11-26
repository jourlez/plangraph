// SQLite sidecar files (`plangraph.sqlite-journal`, `-wal`, `-shm`) beside the index. A planted HOT rollback journal is replayed by SQLite into
// the database on the first read-write open, and makes every read-only open fail. The attack reproduced here: an attacker copies the real
// index, edits a row, re-stamps the (unkeyed) content digest with the repo's own stampContent (the text fingerprint is unchanged), and writes
// a valid hot journal whose records are every page of that forged copy, at `plangraph.sqlite-journal` (a tracked file if committed). The journal
// is hand-written per the SQLite file format (header magic, record count, nonce, initial page count, sector size, page size; each record a
// page number, the page and the nonce-seeded checksum), which is deterministic, unlike killing a child mid-commit.
// Covered: replay never happens (openIndex refuses any sidecar before SQLite sees the file, read-only and read-write), `plangraph build` removes a
// regular sidecar and so cures the state, refuses a symlinked or non-file sidecar (exit 4, nothing followed), clears sidecars at its temp
// name, never leaves a sidecar itself, and normal index writes leave none; init writes the sidecar ignore lines, doctor warns about sidecars.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildIndex, openIndex, stampContent, IndexHandle, INDEX_FILE } from '../src/db.ts';
import { PlangraphError } from '../src/errors.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-sidecar-')); tmps.push(d); return d; };
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const run = (cwd: string, args: string[], env = {}) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data'), ...env } });
const SIDE = ['-journal', '-wal', '-shm'];
const sidecarsIn = (dir: string) => fs.readdirSync(dir).filter((f) => SIDE.some((s) => f.endsWith(s))).sort();

function repo() {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-1', summary: 'one', sp: 3, v2_owner: 'Ana', v2_sprint: 1 }, { key: 'T-2', summary: 'two', sp: 2, v2_owner: 'Ana', v2_sprint: 1 }]));
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 2 }]));
  adoptPlanDir(b);
  assert.equal(run(d, ['build']).status, 0);
  return { d, b, file: path.join(b, INDEX_FILE) };
}

// A valid hot rollback journal whose records are every page of the database image `src` (so replaying it turns any database into `src`).
function hotJournal(src: string): Buffer {
  const img = fs.readFileSync(src), raw = img.readUInt16BE(16), ps = raw === 1 ? 65536 : raw, n = img.length / ps, sector = 512, nonce = 0x5eed1234;
  const head = Buffer.alloc(sector);
  Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(head, 0);
  head.writeUInt32BE(n, 8); head.writeUInt32BE(nonce, 12); head.writeUInt32BE(n, 16); head.writeUInt32BE(sector, 20); head.writeUInt32BE(ps, 24);
  const recs: Buffer[] = [];
  for (let p = 0; p < n; p++) {
    const page = img.subarray(p * ps, (p + 1) * ps); let ck = nonce;
    for (let i = ps - 200; i > 0; i -= 200) ck = (ck + page[i]) >>> 0;
    const r = Buffer.alloc(4 + ps + 4); r.writeUInt32BE(p + 1, 0); page.copy(r, 4); r.writeUInt32BE(ck, 4 + ps); recs.push(r);
  }
  return Buffer.concat([head, ...recs]);
}
// The attacker's index: the real one with T-1's summary changed and the content digest re-stamped (fingerprint row untouched: still fresh).
function forgedJournal(file: string, dir: string): Buffer {
  const forged = path.join(dir, 'forged.sqlite');
  fs.copyFileSync(file, forged);
  { using h = new IndexHandle(new DatabaseSync(forged)); h.exec('BEGIN'); h.exec("UPDATE ticket SET summary='planted' WHERE key='T-1'"); stampContent(h); h.exec('COMMIT'); }
  const j = hotJournal(forged); fs.rmSync(forged); return j;
}
const SIDECAR_REFUSAL = (name: string) => (e: unknown) => e instanceof PlangraphError && e.code === 'DATA'
  && e.message === `the index has a SQLite journal file beside it (${name}); it is never replayed` && e.hint === 'run `plangraph build` to rebuild it';

test('a planted hot journal is never replayed: every open refuses it (read-only and read-write), and `plangraph build` removes it and cures the state', () => {
  const { d, b, file } = repo();
  const outside = tmp(), journal = `${file}-journal`;
  fs.writeFileSync(journal, forgedJournal(file, outside));
  const indexBytes = fs.readFileSync(file);
  for (const opts of [{ readOnly: false }, { dir: b }, {}]) {
    let replayed = null;
    try { using h = openIndex(file, opts); replayed = (h.get("SELECT summary FROM ticket WHERE key='T-1'") as { summary: unknown }).summary; } // T-1 is in the fixture
    catch (e) { assert.ok(SIDECAR_REFUSAL(`${INDEX_FILE}-journal`)(e), `${JSON.stringify(opts)}: ${(e as Error).message}`); } // openIndex throws a PlangraphError
    assert.equal(replayed, null, `the planted journal was replayed (${JSON.stringify(opts)}): T-1 reads "${replayed}"`);
    assert.ok(fs.existsSync(journal), 'the journal is left for `plangraph build`'); assert.deepEqual(fs.readFileSync(file), indexBytes, 'the index was not touched');
  }
  const r = run(d, ['ticket', 'T-1']);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `error: the index has a SQLite journal file beside it (${INDEX_FILE}-journal); it is never replayed\ntry: plangraph build\n`]);
  const hook = run(d, ['card', '--if-present']);
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', '']);
  // the read-write CLI writers refuse it too (they would replay it)
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify([{ item: 'T-1', owner: 'Ana', sprint: 1 }, { item: 'T-2', owner: 'Ana', sprint: 3 }]));
  assert.equal(run(d, ['schedule-load', 's.json', 'old']).status, 2);
  assert.ok(fs.existsSync(journal)); assert.deepEqual(fs.readFileSync(file), indexBytes);
  // `plangraph build` removes the regular sidecar (it belongs to a prior or foreign index), and the planted row never appears afterwards
  const bl = run(d, ['build']); assert.equal(bl.status, 0, bl.stderr);
  assert.deepEqual(sidecarsIn(b), []);
  const t = run(d, ['ticket', 'T-1']); assert.equal(t.status, 0, t.stderr);
  assert.ok(t.stdout.includes('one') && !t.stdout.includes('planted'), t.stdout);
  { using h = openIndex(file, { readOnly: false }); assert.equal((h.get("SELECT summary FROM ticket WHERE key='T-1'") as { summary: unknown }).summary, 'one'); } // T-1 is in the fixture
  assert.deepEqual(sidecarsIn(b), []);
});

test('a -wal or -shm file beside the index is refused on open too (DATA, plangraph build hint), and build removes it', () => {
  for (const s of ['-wal', '-shm']) {
    const { d, b, file } = repo();
    fs.writeFileSync(`${file}${s}`, 'x');
    assert.throws(() => openIndex(file, { dir: b }), SIDECAR_REFUSAL(`${INDEX_FILE}${s}`));
    assert.throws(() => openIndex(file, { readOnly: false }), SIDECAR_REFUSAL(`${INDEX_FILE}${s}`));
    assert.equal(run(d, ['build']).status, 0);
    assert.deepEqual(sidecarsIn(b), []);
    { using h = openIndex(file, { dir: b }); assert.equal(h.stale, false); }
  }
});

test('build refuses (exit 4) a symlinked or non-file sidecar, follows nothing, removes nothing, and keeps the old index', { skip: process.platform === 'win32' ? 'symlinks' : false }, () => {
  for (const [s, kind] of [['-journal', 'symlink'], ['-wal', 'symlink'], ['-shm', 'dir']]) {
    const { d, b, file } = repo();
    const victim = path.join(tmp(), 'victim'); fs.writeFileSync(victim, 'outside');
    const p = `${file}${s}`;
    if (kind === 'symlink') fs.symlinkSync(victim, p); else fs.mkdirSync(p);
    const before = fs.readFileSync(file);
    fs.appendFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-3', summary: 'three', sp: 1, v2_owner: 'Ana', v2_sprint: 1 }]));
    adoptPlanDir(b);
    const r = run(d, ['build']);
    assert.equal(r.status, 4, r.stderr);
    assert.equal(r.stderr, `error: refusing to build the index: ${INDEX_FILE}${s} is ${kind === 'symlink' ? 'a symlink' : 'not a regular file'}; remove it by hand, then run \`plangraph build\`\ntry: plangraph explain build\n`);
    assert.deepEqual(fs.readFileSync(file), before, 'the old index is kept');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'outside');
    assert.equal(kind === 'symlink' ? fs.lstatSync(p).isSymbolicLink() : fs.lstatSync(p).isDirectory(), true, 'the sidecar is left alone');
    assert.deepEqual(fs.readdirSync(b).filter((f) => f.includes('.tmp-')), [], 'no temp file left');
  }
});

test('build clears regular sidecars at its own temp name, refuses a symlinked one, and SQLite leaves no sidecar of the temp or the index', { skip: process.platform === 'win32' ? 'symlinks' : false }, () => {
  const { b, file } = repo();
  const tmpName = `${file}.tmp-${process.pid}`;
  for (const s of SIDE) fs.writeFileSync(`${tmpName}${s}`, 'leftover');
  buildIndex({ dir: b });
  assert.deepEqual(sidecarsIn(b), []);
  assert.deepEqual(fs.readdirSync(b).filter((f) => f.includes('.tmp-')), []);
  { using h = openIndex(file, { dir: b }); assert.equal(h.stale, false); assert.equal((h.get('PRAGMA journal_mode') as { journal_mode: unknown }).journal_mode, 'delete', 'never WAL'); } // the pragma returns one row
  const victim = path.join(tmp(), 'victim'); fs.writeFileSync(victim, 'outside');
  fs.symlinkSync(victim, `${tmpName}-wal`);
  assert.throws(() => buildIndex({ dir: b }), (e) => e instanceof PlangraphError && e.code === 'REFUSED'
    && e.message === `refusing to build the index: ${path.basename(tmpName)}-wal is a symlink; remove it by hand, then run \`plangraph build\``);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'outside');
  assert.ok(!fs.existsSync(tmpName), 'the temp file this build created is removed');
  fs.rmSync(`${tmpName}-wal`);
});

test('normal index writes leave no sidecar: build, read-only opens, whatif --write, schedule-load, export', () => {
  const { d, b, file } = repo();
  assert.deepEqual(sidecarsIn(b), []);
  assert.equal(run(d, ['ticket', 'T-1']).status, 0); assert.deepEqual(sidecarsIn(b), []);
  const w = run(d, ['whatif', 'T-2', '--sprint', '3', '--write', '--apply-plan']); assert.equal(w.status, 0, w.stdout + w.stderr); assert.deepEqual(sidecarsIn(b), []);
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify([{ item: 'T-1', owner: 'Ana', sprint: 1 }, { item: 'T-2', owner: 'Ana', sprint: 3 }]));
  assert.equal(run(d, ['schedule-load', 's.json', 'old']).status, 0); assert.deepEqual(sidecarsIn(b), []);
  assert.equal(run(d, ['export']).status, 0); assert.deepEqual(sidecarsIn(b), []);
  { using h = openIndex(file, { dir: b }); assert.equal(h.stale, false); }
});

const IGNORE = ['*.sqlite', '*.sqlite-journal', '*.sqlite-wal', '*.sqlite-shm'];
test('init writes the sidecar ignore lines; on an existing .gitignore it appends only the missing ones and keeps every user line', () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  const gi = path.join(d, '.plangraph', '.gitignore');
  assert.equal(fs.readFileSync(gi, 'utf8'), `${IGNORE.join('\n')}\n`);
  fs.writeFileSync(gi, '# mine\r\n*.sqlite\r\n*.sqlite-wal\r\nCARD.md');
  const r = run(d, ['init']); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], 'already initialised: .plangraph (added *.sqlite-journal, *.sqlite-shm to .gitignore)');
  assert.equal(fs.readFileSync(gi, 'utf8'), '# mine\r\n*.sqlite\r\n*.sqlite-wal\r\nCARD.md\r\n*.sqlite-journal\r\n*.sqlite-shm\r\n');
  assert.equal(run(d, ['init']).stdout.split('\n')[0], 'already initialised: .plangraph (no changes)');
  // a sidecar is really ignored by git now
  fs.writeFileSync(path.join(d, '.plangraph', `${INDEX_FILE}-journal`), 'x');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.plangraph'], { cwd: d, encoding: 'utf8' }).includes('journal'), false);
});

test('doctor warns about a sidecar beside the index, a git-tracked sidecar, and a .gitignore without the sidecar lines', () => {
  const { d, b, file } = repo(), home = tmp();
  const r0 = run(d, ['doctor'], { HOME: home });
  assert.equal(r0.status, 0, r0.stdout); assert.doesNotMatch(r0.stdout, /sidecar|journal/);
  fs.writeFileSync(`${file}-journal`, 'x');
  let r = run(d, ['doctor'], { HOME: home });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^warning: \.plangraph\/plangraph\.sqlite-journal: a SQLite journal file beside the index; every index command refuses it until `plangraph build` removes it$/m);
  execFileSync('git', ['add', '-f', '.plangraph/plangraph.sqlite-journal'], { cwd: d });
  r = run(d, ['doctor'], { HOME: home });
  assert.match(r.stdout, /^warning: tracked journal: \.plangraph\/plangraph\.sqlite-journal is committed; untrack it with `git rm --cached \.plangraph\/plangraph\.sqlite-journal`$/m);
  fs.writeFileSync(path.join(b, '.gitignore'), '*.sqlite\n');
  r = run(d, ['doctor'], { HOME: home });
  assert.match(r.stdout, /^warning: \.plangraph\/\.gitignore does not ignore the SQLite journal files \(\*\.sqlite-journal, \*\.sqlite-wal, \*\.sqlite-shm\): run `plangraph init` to add the missing lines$/m);
});
