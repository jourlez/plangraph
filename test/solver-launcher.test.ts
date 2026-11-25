// bin/plangraph-solve-run on the no-uv fallback must not run code from the current directory. A plain `python -c`, `python -m venv` or
// `python -m pip` puts the current directory first on sys.path, so a repo that commits ortools.py, venv/ or pip.py would run it as the
// user. Every python invocation of the launcher therefore carries -I (isolated mode: no current directory or script directory on
// sys.path, PYTHON* variables and the user site ignored; -P alone does not exist on 3.10). The uv branches are not changed here.
// Covered: (1) static: every python command line of the script (uv lines excluded) passes -I first; (2) probes, run for real with uv hidden
// from PATH (PATH is one directory of symlinks to the few tools the fallback needs, never a host directory) and a fake python3 /
// python3.14 in it (each execs the real python3 with its arguments unchanged), from a hostile working directory: (a) ortools.py, venv/__main__.py and pip.py present: the venv step and the python3 import probe; (b) ortools.py and pip.py
// only: a real venv gets created, then the pip step, the venv's import probe and the final exec; (c) a cached venv already exists: its
// import probe runs first. PIP_NO_INDEX keeps pip offline: the install fails fast and the launcher exits 3 (or runs the stub solver when
// the host python3 has ortools). No marker file may appear.
// (3) the uv path with a fake uv: the preparation calls run from the plugin bin directory, the solver in the caller's directory.
// (4) the `uv run` fallbacks with a fake uv: both pass --no-config (a uv.toml or pyproject.toml in the caller's directory is not read) and an
// absolute --python found by `uv python find` run from bin/, and with none found the launcher exits 3 and runs no `uv run`; the user's own
// uv.toml comes back through --config-file, UV_CONFIG_FILE and UV_* variables still reach uv. (5) the venv base (no uv): only an absolute
// CLAUDE_PLUGIN_DATA is used; a group- or world-writable one falls back to ~/.cache/plangraph with one stderr line and is never changed
// (decision D19); a base that is a symlink, not a directory, not owned by the user or (the fallback itself) writable by others exits 3 before
// any python in it runs or any rm reaches it; a missing base is created 0700 whatever the umask.
// NOT covered: Windows (POSIX sh launcher), a host without python3 (the probes skip and say so; the static test still runs), a real uv
// (test/solver.test.ts runs the fallbacks with the real uv in a hostile directory; the --no-config and --config-file combination was measured
// with uv 0.8.8 and 0.4.30, docs/SOLVER.md).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RUN = path.resolve(import.meta.dirname, '../bin/plangraph-solve-run');
const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('every python invocation in bin/plangraph-solve-run carries -I (isolated mode); the uv branches are left alone', () => {
  const code = fs.readFileSync(RUN, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*echo\b/.test(l) && !/\buv (run|sync|python)\b/.test(l));
  const PY = /("\$VENV\/bin\/python"|"python\$v"|\bpython3\b(?!\.))(\s+(\S+))?/g;
  const calls: string[] = [];
  for (const line of code) {
    for (const m of line.matchAll(PY)) {
      if (/(command -v|-x)\s+$/.test(line.slice(0, m.index))) continue; // `command -v python3` and `[ -x ... ]` look the command up, they do not run it
      calls.push(`${m[1]} ${m[3] ?? ''}`);
      assert.equal(m[3], '-I', `python invocation without -I: ${line.trim()}`);
    }
  }
  // "$VENV/bin/python" -c (twice), "python$v" -m venv, "$VENV/bin/python" -m pip, the venv exec, python3 -c and the python3 exec
  assert.equal(calls.length, 7, `found: ${calls.join(' | ')}`);
});

const which = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const real = which('python3');
const SKIP = process.platform === 'win32' ? 'skipped: the launcher is a POSIX sh script' : real ? false : 'skipped: no python3 on this host, the launcher fallback cannot run (the static -I test above still ran)';
if (SKIP) console.log(SKIP);
// The external commands the launcher's fallback path runs (besides python, faked below), and sh for the uv check. The probes' PATH is ONE
// directory holding symlinks to exactly these, so uv stays hidden even where it shares a directory with them (/usr/bin, /opt/homebrew/bin).
const TOOLS = ['sh', 'dirname', 'rm', 'mkdir', 'find', 'id']; // find and id check the venv base: missing, the check fails closed

/** A hostile working directory, a fake bin dir (python3 and python3.14 exec the real python3), and a run of the launcher's fallback path. */
function probe(files: Record<string, string>, { prebuiltVenv = false } = {}) {
  const cwd = tmp('sl-cwd-'), marks = tmp('sl-marks-'), bin = tmp('sl-bin-'), data = tmp('sl-data-'), home = tmp('sl-home-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), body.replace('MARK', JSON.stringify(path.join(marks, rel.replace(/\W/g, '_')))));
  }
  for (const name of ['python3', 'python3.14']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  for (const name of TOOLS) {
    const at = which(name);
    assert.ok(at.startsWith('/'), `${name} not found on this host's PATH`);
    fs.symlinkSync(at, path.join(bin, name));
  }
  if (prebuiltVenv) assert.equal(spawnSync(real, ['-I', '-m', 'venv', '--without-pip', path.join(data, 'venv')], { cwd: tmp('sl-clean-') }).status, 0, 'a cached venv without ortools');
  const stub = path.join(tmp('sl-stub-'), 'solver.py'); fs.writeFileSync(stub, 'print("stub solver ran")\n');
  const env = { PATH: bin, HOME: home, CLAUDE_PLUGIN_DATA: data, PLANGRAPH_SOLVE_SCRIPT: stub, PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_CONFIG_FILE: '/dev/null' };
  assert.deepEqual(fs.readdirSync(bin).sort(), [...TOOLS, 'python3', 'python3.14'].sort(), 'the probe PATH holds only the fakes and the needed tools');
  // `command -v` of a missing command exits 1 in bash and zsh but 127 in dash (Ubuntu's sh): any non-zero status with no output is "hidden".
  const uv = spawnSync('sh', ['-c', 'command -v uv'], { env, encoding: 'utf8' });
  assert.ok(uv.status !== 0 && uv.stdout === '', `uv is hidden from PATH: the fallback runs (status ${uv.status}, found ${uv.stdout.trim()})`);
  const r = spawnSync(RUN, ['--help'], { cwd, env, encoding: 'utf8', timeout: 240000 });
  return { r, marks: fs.readdirSync(marks) };
}
const HOSTILE = (what: string) => `open(MARK, "w").write("PWNED-${what}")\nprint("PWNED-${what}")\n`;

test('probe (a): a hostile ortools.py, venv/__main__.py and pip.py in the working directory never run (venv step, python3 import probe)', { skip: SKIP }, () => {
  const { r, marks } = probe({ 'ortools.py': HOSTILE('ortools'), 'venv/__init__.py': '', 'venv/__main__.py': HOSTILE('venv'), 'pip.py': HOSTILE('pip') });
  assert.deepEqual(marks, [], `hostile files ran: ${marks.join(', ')}; stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.ok(r.status === 3 || /stub solver ran/.test(r.stdout), `exit 3 (no OR-Tools) or the stub solver: status ${r.status}, ${r.stderr}`);
});

test('probe (b): with no venv/ shadow a real venv is built, and a hostile pip.py and ortools.py still never run (pip step, venv import probe)', { skip: SKIP, timeout: 300000 }, () => {
  const { r, marks } = probe({ 'ortools.py': HOSTILE('ortools'), 'pip.py': HOSTILE('pip') });
  assert.deepEqual(marks, [], `hostile files ran: ${marks.join(', ')}; stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.ok(r.status === 3 || /stub solver ran/.test(r.stdout), `exit 3 (no OR-Tools) or the stub solver: status ${r.status}, ${r.stderr}`);
});

test('probe (c): a cached venv\'s import probe never imports a hostile ortools.py from the working directory', { skip: SKIP, timeout: 300000 }, () => {
  const { r, marks } = probe({ 'ortools.py': HOSTILE('ortools') }, { prebuiltVenv: true });
  assert.deepEqual(marks, [], `hostile files ran: ${marks.join(', ')}; stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.ok(r.status === 3 || /stub solver ran/.test(r.stdout), `exit 3 (no OR-Tools) or the stub solver: status ${r.status}, ${r.stderr}`);
});

// The uv path: uv reads a uv.toml (or pyproject.toml [tool.uv]) from the directory it runs in, even with --script, so a repository could
// point it at another package index. The two preparation calls (`uv sync --locked --script`, `uv python find --script`) therefore run from
// the plugin's bin directory, while the solver itself still runs in the caller's directory (its arguments may be relative paths). A fake uv
// records the directory and arguments of each call; its `python find` names a fake interpreter that records where the solver ran.
test('uv path: uv sync and uv python find run from the plugin bin directory, never the (hostile) working directory; the solver runs in the caller directory', { skip: process.platform === 'win32' ? 'POSIX sh launcher' : false }, () => {
  const cwd = tmp('sl-uvcwd-'), bin = tmp('sl-uvbin-'), log = path.join(tmp('sl-uvlog-'), 'calls.log');
  fs.writeFileSync(path.join(cwd, 'uv.toml'), 'index-url = "http://127.0.0.1:9/simple"\n');
  const py = path.join(bin, 'fakepy');
  fs.writeFileSync(py, `#!/bin/sh\necho "solver $(pwd -P) $*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'uv'), `#!/bin/sh\necho "uv $(pwd -P) $1 $2" >> ${JSON.stringify(log)}\nif [ "$1" = python ]; then echo ${JSON.stringify(py)}; fi\nexit 0\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp('sl-uvhome-') };
  const r = spawnSync(RUN, ['--in', 'x.json'], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const here = fs.realpathSync(path.dirname(RUN));
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [`uv ${here} sync --quiet`, `uv ${here} python find`, `solver ${cwd} ${path.join(here, 'plangraph-solve')} --in x.json`]);
});

// The `uv run` fallbacks (an older uv without `sync --script`, or PLANGRAPH_SOLVE_LAUNCH=uv-run) run in the caller's directory, where uv picks
// its interpreter from a committed .venv (every uv version) or .python-version (uv 0.4.30), even with --no-config. Both fallbacks therefore
// pass an absolute --python found by `uv python find` run from the plugin bin directory (0.2.4). The fake uv fails `sync`, records cwd and
// argv of every call, and answers `python find` with FIND (an absolute fake interpreter by default). The real-uv hostile cases live in
// test/solver.test.ts.
function fallback({ find, env: extra = {}, script, files = {}, home = tmp('sl-fbhome-') }: { find?: string; env?: Record<string, string>; script?: string; files?: Record<string, string>; home?: string } = {}) {
  const cwd = tmp('sl-fbcwd-'), bin = tmp('sl-fbbin-'), log = path.join(tmp('sl-fblog-'), 'calls.log');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), body); }
  const py = path.join(bin, 'fakepy');
  fs.writeFileSync(py, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const answer = find ?? py;
  fs.writeFileSync(path.join(bin, 'uv'), [
    '#!/bin/sh',
    `echo "uv $(pwd -P) $*" >> ${JSON.stringify(log)}`,
    `if [ "$1" = run ]; then env | grep '^UV_' | sort >> ${JSON.stringify(`${log}.env`)}; fi`,
    'if [ "$1" = sync ]; then exit 1; fi',
    `if [ "$1" = python ]; then if [ -n ${JSON.stringify(answer)} ]; then echo ${JSON.stringify(answer)}; exit 0; fi; echo "error: no interpreter found" >&2; exit 2; fi`,
    'exit 0', ''].join('\n'), { mode: 0o755 });
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_PLUGIN_DATA: tmp('sl-fbdata-'), ...extra };
  if (script) env.PLANGRAPH_SOLVE_SCRIPT = script;
  const r = spawnSync(RUN, ['--in', 'x.json'], { cwd, env, encoding: 'utf8', timeout: 60000 });
  const read = (f: string) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n') : [];
  return { r, cwd, py, home, here: fs.realpathSync(path.dirname(RUN)), lines: read(log), uvEnv: read(`${log}.env`) };
}
const POSIX_ONLY = process.platform === 'win32' ? 'POSIX sh launcher' : false;

test('the fallback passes --no-config and an absolute --python found by uv python find run from bin/', { skip: POSIX_ONLY }, () => {
  // sync fails (an older uv): the locked-script fallback
  const a = fallback();
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.deepEqual(a.lines.slice(1), [`uv ${a.here} python find >=3.10,<3.15`, `uv ${a.cwd} run --no-config --quiet --python ${a.py} --locked --script ${path.join(a.here, 'plangraph-solve')} --in x.json`]);
  // PLANGRAPH_SOLVE_LAUNCH=uv-run skips sync; PLANGRAPH_SOLVE_SCRIPT takes the --with branch; UV_PYTHON is the request given to uv python find
  const stub = path.join(tmp('sl-fbstub-'), 'solver.py'); fs.writeFileSync(stub, 'print(1)\n');
  const b = fallback({ script: stub, env: { PLANGRAPH_SOLVE_LAUNCH: 'uv-run', UV_PYTHON: '3.12' } });
  assert.equal(b.r.status, 0, b.r.stderr);
  assert.deepEqual(b.lines, [`uv ${b.here} python find 3.12`, `uv ${b.cwd} run --no-config --quiet --no-project --python ${b.py} --with ortools==9.15.6755 python ${stub} --in x.json`]);
});

test('with no interpreter found the fallback exits 3 naming uv python install 3.14 and runs no uv run', { skip: POSIX_ONLY }, () => {
  for (const find of ['', './evil/python3', '/nonexistent/python3']) {
    const c = fallback({ find });
    assert.equal(c.r.status, 3, `find ${JSON.stringify(find)}: ${c.r.stderr}`);
    assert.equal(c.r.stderr, 'plangraph-solve: no Python 3.10-3.14 found by uv; run: uv python install 3.14\n');
    assert.ok(!c.lines.some((l) => / run /.test(l)), `no uv run: ${c.lines.join(' | ')}`);
    assert.ok(!c.lines.some((l) => /python install/.test(l)), 'the launcher never installs a Python itself');
  }
});

// --no-config: the `uv run` fallbacks run in the caller's directory, where uv would read a uv.toml (or pyproject.toml [tool.uv]) that could
// point it at another package index. --no-config drops every configuration file, so the user's own uv.toml comes back by an explicit
// --config-file (absolute XDG_CONFIG_HOME, else $HOME/.config); a UV_CONFIG_FILE the user set and UV_* variables (a mirror) still reach uv.
const lockedRun = (f: ReturnType<typeof fallback>, cfg = '') => `uv ${f.cwd} run --no-config ${cfg}--quiet --python ${f.py} --locked --script ${path.join(f.here, 'plangraph-solve')} --in x.json`;
const HOSTILE_TOML = { 'uv.toml': 'index-url = "http://127.0.0.1:9/hostile/simple"\n', 'pyproject.toml': '[tool.uv]\nindex-url = "http://127.0.0.1:9/hostile/simple"\n' };

test('the uv run fallback for bin/plangraph-solve passes --no-config', { skip: POSIX_ONLY }, () => {
  const f = fallback({ env: { PLANGRAPH_SOLVE_LAUNCH: 'uv-run' } });
  assert.equal(f.r.status, 0, f.r.stderr);
  assert.deepEqual(f.lines, [`uv ${f.here} python find >=3.10,<3.15`, lockedRun(f)]);
});

test('with a hostile uv.toml and pyproject.toml in the working directory the fallback still passes --no-config', { skip: POSIX_ONLY }, () => {
  const f = fallback({ files: HOSTILE_TOML });
  assert.equal(f.r.status, 0, f.r.stderr);
  assert.equal(f.lines.at(-1), lockedRun(f));
});

test('UV_INDEX_URL and UV_DEFAULT_INDEX reach the fallback call', { skip: POSIX_ONLY }, () => {
  const f = fallback({ env: { UV_INDEX_URL: 'https://mirror.example/simple', UV_DEFAULT_INDEX: 'https://mirror.example/default' } });
  assert.equal(f.r.status, 0, f.r.stderr);
  assert.ok(f.uvEnv.includes('UV_INDEX_URL=https://mirror.example/simple') && f.uvEnv.includes('UV_DEFAULT_INDEX=https://mirror.example/default'), f.uvEnv.join(' | '));
});

test('a mirror set in the user\'s uv.toml (XDG_CONFIG_HOME, else ~/.config) reaches the fallback through --config-file', { skip: POSIX_ONLY }, () => {
  const xdg = tmp('sl-xdg-'); fs.mkdirSync(path.join(xdg, 'uv')); fs.writeFileSync(path.join(xdg, 'uv', 'uv.toml'), 'index-url = "https://mirror.example/simple"\n');
  const a = fallback({ env: { XDG_CONFIG_HOME: xdg }, files: HOSTILE_TOML });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.lines.at(-1), lockedRun(a, `--config-file ${path.join(xdg, 'uv', 'uv.toml')} `));
  const home = tmp('sl-xdghome-'); fs.mkdirSync(path.join(home, '.config', 'uv'), { recursive: true }); fs.writeFileSync(path.join(home, '.config', 'uv', 'uv.toml'), '');
  const b = fallback({ home });
  assert.equal(b.lines.at(-1), lockedRun(b, `--config-file ${path.join(home, '.config', 'uv', 'uv.toml')} `));
  // no user file: no --config-file (an XDG_CONFIG_HOME without uv/uv.toml)
  const c = fallback({ env: { XDG_CONFIG_HOME: tmp('sl-xdgempty-') } });
  assert.equal(c.lines.at(-1), lockedRun(c));
  // a relative XDG_CONFIG_HOME would resolve in the caller's directory: ignored, ~/.config (absent here) applies
  const d = fallback({ env: { XDG_CONFIG_HOME: 'cfg' }, files: { 'cfg/uv/uv.toml': HOSTILE_TOML['uv.toml'] } });
  assert.equal(d.lines.at(-1), lockedRun(d));
});

test('with UV_CONFIG_FILE set the fallback passes no --config-file, so the user\'s chosen file applies', { skip: POSIX_ONLY }, () => {
  const xdg = tmp('sl-xdg-'); fs.mkdirSync(path.join(xdg, 'uv')); fs.writeFileSync(path.join(xdg, 'uv', 'uv.toml'), '');
  const chosen = path.join(tmp('sl-chosen-'), 'uv.toml'); fs.writeFileSync(chosen, '');
  const f = fallback({ env: { XDG_CONFIG_HOME: xdg, UV_CONFIG_FILE: chosen } });
  assert.equal(f.r.status, 0, f.r.stderr);
  assert.equal(f.lines.at(-1), lockedRun(f));
  assert.ok(f.uvEnv.includes(`UV_CONFIG_FILE=${chosen}`), f.uvEnv.join(' | '));
});

test('the plugin tree holds no uv.toml or pyproject.toml (uv walks up from bin/ for one)', () => {
  const root = path.resolve(import.meta.dirname, '..'), found: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(path.join(d, e.name)); }
      else if (e.name === 'uv.toml' || e.name === 'pyproject.toml') found.push(path.relative(root, path.join(d, e.name)));
    }
  };
  walk(root);
  assert.deepEqual(found, []);
});

// The venv base (no uv): CLAUDE_PLUGIN_DATA only when absolute, else ~/.cache/plangraph (the lib/driver.ts defaultDataDir rule). Whoever can
// write the base can plant venv/bin/python, which the launcher would run, so the base must be a real directory owned by the user without
// group or world write before the first use of the venv. A group- or world-writable CLAUDE_PLUGIN_DATA (Claude Code creates it with the
// default mode, so 775 under umask 002) is not an error: the launcher falls back to ~/.cache/plangraph with one stderr line and never
// changes the other directory (decision D19). The fake python3.14 records each call and fails, so the run ends in exit 3; no python3.
function venvRun({ data, home = tmp('sl-vhome-'), files = {}, umask }: { data?: string; home?: string; files?: Record<string, string>; umask?: string }) {
  const cwd = tmp('sl-vcwd-'), bin = tmp('sl-vbin-'), log = path.join(tmp('sl-vlog-'), 'calls.log');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), body); }
  fs.writeFileSync(path.join(bin, 'python3.14'), `#!/bin/sh\necho "python3.14 $*" >> ${JSON.stringify(log)}\nexit 1\n`, { mode: 0o755 });
  for (const name of TOOLS) fs.symlinkSync(which(name), path.join(bin, name));
  const env: Record<string, string> = { PATH: bin, HOME: home };
  if (data !== undefined) env.CLAUDE_PLUGIN_DATA = data;
  const r = umask ? spawnSync(which('sh'), ['-c', `umask ${umask} && exec "$0" --help`, RUN], { cwd, env, encoding: 'utf8', timeout: 60000 })
    : spawnSync(RUN, ['--help'], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { r, cwd, home, lines: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}
/** A planted venv/bin/python under base that records a run in a file outside it. */
function plant(base: string) {
  const record = path.join(tmp('sl-rec-'), 'ran'), py = path.join(base, 'venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, `#!/bin/sh\necho ran >> ${JSON.stringify(record)}\nexit 0\n`, { mode: 0o755 });
  return { record, py };
}
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const UNAVAILABLE = /^plangraph-solve: OR-Tools is unavailable/m;

test('a relative CLAUDE_PLUGIN_DATA never reaches rm -rf: the venv goes under ~/.cache/plangraph', { skip: POSIX_ONLY }, () => {
  const v = venvRun({ data: 'rel', files: { 'rel/venv/keep': 'sentinel' } });
  assert.equal(v.r.status, 3, v.r.stderr); assert.match(v.r.stderr, UNAVAILABLE);
  assert.ok(fs.existsSync(path.join(v.cwd, 'rel', 'venv', 'keep')), 'the sentinel in the working directory survives');
  assert.deepEqual(v.lines, [`python3.14 -I -m venv ${path.join(v.home, '.cache', 'plangraph', 'venv')}`]);
  assert.equal(mode(path.join(v.home, '.cache', 'plangraph')), 0o700);
});

test('a group- or world-writable CLAUDE_PLUGIN_DATA is not used: one stderr line, the venv goes under ~/.cache/plangraph, the directory is never changed and a planted venv python in it never runs (D19)', { skip: POSIX_ONLY }, () => {
  for (const m of [0o775, 0o757, 0o777]) {
    const data = tmp('sl-open-'), p = plant(data); fs.chmodSync(data, m);
    const v = venvRun({ data });
    assert.equal(v.r.status, 3, v.r.stderr);
    assert.equal(v.r.stderr.split('\n')[0], `plangraph-solve: CLAUDE_PLUGIN_DATA (${data}) is group or world writable; the venv goes under ${path.join(v.home, '.cache', 'plangraph')} instead`);
    assert.match(v.r.stderr, UNAVAILABLE);
    assert.ok(!fs.existsSync(p.record), `the planted python ran (mode ${m.toString(8)})`);
    assert.ok(fs.existsSync(p.py), 'no rm reached the untrusted directory');
    assert.equal(mode(data), m, 'never chmod');
    assert.deepEqual(v.lines, [`python3.14 -I -m venv ${path.join(v.home, '.cache', 'plangraph', 'venv')}`]);
    fs.chmodSync(data, 0o700);
  }
});

test('an untrusted venv base exits 3 before any python in it runs or any rm reaches it; only the group or world writable case names chmod go-w', { skip: POSIX_ONLY }, () => {
  const check = (v: ReturnType<typeof venvRun>, base: string, why: string, p?: ReturnType<typeof plant>) => {
    assert.equal(v.r.status, 3, v.r.stderr);
    assert.equal(v.r.stderr, `plangraph-solve: refusing the venv base ${base}: ${why}\n`);
    assert.deepEqual(v.lines, [], 'no python ran');
    if (p) { assert.ok(!fs.existsSync(p.record), 'the planted python never ran'); assert.ok(fs.existsSync(p.py), 'no rm reached it'); }
  };
  // the fallback itself group-writable (no CLAUDE_PLUGIN_DATA): refused with the chmod hint, never changed
  const home = tmp('sl-vhome-'), fb = path.join(home, '.cache', 'plangraph'), p = plant(fb); fs.chmodSync(fb, 0o775);
  check(venvRun({ home }), fb, `it is group or world writable; run: chmod go-w ${fb}`, p);
  assert.equal(mode(fb), 0o775); fs.chmodSync(fb, 0o700);
  // a symlinked CLAUDE_PLUGIN_DATA (to a private directory holding a planted venv)
  const real = tmp('sl-real-'), q = plant(real), link = path.join(tmp('sl-link-'), 'data'); fs.symlinkSync(real, link);
  check(venvRun({ data: link }), link, 'it is a symlink', q);
  // a file
  const file = path.join(tmp('sl-file-'), 'data'); fs.writeFileSync(file, '');
  check(venvRun({ data: file }), file, 'it is not a directory');
  // a directory of another user (root-owned /usr, not writable by others)
  if (process.getuid?.() !== 0) check(venvRun({ data: '/usr' }), '/usr', 'it is not owned by the current user');
});

test('with umask 002 and no data directory, the launcher creates it 0700 and proceeds', { skip: POSIX_ONLY }, () => {
  const data = path.join(tmp('sl-new-'), 'deep', 'data');
  const a = venvRun({ data, umask: '002' });
  assert.equal(a.r.status, 3, a.r.stderr); assert.match(a.r.stderr, UNAVAILABLE);
  assert.equal(mode(data), 0o700); assert.equal(mode(path.dirname(data)), 0o700);
  assert.deepEqual(a.lines, [`python3.14 -I -m venv ${path.join(data, 'venv')}`]);
  const b = venvRun({ umask: '002' });
  assert.equal(mode(path.join(b.home, '.cache', 'plangraph')), 0o700);
  assert.deepEqual(b.lines, [`python3.14 -I -m venv ${path.join(b.home, '.cache', 'plangraph', 'venv')}`]);
});
