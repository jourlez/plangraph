// bin/brain-solve-run on the no-uv fallback must not run code from the current directory. A plain `python -c`, `python -m venv` or
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
// NOT covered: Windows (POSIX sh launcher), a host without python3 (the probes skip and say so; the static test still runs), a real uv, and
// the `uv run` fallbacks (an older uv; they still run in the caller's directory, see KNOWN_ISSUES.md).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RUN = path.resolve(import.meta.dirname, '../bin/brain-solve-run');
const made: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('every python invocation in bin/brain-solve-run carries -I (isolated mode); the uv branches are left alone', () => {
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
const TOOLS = ['sh', 'dirname', 'rm', 'mkdir'];

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
  const env = { PATH: bin, HOME: home, CLAUDE_PLUGIN_DATA: data, BRAIN_SOLVE_SCRIPT: stub, PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_CONFIG_FILE: '/dev/null' };
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
  assert.deepEqual(lines, [`uv ${here} sync --quiet`, `uv ${here} python find`, `solver ${cwd} ${path.join(here, 'brain-solve')} --in x.json`]);
});
