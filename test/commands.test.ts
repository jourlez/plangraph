// Task 11: commands in src/commands/ behind the registry. Covers the behavior decided while moving them (the old output itself is frozen
// by test/golden.test.ts): the single staleness policy of ctx.db(), typed errors for a corrupt index and a missing plan dir, the
// crash-leftover cleanup that never touches a live build's temp file, export leaving the index current, forecast freshness including
// open-items.jsonl, the absolute-dir refusal and the exit codes. Real runs of bin/plangraph in mkdtemp repos (removed in `after`).
// NOT covered: an old Node binary (the entry-point guard is checked by test/floor.test.ts through nodeSupported), jira-pull success.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { genPlan } from './fixtures/gen.ts';
import { PlangraphError } from '../src/errors.ts';
import { buildIndex, openIndex, removeStaleTemps, INDEX_FILE, TEMP_MAX_AGE_MS } from '../src/db.ts';
import { makeContext, STALE_WARNING } from '../src/context.ts';
import type { Ctx } from '../src/context.ts';
import type { Command } from '../src/registry.ts';

const BRAIN = path.join(import.meta.dirname, '../bin/plangraph');
const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-cmd-'))); tmps.push(d); return d; };
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const ENV = { ...process.env, PLANGRAPH_DIR: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (cwd: string, args: string[], env = {}) => spawnSync(process.execPath, [BRAIN, ...args], { cwd, encoding: 'utf8', env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(cwd, '.data'), ...env } });
const silentIo = () => { const o = { out: [] as string[], err: [] as string[] }; return { o, io: { out: (s: string) => o.out.push(s), err: (s: string) => o.err.push(s), raw: (s: string) => o.out.push(s) } }; }; // an empty list of this element type

/** A git repo with an initialised and built plangraph over a small generated plan. */
function repo() {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  const p = genPlan({ n: 12, people: 2, seed: 3 }), b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(p.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(p.edges));
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(p.schedule));
  adoptPlanDir(b);
  const r = run(d, ['build']); assert.equal(r.status, 0, r.stderr);
  return d;
}

// ---------- staleness policy: ctx.db() warns once on stderr unless --if-present; the answer is still given ----------
test('a stale index (text changed after build) answers with one STALE warning on stderr; --if-present keeps it silent; build clears it', () => {
  const d = repo();
  let r = run(d, ['ticket', 'T-1']);
  assert.equal(r.status, 0); assert.equal(r.stderr, '');
  fs.appendFileSync(path.join(d, '.plangraph/findings.jsonl'), JSON.stringify({ key: 'T-1', kind: 'note', text: 'later' }) + '\n');
  adoptPlanDir(path.join(d, '.plangraph'));
  for (const args of [['ticket', 'T-1'], ['check'], ['blockers'], ['sprint', '1'], ['findings']]) {
    r = run(d, args);
    assert.equal(r.stderr, `${STALE_WARNING}\n`, args.join(' '));
    assert.ok(r.stdout.length > 0 || args[0] === 'findings', args.join(' '));
  }
  assert.match(STALE_WARNING, /^STALE: .*run `plangraph build`$/);
  r = run(d, ['card', '--if-present']); assert.equal(r.status, 0); assert.equal(r.stderr, '');
  r = run(d, ['ticket', 'T-1', '--if-present']); assert.equal(r.stderr, '');
  assert.equal(run(d, ['build']).status, 0);
  r = run(d, ['ticket', 'T-1']); assert.equal(r.stderr, '');
});

test('ctx.db() applies the policy itself: one warning per handle, none with if-present', () => {
  const d = repo();
  fs.appendFileSync(path.join(d, '.plangraph/meta.jsonl'), JSON.stringify({ k: 'x', v: 'y' }) + '\n');
  const a = silentIo();
  { using ctx = makeContext({ root: d, env: {}, flags: {}, io: a.io }); ctx.db(); ctx.db(); }
  assert.deepEqual(a.o.err, [STALE_WARNING]);
  const b = silentIo();
  { using ctx = makeContext({ root: d, env: {}, flags: { 'if-present': true }, io: b.io }); assert.equal(ctx.db().stale, true); }
  assert.deepEqual(b.o.err, []);
});

// ---------- typed errors from src/db.ts ----------
test('a corrupt or non-SQLite index is a DATA error (exit 2) with the build hint, never a raw sqlite error', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, '.plangraph', INDEX_FILE), 'this is not a database, just text that is long enough to have a header\n'.repeat(20));
  assert.throws(() => openIndex(path.join(d, '.plangraph', INDEX_FILE), { dir: path.join(d, '.plangraph') }),
    (e) => e instanceof PlangraphError && e.code === 'DATA' && e.exitCode === 2 && e.message === 'the index is not a readable SQLite database' && e.hint === 'run `plangraph build` to rebuild it');
  const r = run(d, ['ticket', 'T-1']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'error: the index is not a readable SQLite database\ntry: plangraph build\n');
});

test('buildIndex on a missing plan dir is a DATA error with the `plangraph init` hint', () => {
  const d = tmp();
  assert.throws(() => buildIndex({ dir: path.join(d, '.plangraph') }), (e) => e instanceof PlangraphError && e.code === 'DATA' && e.message === 'no plan directory' && e.hint === 'run `plangraph init` first');
});

// ---------- crash-leftover cleanup: only stale temp files ----------
test('removeStaleTemps removes old or dead-pid temp files and keeps a fresh temp file of a live process', async () => {
  const d = tmp(), prefix = `${INDEX_FILE}.tmp-`;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const live = path.join(d, prefix + child.pid), liveOld = path.join(d, `${prefix}${child.pid}x`), dead = path.join(d, `${prefix}999999`);
    const mine = path.join(d, prefix + process.pid), odd = path.join(d, `${prefix}abc`), other = path.join(d, 'plangraph.sqlite.bak');
    for (const f of [live, liveOld, dead, mine, odd, other]) fs.writeFileSync(f, 'x');
    const old = new Date(Date.now() - TEMP_MAX_AGE_MS - 60000);
    fs.utimesSync(liveOld, old, old);
    removeStaleTemps(d, prefix);
    const left = fs.readdirSync(d).toSorted();
    assert.deepEqual(left, [path.basename(other), path.basename(odd), path.basename(live)].toSorted());
    // the same live file, once older than the limit, is a leftover
    fs.utimesSync(live, old, old); fs.utimesSync(odd, old, old);
    removeStaleTemps(d, prefix);
    assert.deepEqual(fs.readdirSync(d), [path.basename(other)]);
  } finally { child.kill(); }
});

test('buildIndex keeps a concurrent live build\'s fresh temp file', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const theirs = path.join(b, `${INDEX_FILE}.tmp-${child.pid}`);
    fs.writeFileSync(theirs, 'in progress');
    buildIndex({ dir: b });
    assert.equal(fs.readFileSync(theirs, 'utf8'), 'in progress');
  } finally { child.kill(); }
});

test('`plangraph build` without a plan dir exits 2 with the `plangraph init` hint (not a raw ENOENT)', () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d });
  const r = run(d, ['build']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'error: no plan directory\ntry: plangraph init\n');
});

// ---------- export leaves the index current ----------
test('after `plangraph export` rewrites the text (canonical order), the next query is not stale', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  // non-canonical text: reversed lines, so export changes the bytes
  for (const f of ['tickets.jsonl', 'edges.jsonl']) fs.writeFileSync(path.join(b, f), fs.readFileSync(path.join(b, f), 'utf8').trim().split('\n').reverse().join('\n') + '\n');
  adoptPlanDir(b);
  assert.equal(run(d, ['build']).status, 0);
  const before = fs.readFileSync(path.join(b, 'tickets.jsonl'), 'utf8');
  let r = run(d, ['export']); assert.equal(r.status, 0, r.stderr);
  assert.notEqual(fs.readFileSync(path.join(b, 'tickets.jsonl'), 'utf8'), before, 'export rewrote the text');
  r = run(d, ['ticket', 'T-1']); assert.equal(r.status, 0); assert.equal(r.stderr, '');
  // schedule-load changes the index only; export saves it and the index stays current
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify(genPlan({ n: 12, people: 2, seed: 3 }).schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint }))));
  r = run(d, ['schedule-load', 's.json', 'old']); assert.equal(r.status, 0, r.stderr);
  r = run(d, ['export']); assert.equal(r.status, 0, r.stderr);
  r = run(d, ['check']); assert.equal(r.stderr, '');
  assert.match(fs.readFileSync(path.join(b, 'schedule.jsonl'), 'utf8'), /"version":"old"/);
});

test('export refuses a symlinked target before writing anything (exit 4); every file keeps its bytes', () => {
  const d = repo(), b = path.join(d, '.plangraph'), victim = path.join(tmp(), 'victim.txt');
  fs.writeFileSync(victim, 'keep me\n');
  fs.rmSync(path.join(b, 'findings.jsonl')); fs.symlinkSync(victim, path.join(b, 'findings.jsonl'));
  const snap = () => Object.fromEntries(fs.readdirSync(b).filter((f) => f.endsWith('.jsonl') && f !== 'findings.jsonl').map((f) => [f, fs.readFileSync(path.join(b, f), 'utf8')]));
  const before = snap();
  const r = run(d, ['export']);
  assert.equal(r.status, 4);
  assert.equal(r.stderr, 'error: refusing to write findings.jsonl: it is a symlink (nothing was written)\ntry: plangraph explain export\n');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me\n');
  assert.deepEqual(snap(), before);
});

// ---------- audit, Jira and open-items argument errors are typed (exit 2), never a crash ----------
test('audit and open-items argument errors: fixed messages, exit 2, nothing written', () => {
  const d = repo(); execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'b'], { cwd: d });
  const cases: Array<[string[], string | null]> = [
    [['stale', '--ref=--output=x'], 'error: invalid git ref: "--output=x"\ntry: plangraph explain stale\n'],
    [['stale', '--ref', 'no-such-branch'], null],
    [['units', '--keys', 'T-1', '--size', '0', '--out', 'u'], 'error: --size: must be between 1 and 1000\ntry: plangraph explain units\n'],
    [['open-items', '--close', 'T-1', 'x', '--reopen'], 'error: give only one of --close, --reopen and --register\ntry: plangraph explain open-items\n'],
    [['open-items', '--close', 'T-1'], 'error: --close needs KEY KIND\ntry: plangraph explain open-items\n'],
    [['open-items', '--close', 'T-1', 'nope'], 'error: closeItem: no open item T-1|nope\ntry: plangraph explain open-items\n'],
    [['jira-text', 'ABC-1', '--out', 'jt', '--from-json', 'missing.json'], 'error: cannot read issue file missing.json\nhint: check the path\ntry: plangraph explain jira-text\n'],
  ];
  for (const [args, want] of cases) {
    const r = run(d, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    if (want) assert.equal(r.stderr, want, args.join(' ')); else assert.match(r.stderr, /^error: git: .*\nhint: check --ref.*\ntry: plangraph explain stale\n$/);
  }
  assert.equal(fs.existsSync(path.join(d, 'u')), false);
  assert.equal(fs.existsSync(path.join(d, '.plangraph/open-items.jsonl')), false);
});

// ---------- forecast freshness: open-items.jsonl counts, as in bin/plangraph's forecast ----------
test('forecast warns STALE when open-items.jsonl is newer than the index (open-items is not in the fingerprint); one warning only', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  let r = run(d, ['forecast']); assert.equal(r.status, 0); assert.equal(r.stderr, '');
  fs.writeFileSync(path.join(b, 'open-items.jsonl'), '');
  adoptPlanDir(b);
  const later = new Date(fs.statSync(path.join(b, INDEX_FILE)).mtimeMs + 5000);
  fs.utimesSync(path.join(b, 'open-items.jsonl'), later, later);
  r = run(d, ['forecast']); assert.equal(r.status, 0); assert.equal(r.stderr, `${STALE_WARNING}\n`);
  r = run(d, ['forecast', '--if-present']); assert.equal(r.stderr, '');
  r = run(d, ['ticket', 'T-1']); assert.equal(r.stderr, '', 'other queries follow the fingerprint only');
  fs.appendFileSync(path.join(b, 'meta.jsonl'), JSON.stringify({ k: 'a', v: 'b' }) + '\n'); // fingerprint stale as well: still one line
  r = run(d, ['forecast']); assert.equal(r.stderr, `${STALE_WARNING}\n`);
});

test('simulate bounds its run count and noise: out-of-range values are usage errors', () => {
  const d = repo();
  for (const a of [['--runs', '0'], ['--runs', '1e9'], ['--sigma', 'NaN'], ['--sigma=-1'], ['--runs', '2.5']]) {
    const r = run(d, ['simulate', ...a]); assert.equal(r.status, 2, a.join(' ')); assert.match(r.stderr, /^error: --(runs|sigma): /);
  }
  assert.equal(run(d, ['simulate', '--runs', '5', '--sigma', '0']).status, 0);
});

test('ready refuses an open-items.jsonl owner that is not a string (it printed "owner [object Object]") as a data error, exit 2', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'open-items.jsonl'), jl([{ key: 'T-1', kind: 'decision', owner: { x: 1 }, status: 'open', text: 'a' }]));
  const r = run(d, ['ready', 'T-1']);
  assert.equal(r.status, 2, r.stdout); assert.doesNotMatch(r.stdout, /object Object/);
  assert.match(r.stderr, /open-items\.jsonl:1: "owner" must be a string/);
});

test('simulate skips a schedule row whose ticket does not exist, with one warning line, instead of letting it move the plan end', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  const t = (key: string) => ({ key, summary: key, epic: 'E0', sp: 30, jira_status: 'To Do' });
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([t('T-1'), t('T-2')])); fs.writeFileSync(path.join(b, 'edges.jsonl'), '');
  const rows = [{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 1 }];
  // two 30-point tickets in one 40-point slot: the exact-size baseline must push one to sprint 2
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(rows)); assert.equal(run(d, ['build']).status, 0);
  const without = run(d, ['simulate', '--runs', '50', '--sigma', '0']);
  assert.equal(without.stderr, ''); assert.match(without.stdout, /^baseline with exact sizes: ends sprint 2 /);
  // a ghost row gave an undefined size (a NaN slot load that `|| 0` hid), yet its sprint still set the planned and simulated end
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([...rows, { version: 'current', key: 'GHOST-1', owner: 'Ana', sprint: 5 }])); assert.equal(run(d, ['build']).status, 0);
  const r = run(d, ['simulate', '--runs', '50', '--sigma', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, without.stdout);
  assert.equal(r.stderr, 'warning: simulate skips 1 schedule row(s) with no ticket: GHOST-1 (run `plangraph check`)\n');
});

// ---------- plan dir confinement and exit codes of the entry point ----------
test('an absolute or escaping plan dir (PLANGRAPH_DIR, --dir, .plangraphrc) is refused with exit 4 and writes nothing', () => {
  const d = repo(), outside = tmp();
  const want = (cmd: string) => `error: plan directory is outside the repository\nhint: use a relative --dir inside the repository\ntry: plangraph explain ${cmd}\n`;
  for (const [args, env] of ([[['ticket', 'T-1'], { PLANGRAPH_DIR: path.join(d, '.plangraph') }], [['init'], { PLANGRAPH_DIR: outside }], [['build', '--dir', '../x'], {}], [['init', '--dir', outside], {}]] as Array<[string[], Record<string, string>]>)) { // a literal list of these tuples
    const r = run(d, args, env);
    assert.equal(r.status, 4, `${args.join(' ')} ${JSON.stringify(env)}`); assert.equal(r.stderr, want(args[0])); assert.equal(r.stdout, '');
  }
  fs.writeFileSync(path.join(d, '.plangraphrc'), JSON.stringify({ dir: '../../elsewhere' }));
  const r = run(d, ['init']); assert.equal(r.status, 4); assert.equal(r.stderr, want('init'));
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.writeFileSync(path.join(d, '.plangraphrc'), JSON.stringify({ dir: '.plangraph' }));
  assert.equal(run(d, ['ticket', 'T-1']).status, 0, 'a relative dir inside the repository still works');
});

test('unknown command and no command exit 2 pointing at plangraph explain (no command list); prototype names are not commands', () => {
  const d = tmp();
  for (const args of [['frobnicate'], [], ['constructor'], ['__proto__']]) {
    const r = run(d, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^error: (unknown command \S+|no command)\ntry: plangraph explain\n$/);
  }
});

test('the repository root is found without git (nearest .git, real path), matching `git rev-parse --show-toplevel`, worktrees included', () => {
  const d = repo();
  const top = (cwd: string) => execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(d, 'a/b'), { recursive: true });
  const calls: string[][] = [];
  const spy = (cwd: string) => (...a: string[]) => { calls.push(a); return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }); };
  const ctxAt = (cwd: string, env = {}) => makeContext({ cwd, env, flags: {}, io: silentIo().io, git: spy });
  assert.equal(ctxAt(path.join(d, 'a/b')).root, top(path.join(d, 'a/b')));
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'b', '--allow-empty'], { cwd: d });
  const wt = path.join(tmp(), 'wt'); execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: d });
  assert.equal(ctxAt(wt).root, top(wt));
  assert.deepEqual(calls, [], 'no git process for the root');
  const plain = tmp(); assert.equal(ctxAt(plain).root, plain);
  assert.equal(ctxAt(path.join(d, 'a'), { GIT_DIR: path.join(d, '.git'), GIT_WORK_TREE: d }).root, top(d));
  assert.deepEqual(calls, [['rev-parse', '--show-toplevel']], 'with GIT_DIR / GIT_WORK_TREE set, git is asked');
});

// ---------- review fixes (Task 11 review round) ----------
import { main } from '../src/cli.ts';
import { adoptPlanDir } from './helpers/plan-dir.ts';

// The SessionStart hook runs `card --if-present [--heal]`: it must never print and never exit non-zero, whatever fails.
test('card --if-present [--heal] is silent with exit 0 on every failure: bad .plangraphrc, refused dir, corrupt index, bad option', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  const quiet = (args: string[], env: Record<string, string>, why: string) => {
    for (const extra of [[], ['--heal']]) {
      const r = run(d, [...args, ...extra], env);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${why} ${extra.join(' ')}`);
    }
  };
  fs.writeFileSync(path.join(d, '.plangraphrc'), '{not json');
  quiet(['card', '--if-present'], {}, 'bad .plangraphrc');
  assert.equal(run(d, ['card']).status, 2, 'without --if-present the error is still reported');
  fs.writeFileSync(path.join(d, '.plangraphrc'), JSON.stringify({ dir: 7 }));
  quiet(['card', '--if-present'], {}, '.plangraphrc dir not a string');
  fs.rmSync(path.join(d, '.plangraphrc'));
  quiet(['card', '--if-present'], { PLANGRAPH_DIR: tmp() }, 'absolute PLANGRAPH_DIR');
  quiet(['card', '--if-present'], { PLANGRAPH_DIR: '../x' }, 'escaping PLANGRAPH_DIR');
  quiet(['card', '--if-present', '--dir', '../x'], {}, 'escaping --dir');
  quiet(['card', '--if-present', '--bogus'], {}, 'unknown option');
  // success: the card is printed, nothing on stderr
  let r = run(d, ['card', '--if-present']);
  assert.equal(r.status, 0); assert.equal(r.stderr, ''); assert.match(r.stdout, /\S/);
  fs.writeFileSync(path.join(b, INDEX_FILE), 'this is not a database, just text that is long enough to have a header\n'.repeat(20));
  quiet(['card', '--if-present'], {}, 'corrupt index');
  r = run(d, ['card']); assert.equal(r.status, 2); assert.match(r.stderr, /^error: the index is not a readable SQLite database/);
  fs.rmSync(path.join(b, INDEX_FILE));
  // no index: plan data is there, so the hook prints ONE first-use line (test/first-use.test.ts covers it and every silent shape)
  for (const extra of [[], ['--heal']]) {
    r = run(d, ['card', '--if-present', ...extra]);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'plangraph: plan data found in .plangraph but no index: run plangraph build\n', ''], `no index ${extra.join(' ')}`);
  }
});

test('main(): card --if-present swallows any thrown error (command or context) and prints nothing; other commands still report', async () => {
  const boom = { card: Object.freeze({ name: 'card', run: () => { throw new TypeError('boom'); }, options: {}, positionals: [0, 0] }) };
  const reg = new Map(Object.entries(boom)) as unknown as Map<string, Command>; // a partial registry: main reads run, options and positionals
  const io = silentIo();
  assert.equal(await main(['card', '--if-present'], { registry: reg, makeContext: () => ({ dir: '' }) as Ctx, io: io.io }), 0); // a partial context
  assert.equal(await main(['card', '--if-present', '--heal'], { registry: reg, makeContext: () => { throw new Error('ctx'); }, io: io.io }), 0);
  const outing = new Map([['card', Object.freeze({ name: 'card', run: (ctx: Ctx) => { ctx.io.out('partial'); throw new Error('late'); }, options: {}, positionals: [0, 0] })]]) as unknown as Map<string, Command>; // a partial registry
  assert.equal(await main(['card', '--if-present'], { registry: outing, makeContext: ({ io }) => ({ dir: '', io }) as Ctx, io: io.io }), 0); // a partial context
  const failing = new Map([['card', Object.freeze({ name: 'card', run: (ctx: Ctx) => { ctx.io.out('partial'); return 3; }, options: {}, positionals: [0, 0] })]]) as unknown as Map<string, Command>; // a partial registry
  assert.equal(await main(['card', '--if-present'], { registry: failing, makeContext: ({ io }) => ({ dir: '', io }) as Ctx, io: io.io }), 0, 'a non-zero result is 0'); // a partial context
  assert.deepEqual(io.o, { out: [], err: [] });
  assert.equal(await main(['card'], { registry: reg, makeContext: () => ({ dir: '' }) as Ctx, io: io.io }), 5); // a partial context
  assert.deepEqual(io.o.err, ['error: internal error: boom', 'try: plangraph doctor']);
});

// Refused writes (symlink target, outside the repository) exit 4 (REFUSED) with nothing written.
test('refused write targets exit 4 with nothing written: card --write, sp-link, sp-ingest, init format.json (learn: openwolf-readthrough)', () => {
  const d = repo(), b = path.join(d, '.plangraph'), out = tmp();
  const victim = path.join(out, 'victim.txt'); fs.writeFileSync(victim, 'keep me\n');
  const empty = path.join(out, 'empty.jsonl'); fs.writeFileSync(empty, ''); // a readable JSONL target: the command gets as far as writing
  const snap = (dir: string) => Object.fromEntries(fs.readdirSync(dir).filter((f) => !f.endsWith('.sqlite')).map((f) => [f, fs.lstatSync(path.join(dir, f)).isSymbolicLink() ? 'link' : fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : 'dir']));
  const refused = (args: string[], file: string, why: string) => {
    const before = snap(b);
    const r = run(d, args);
    assert.equal(r.status, 4, `${why}: ${r.stderr}`);
    assert.equal(r.stderr, `error: refusing to write ${file}: it is a symlink (nothing was written)\ntry: plangraph explain ${args[0]}\n`, why);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me\n', why); assert.equal(fs.readFileSync(empty, 'utf8'), '', why); assert.deepEqual(snap(b), before, why);
  };
  fs.symlinkSync(victim, path.join(b, 'CARD.md'));
  refused(['card', '--write'], 'CARD.md', 'card --write');
  fs.rmSync(path.join(b, 'CARD.md'));
  fs.mkdirSync(path.join(d, 'docs')); fs.writeFileSync(path.join(d, 'docs/p.md'), '# Plan\n\n### Task 1: first\nbuild a\n\n### Task 2: second\nbuild b using a\n');
  fs.rmSync(path.join(b, 'refs.jsonl'), { force: true }); fs.symlinkSync(empty, path.join(b, 'refs.jsonl'));
  refused(['sp-link', 'T-1', 'docs/p.md'], 'refs.jsonl', 'sp-link');
  fs.rmSync(path.join(b, 'refs.jsonl'));
  fs.rmSync(path.join(b, 'tickets.jsonl')); fs.symlinkSync(empty, path.join(b, 'tickets.jsonl'));
  refused(['sp-ingest', 'docs/p.md', '--ledger', 'none'], 'tickets.jsonl', 'sp-ingest');
  // init: a symlinked format.json (dangling or not) is refused before anything is written
  const e = tmp(); execFileSync('git', ['init', '-q'], { cwd: e }); fs.mkdirSync(path.join(e, '.plangraph'));
  for (const target of [victim, path.join(out, 'nowhere.json')]) {
    fs.rmSync(path.join(e, '.plangraph/format.json'), { force: true }); fs.symlinkSync(target, path.join(e, '.plangraph/format.json'));
    const r = run(e, ['init']);
    assert.equal(r.status, 4, r.stderr); assert.equal(r.stderr, 'error: refusing to write format.json: it is a symlink (nothing was written)\ntry: plangraph explain init\n');
    assert.deepEqual(fs.readdirSync(path.join(e, '.plangraph')), ['format.json']); assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me\n');
    assert.equal(fs.existsSync(path.join(out, 'nowhere.json')), false);
  }
});

test('open-items is strict on the data format whenever it writes (--write, --close, --reopen, --register)', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'format.json'), '{"format_version":99,"min_reader":99}\n'); // a newer directory: refused
  for (const args of [['open-items', '--write'], ['open-items', '--register', 'T-1', 'x', '--owner', 'A', '--due', '2', '--text', 't'], ['open-items', '--close', 'T-1', 'x'], ['open-items', '--reopen', 'T-1', 'x']]) {
    const r = run(d, args);
    assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, /^error: .*data format 99 .*newer.*\nhint: upgrade the plangraph plugin, then retry\n/, args.join(' '));
    assert.equal(fs.existsSync(path.join(b, 'open-items.jsonl')), false, args.join(' '));
  }
});

test('neighbors depth is a whole number from 0 to 50; schedule-load refuses "current", long names and a bad row shape', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  for (const depth of ['51', '1.5', '999', 'x', '１']) {
    const r = run(d, ['neighbors', 'T-1', depth]);
    assert.equal(r.status, 2, depth); assert.equal(r.stderr, 'error: depth must be a whole number from 0 to 50\ntry: plangraph explain neighbors\n', depth);
  }
  assert.equal(run(d, ['neighbors', 'T-1', '0']).status, 0); assert.equal(run(d, ['neighbors', 'T-1', '50']).status, 0);
  const rows = genPlan({ n: 12, people: 2, seed: 3 }).schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint }));
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify(rows));
  const before = fs.readFileSync(path.join(b, INDEX_FILE));
  for (const name of ['current', 'x'.repeat(201)]) {
    const r = run(d, ['schedule-load', 's.json', name]);
    assert.equal(r.status, 2, name.slice(0, 10)); assert.equal(r.stderr, 'error: archive name must be non-empty, at most 200 characters and not "current"\ntry: plangraph explain schedule-load\n');
  }
  for (const bad of [[{ item: 'T-1', owner: 'A' }], [{ item: 'T-1', owner: 'A', sprint: 1.5 }], [{ item: 1, owner: 'A', sprint: 1 }], { item: 'T-1' }, [null]]) {
    fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify(bad));
    const r = run(d, ['schedule-load', 'bad.json', 'old']);
    assert.equal(r.status, 2, JSON.stringify(bad)); assert.equal(r.stderr, 'error: schedule file must be a JSON array of {item, owner, sprint} (strings and a whole sprint number)\ntry: plangraph explain schedule-load\n');
  }
  assert.deepEqual(fs.readFileSync(path.join(b, INDEX_FILE)), before, 'the index was not changed');
});

test('export refuses a stale index (text edited after the build) with a data error and the build hint; the text keeps its bytes', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  fs.appendFileSync(path.join(b, 'findings.jsonl'), JSON.stringify({ key: 'T-1', kind: 'note', text: 'hand edit' }) + '\n');
  const snap = () => Object.fromEntries(fs.readdirSync(b).filter((f) => f.endsWith('.jsonl')).map((f) => [f, fs.readFileSync(path.join(b, f), 'utf8')]));
  const before = snap();
  let r = run(d, ['export']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'error: the index is stale: the text files changed since it was built, and export would overwrite them\ntry: plangraph build\n');
  assert.deepEqual(snap(), before);
  assert.equal(run(d, ['build']).status, 0);
  r = run(d, ['export']); assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(b, 'findings.jsonl'), 'utf8'), /hand edit/);
});

test('schedule-load then export still works (the index changed, the text did not: not stale)', () => {
  const d = repo(), b = path.join(d, '.plangraph');
  const rows = genPlan({ n: 12, people: 2, seed: 3 }).schedule.map((s) => ({ item: s.key, owner: s.owner, sprint: s.sprint + 1 }));
  fs.writeFileSync(path.join(d, 's.json'), JSON.stringify(rows));
  let r = run(d, ['schedule-load', 's.json', 'prev']); assert.equal(r.status, 0, r.stderr);
  r = run(d, ['export']); assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
  const text = fs.readFileSync(path.join(b, 'schedule.jsonl'), 'utf8');
  assert.match(text, /"version":"prev"/);
  assert.equal(run(d, ['check']).stderr, '');
});

test('spErrors (sp-ingest, sp-link, learn): a refused write target is REFUSED (exit 4), other failures stay DATA (exit 2)', async () => {
  const { spErrors } = await import('../src/commands/integrations.ts');
  const code = (e: unknown) => { try { spErrors(e); } catch (x) { return [(x as PlangraphError).code, (x as PlangraphError).exitCode]; } return null; }; // spErrors throws a PlangraphError
  assert.deepEqual(code(Object.assign(new Error('refusing to write through a symlink: refs.jsonl'), { code: 'SYMLINK' })), ['REFUSED', 4]);
  assert.deepEqual(code(Object.assign(new Error('path is outside the repository: ../x'), { code: 'OUTSIDE_REPO' })), ['REFUSED', 4]);
  assert.deepEqual(code(new Error('refusing to write refs.jsonl: it is a symlink (nothing was written)')), ['REFUSED', 4]);
  assert.deepEqual(code(new Error('refs.jsonl:1: invalid JSON')), ['DATA', 2]);
  assert.deepEqual(code(new Error('not refusing to write anything')), ['DATA', 2]);
  assert.deepEqual(code(new PlangraphError('DATA', 'path is outside the repository: ../plan.md')), ['DATA', 2], 'a typed read refusal keeps exit 2');
});

// ---------- dry-run fixes: empty sprint message, init on an existing plangraph ----------
test('plangraph sprint on a sprint with no tickets says so and names the covered range; --json carries the same in data', () => {
  const d = repo(), r = run(d, ['sprint', '999']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sprint 999: no tickets; plan covers S\d+-S\d+\n$/);
  const j = JSON.parse(run(d, ['sprint', '999', '--json']).stdout);
  assert.equal(j.v, 2); assert.equal(j.exit, 0); assert.equal(j.data.empty, true); assert.deepEqual(j.data.rows, []);
  assert.ok(Number.isInteger(j.data.covers.first) && j.data.covers.last >= j.data.covers.first);
  assert.equal(run(d, ['sprint', '1']).stdout.includes('no tickets'), false); // a populated sprint is unchanged
});
test('plangraph sprint with an empty schedule says the plan has no scheduled tickets', () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); assert.equal(run(d, ['init']).status, 0); assert.equal(run(d, ['build']).status, 0);
  assert.equal(run(d, ['sprint', '2']).stdout, 'sprint 2: no tickets; the plan has no scheduled tickets\n');
});
const snap = (dir: string) => Object.fromEntries(fs.readdirSync(dir).filter((f) => f !== '.gitignore').map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
test('init on an existing plangraph keeps every .gitignore line, reports already initialised, and a second run changes nothing', () => {
  const d = repo(), b = path.join(d, '.plangraph'), gi = path.join(b, '.gitignore');
  fs.writeFileSync(gi, '*.sqlite\n*.sqlite-journal\n*.sqlite-wal\n*.sqlite-shm\nCARD.md\n'); const before = snap(b);
  const r1 = run(d, ['init']); assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout.split('\n')[0], 'already initialised: .plangraph (no changes)'); // then the CLAUDE.md snippet (test/steer.test.ts)
  assert.equal(fs.readFileSync(gi, 'utf8'), '*.sqlite\n*.sqlite-journal\n*.sqlite-wal\n*.sqlite-shm\nCARD.md\n'); assert.deepEqual(snap(b), before);
  const m = fs.statSync(gi).mtimeMs; assert.equal(run(d, ['init']).stdout, r1.stdout); assert.equal(fs.statSync(gi).mtimeMs, m); // nothing missing: no write
});
test('init on an existing plangraph only appends the missing *.sqlite and sidecar lines, preserving user lines, order and a missing final newline', () => {
  const d = repo(), b = path.join(d, '.plangraph'), gi = path.join(b, '.gitignore');
  fs.writeFileSync(gi, '# mine\nCARD.md\n\nout/'); const before = snap(b);
  const r = run(d, ['init']); assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n')[0], 'already initialised: .plangraph (added *.sqlite, *.sqlite-journal, *.sqlite-wal, *.sqlite-shm to .gitignore)');
  assert.equal(fs.readFileSync(gi, 'utf8'), '# mine\nCARD.md\n\nout/\n*.sqlite\n*.sqlite-journal\n*.sqlite-wal\n*.sqlite-shm\n'); assert.deepEqual(snap(b), before);
  assert.equal(run(d, ['init']).stdout.split('\n')[0], 'already initialised: .plangraph (no changes)');
});
test('a fresh init still says initialised and tells what to do next', () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d });
  assert.match(run(d, ['init']).stdout, /^initialised \.plangraph: edit config\.json/);
});

// Review I1: on a fresh `plangraph init` (frozen_statuses: []) a repair used to shift a Done consumer and write it.
test('whatif --apply-plan --write never shifts a Done ticket on a fresh plangraph init; the index is left unchanged', () => {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-1', summary: 'a', sp: 3, jira_status: 'To Do' }, { key: 'T-2', summary: 'b', sp: 2, jira_status: 'Done' }]));
  fs.writeFileSync(path.join(b, 'edges.jsonl'), jl([{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }]));
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 2 }]));
  assert.equal(run(d, ['build']).status, 0);
  const before = fs.readFileSync(path.join(b, INDEX_FILE));
  const r = run(d, ['whatif', 'T-1', '--sprint', '3', '--apply-plan', '--write']);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /^NO PLAN: CONSUMER_EARLY T-2 .*NO_REPAIR/);
  assert.doesNotMatch(r.stdout, /T-2 Ana S2 > /);
  assert.ok(fs.readFileSync(path.join(b, INDEX_FILE)).equals(before), 'nothing written');
});

// Review I3: whatif searches its suggestion with slip allowed, but the next command repeated only the user's flags, so following it said
// NO_REPAIR. Executing the printed next command must reproduce the suggestion (in-process main(), one repo, 200+ random plans).
test('whatif: executing the printed next command reproduces the suggestion (200+ random plans, random moves and flags)', async () => {
  const { rng } = await import('./fixtures/gen.ts');
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  const call = async (argv: string[]) => { const io = silentIo(); const code = await main(argv, { io: io.io, cwd: d, env: { ...ENV, CLAUDE_PLUGIN_DATA: path.join(d, '.data') } }); return { code, out: io.o.out.join('\n') }; };
  let checked = 0, slipped = 0; const wrong = [];
  for (let seed = 1; seed <= 220; seed++) {
    const g = genPlan({ n: 8 + (seed % 10), people: 2 + (seed % 2), density: 0.3, seed: seed + 1700, maxSp: 4 });
    const ld = new Map<string, number>(); for (const s of g.schedule) ld.set(`${s.owner}|${s.sprint}`, (ld.get(`${s.owner}|${s.sprint}`) || 0) + (g.tickets.find((t) => t.key === s.key) as { sp: number }).sp); // genPlan schedules its own tickets
    fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ ...g.config, caps: { default: Math.max(...ld.values()) } }));
    fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl(g.tickets)); fs.writeFileSync(path.join(b, 'edges.jsonl'), jl(g.edges)); fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl(g.schedule));
    assert.equal((await call(['build'])).code, 0);
    const r = rng(seed), ppl = [...new Set(g.schedule.map((s) => s.owner))].sort();
    for (let j = 0; j < 3; j++) {
      const key = g.tickets[Math.floor(r() * g.tickets.length)].key, argv = ['whatif', key, '--sprint', String(1 + Math.floor(r() * g.config.end_sprint))];
      if (r() < 0.5) argv.push('--to', ppl[Math.floor(r() * ppl.length)]);
      if (r() < 0.25) argv.push('--earlier'); if (r() < 0.25) argv.push('--owner-change');
      const w = JSON.parse((await call([...argv, '--json'])).out), s = w.data.suggestion;
      if (!s || s.none) continue;
      const next = w.next[0]; assert.match(next, /^plangraph whatif .* --apply-plan$/, next);
      const a = await call(next.split(' ').slice(1)), lines = a.out.split('\n');
      const m = /^PLAN: \d+ move\(s\), (\d+) others shifted, (\d+) owner changes/.exec(lines[0]), mv = lines[1] ? / > (\S+) S(\d+)$/.exec(lines[1]) : null;
      checked++; if (s.flags?.includes('slip')) slipped++;
      if (a.code !== 0 || !m || !mv || Number(mv[2]) !== s.sprint || mv[1] !== s.owner.split(' ')[0] || Number(m[1]) !== s.shifts || Number(m[2]) !== s.ownerChanges) wrong.push(`${seed} ${argv.join(' ')}: ${JSON.stringify(s)} -> ${next} -> ${lines[0]}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 4), [], `${wrong.length} of ${checked} next commands did not reproduce the suggestion`);
  assert.ok(checked >= 200 && slipped >= 15, `checked ${checked}, slipped ${slipped}`);
});

// Review M1: bad data never reaches whatif as an internal error. The build refuses a fractional sprint (exit 2, file:line), and an index that
// already holds one (built by an older version) makes whatif a data error, not exit 5.
test('a fractional sprint: build exits 2 naming schedule.jsonl and the line; whatif on an older index with one is a data error (exit 2)', async () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph');
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-1', summary: 'a', sp: 3 }, { key: 'T-2', summary: 'b', sp: 2 }]));
  fs.writeFileSync(path.join(b, 'edges.jsonl'), jl([{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }]));
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 2.5 }]));
  let r = run(d, ['build']);
  assert.equal(r.status, 2); assert.equal(r.stderr.split('\n')[0], 'error: schedule.jsonl:2: "sprint" must be a whole number');
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 2 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 3 }]));
  assert.equal(run(d, ['build']).status, 0);
  const { DatabaseSync } = await import('node:sqlite');
  { const db = new DatabaseSync(path.join(b, INDEX_FILE)); db.exec("UPDATE schedule SET sprint=2.5 WHERE key='T-2'; DELETE FROM index_meta WHERE k='content_digest'"); db.close(); } // an older build: no digest
  for (const args of [['whatif', 'T-1', '--sprint', '3'], ['whatif', 'T-1', '--sprint', '3', '--apply-plan'], ['whatif', 'T-2', '--sprint', '4', '--apply-plan']]) {
    r = run(d, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^STALE: the text files changed since the index was built; run `plangraph build`\nerror: the index holds a sprint that is not a whole number or a negative sp/, args.join(' '));
  }
  // M2: a negative sp (it made a vacated cell look roomier than it is) is the same data error
  { const db = new DatabaseSync(path.join(b, INDEX_FILE)); db.exec("UPDATE schedule SET sprint=3 WHERE key='T-2'; UPDATE ticket SET sp=-2 WHERE key='T-2'"); db.close(); }
  r = run(d, ['whatif', 'T-1', '--sprint', '3']); assert.equal(r.status, 2, r.stdout); assert.match(r.stderr, /^STALE: the text files changed since the index was built; run `plangraph build`\nerror: the index holds a sprint that is not a whole number or a negative sp/);
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-1', summary: 'a', sp: 3 }, { key: 'T-2', summary: 'b', sp: -2 }]));
  r = run(d, ['build']); assert.equal(r.status, 2); assert.equal(r.stderr.split('\n')[0], 'error: tickets.jsonl:2: "sp" must not be negative');
});

// Review M4: chain read every link, so a loop through an ignored link kind (check: loop-free) made chain fail with a cycle.
test('chain honours ignore_link_kinds like check: a loop closed only by an ignored kind is no cycle', () => {
  const d = tmp(); execFileSync('git', ['init', '-q'], { cwd: d }); assert.equal(run(d, ['init']).status, 0);
  const b = path.join(d, '.plangraph'), cfg = JSON.parse(fs.readFileSync(path.join(b, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ ...cfg, ignore_link_kinds: ['soft'] }));
  fs.writeFileSync(path.join(b, 'tickets.jsonl'), jl([{ key: 'T-1', summary: 'a', sp: 1 }, { key: 'T-2', summary: 'b', sp: 1 }]));
  fs.writeFileSync(path.join(b, 'edges.jsonl'), jl([{ consumer: 'T-2', producer: 'T-1', kind: 'plan_need' }, { consumer: 'T-1', producer: 'T-2', kind: 'soft' }]));
  fs.writeFileSync(path.join(b, 'schedule.jsonl'), jl([{ version: 'current', key: 'T-1', owner: 'Ana', sprint: 1 }, { version: 'current', key: 'T-2', owner: 'Ana', sprint: 2 }]));
  assert.equal(run(d, ['build']).status, 0);
  const r = run(d, ['chain', 'T-2']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.split('\n')[0], 'longest chain behind T-2: 1 hops, 0 handoffs, 1 critical path');
  assert.equal(run(d, ['chain', 'T-1']).stdout.split('\n')[0], 'longest chain behind T-1: 0 hops, 0 handoffs, 1 critical path');
});
