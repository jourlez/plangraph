// Tiny mutation runner: applies a fixed list of one-line source mutations to a COPY of the repo (the working tree is never touched),
// runs the relevant test files against each, and prints killed/survived counts. A mutation is killed when its tests fail or time out.
// The mutants run in parallel, one repository copy per worker (scripts/mutate-pool.mjs); the report lists survivors in mutant order.
// Usage: node scripts/mutate.mjs [--list] [--jobs N] (default: min(available cores, 4)).
// Exit 0 when all mutants are killed, 1 when any survived, 2 on a stale mutation, a red baseline or a bad --jobs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pool, parseJobs } from './mutate-pool.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const M = 'test/merge.test.mjs', MR = 'test/merge-reference.test.mjs', ST = 'test/stale.test.mjs', OI = 'test/openitems.test.mjs';
const SAN = ['test/sanitize.test.mjs', 'test/security.test.mjs', 'test/security-final.test.mjs'];
const DB = ['test/build-extra.test.mjs', 'test/cli-core.test.mjs', 'test/security-final.test.mjs'];
// [file, exact text (must occur exactly once), replacement, test files]
/** @type {Array<[string, string, string, string[]]>} */
const MUTATIONS = [
  ['lib/merge.mjs', 'return { v: o === undefined ? t : o };', 'return { v: o };', [MR]],
  ['lib/merge.mjs', 'if (so === sb) return { v: t };', 'if (so === sb) return { v: o };', [M, MR]],
  ['lib/merge.mjs', 'if (st === sb) return { v: o };', 'if (st === sb) return { v: t };', [M, MR]],
  ['lib/merge.mjs', '(!O.has(k) || !T.has(k))', '(!O.has(k) && !T.has(k))', [M, MR]],
  ['lib/merge.mjs', 'else if (!o.lines.length) clash(', 'else if (o.lines.length) clash(', [M, MR]],
  ['lib/merge.mjs', 'lines.length > 1 && !same(lines, b.lines)', 'lines.length > 9 && !same(lines, b.lines)', [M, MR]],
  ['lib/store.mjs', 'if (isSet) items = [...new Set(items)].sort();', 'if (isSet) items = [...new Set(items)];', ['test/store.test.mjs', M, MR]],
  ['lib/store.mjs', 'if (out[out.length - 1] !== line)', 'if (out[out.length - 1] === line)', ['test/store.test.mjs']],
  ['lib/store.mjs', ".join('\\x00');\nexport const showKey", ".join('|');\nexport const showKey", ['test/store.test.mjs', M]],
  ['lib/store.mjs', 'const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);', 'const keys = Object.keys(obj);', ['test/store.test.mjs']],
  ['lib/whatif.mjs', '!Number.isInteger(sprint) || sprint < first ||', '!Number.isInteger(sprint) || sprint <= first ||', ['test/whatif.test.mjs']],
  ['lib/whatif.mjs', '    if (sprint < need) reasons.push', '    if (sprint <= need) reasons.push', ['test/whatif.test.mjs']],
  ['lib/whatif.mjs', 'if (cc.sprint < need) reasons.push', 'if (cc.sprint <= need) reasons.push', ['test/whatif.test.mjs']],
  ['lib/whatif.mjs', '|| 0) + sp <= cap) { alt = s; break; }', '|| 0) + sp < cap) { alt = s; break; }', ['test/whatif.test.mjs']],
  ['lib/verify.mjs', 'if (pc.sprint < need) add(', 'if (pc.sprint <= need) add(', ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'if (v > cap) add(', 'if (v >= cap) add(', ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'if (v < min) add(', 'if (v <= min) add(', ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'pp.sprint + (pp.owner !== pc.owner ? 1 : 0)', 'pp.sprint + (pp.owner === pc.owner ? 1 : 0)', ['test/verify.test.mjs']],
  ['lib/verify.mjs', " && !isSpKey(k)) add('UNPLACED'", ") add('UNPLACED'", ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'if (cn === 1) {', 'if (cn === 2) {', ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'if (p && p.sprint < first && !frozen(k))', 'if (p && p.sprint <= first && !frozen(k))', ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'if (!p || p.owner !== f.owner || p.sprint !== f.sprint)', 'if (!p || p.owner !== f.owner && p.sprint !== f.sprint)', ['test/verify.test.mjs']],
  ['lib/verify.mjs', "'Done', ...(Array.isArray(cfg.closed_statuses)", '...(Array.isArray(cfg.closed_statuses)', ['test/verify.test.mjs']],
  ['lib/stale.mjs', ".replace(/\\r\\n?/g, '\\n')", ".replace(/\\r\\n/g, '\\n')", [ST]],
  ['lib/stale.mjs', 'if (fp.jira_updated != null && fp.jira_updated', 'if (fp.jira_updated', [ST]],
  ['lib/openitems.mjs', 'due - lead <= currentSprint', 'due - lead < currentSprint', [OI]],
  ['lib/openitems.mjs', 'late: due < currentSprint', 'late: due <= currentSprint', [OI]],
  ['lib/openitems.mjs', "(o.status === 'done' && !pruneClosed)", "(o.status === 'done')", [OI]],
  ['lib/sanitize.mjs', ".replace(/[<>]/g, '?')", ".replace(/[<]/g, '?')", SAN],
  ['lib/sanitize.mjs', '.slice(0, 8) !== m[1]) continue;', '.slice(0, 8) !== m[1] && false) continue;', SAN],
  ['src/db.mjs', '\\0-\\0`); continue; }', '\\0\\x30\\0\\0`); continue; }', DB], // a missing source file hashes like an empty one
  ['src/db.mjs', "if (h.stale) h.exec('PRAGMA query_only = ON');", 'if (h.stale) { /* query_only left off */ }', DB],
  ['src/db.mjs', 'info.some((c) => c.hidden !== 0) || ', '', DB],
  ['src/db.mjs', 'if (old || dead) fs.rmSync', 'if (old && dead) fs.rmSync', DB],
  ['lib/gitsafe.mjs', 'if (variable > 1) throw', 'if (variable > 9) throw', ['test/gitsafe.test.mjs']], // two variable # runs: backtracking
  // deliberately quadratic, output-identical mutants: killed only by the size-axis timing checks (n vs 4n)
  ['lib/gitsafe.mjs', 'nextIndex: (/** @type {string} */ text) => text.search(prefix),', "nextIndex: (/** @type {string} */ text) => { let k = 0; for (let i = 0; i < text.length; i++) k += text.indexOf('\\0', i) >>> 31; return k >= 0 ? text.search(prefix) : -1; },", ['test/gitsafe.test.mjs']],
  ['lib/render.mjs', 'vc.set(v, (vc.get(v) || 0) + 1); }', "vc.set(v, [...model.tickets.values()].filter((u) => String(u.verdict || 'unrated').slice(0, 20) === String(t.verdict || 'unrated').slice(0, 20)).length); }", ['test/hook.test.mjs']],
  ['lib/store.mjs', "text.split('\\n').some((l) => l.trim() ===", "text.split('\\n').some((l, i, a) => a.slice(0, i).join('\\n').length >= 0 && l.trim() ===", ['test/driver-wiring.test.mjs']],
  // limitations wave: index content digest, swap races, 0-SP capacity, stale driver target
  ['src/db.mjs', 'if (got !== want) throw new BrainError', 'if (got !== want && false) throw new BrainError', ['test/index-integrity.test.mjs']],
  ['lib/jsonl.mjs', 'if (pre && (st.dev !== pre.dev || st.ino !== pre.ino || st.ctimeMs !== pre.ctimeMs)) throw', 'if (false) throw', ['test/toctou-race.test.mjs']],
  ['lib/jsonl.mjs', 'st.ino !== pre.ino || st.ctimeMs !== pre.ctimeMs)) throw', 'st.ino !== pre.ino)) throw', ['test/toctou-race.test.mjs']],
  ['src/db.mjs', 'mine = fs.fstatSync(tfd); }', 'mine = fs.fstatSync(tfd); fs.closeSync(tfd); }', ['test/toctou-race.test.mjs']],
  ['lib/fsafe.mjs', "    if (!same(f.lstatSync(tmp), mine)) throw swapped('the temp file');", '', ['test/toctou-race.test.mjs']],
  ['lib/whatif.mjs', 'if (na > cap && na > nb) {', 'if (na > cap) {', ['test/whatif-zero-sp.test.mjs']],
  ['lib/store.mjs', 'else if (expected && !sameFile(t, expected))', 'else if (false && expected && !sameFile(t, expected))', ['test/driver-stale.test.mjs']],
  // fix wave B: each one killed by the test that came with its fix
  ['src/cli.mjs', '.slice(0, MAX_NEXT) }; }', '.slice(0, 9) }; }', ['test/cli-core.test.mjs']],
  ['src/cli.mjs', "  const all = text ? text.split('\\n') : [];", "  if (!text) return ''; const all = text.split('\\n');", ['test/json-envelope.test.mjs']],
  ['lib/verify.mjs', 'const spanOk = maxS - first <= MAX_SPAN;', 'const spanOk = maxS - first <= MAX_SPAN + 1;', ['test/verify.test.mjs']],
  ['lib/verify.mjs', 'if (!spanOk && checked.length) add(', 'if (!spanOk) add(', ['test/verify.test.mjs']],
  ['lib/model.mjs', "if (e.code === 'SYMLINK') throw fail('is a symlink', 'SYMLINK');", '', ['test/config-read.test.mjs']],
  ['lib/report.mjs', 'over: c.sp > capOf(model.config, c.owner)', 'over: c.sp >= capOf(model.config, c.owner)', ['test/report.test.mjs']],
  ['lib/report.mjs', '(d === depth.get(v) && cmp(u, prev.get(v)) < 0)', '(d === depth.get(v) && cmp(u, prev.get(v)) > 0)', ['test/report.test.mjs']],
  ['lib/ready.mjs', '  if (done) return { found: true, ready: false, done, reasons: [] };', '', ['test/ready.test.mjs', 'test/report.test.mjs']],
  // bulk ready (`brain ready --person/--sprint`): the scope filter, the verdict group, the cap marker and the exit code
  ['lib/ready.mjs', '(owner === undefined || s.owner === owner)', '(owner === undefined || s.owner !== undefined)', ['test/ready-bulk.test.mjs', 'test/assure.test.mjs']],
  ['lib/ready.mjs', "    if (r.reasons.some((x) => x.code === 'VERDICT')) verdict.push(key);", '', ['test/ready-bulk.test.mjs', 'test/assure.test.mjs']],
  ['src/commands/queries.mjs', '`${ks.slice(0, n).map(', '`${ks.slice(0).map(', ['test/ready-bulk.test.mjs']],
  ['src/commands/queries.mjs', '  return s.ready.length ? 0 : 1;', '  return 0;', ['test/ready-bulk.test.mjs']],
  // whatif --relieve: the choice rule, the links inside the cell, both capacity checks, frozen tickets, the budget, the apply order, the CLI
  ['lib/whatif.mjs', 'if (x.slip !== y.slip) return x.slip < y.slip;', 'if (x.slip !== y.slip) return x.slip > y.slip;', ['test/whatif-relieve.test.mjs', 'test/assure.test.mjs']],
  ['lib/whatif.mjs', 'if (x.oc !== y.oc) return x.oc < y.oc;', 'if (x.oc !== y.oc) return x.oc > y.oc;', ['test/whatif-relieve.test.mjs']],
  ['lib/whatif.mjs', 'if (pp && pc && !okLink(pp, pc)) { ok = false; break; }', '', ['test/whatif-relieve.test.mjs', 'test/assure.test.mjs']],
  ['lib/whatif.mjs', '        if (cur > capOf(cfg, to.owner)) continue;', '', ['test/whatif-relieve.test.mjs', 'test/assure.test.mjs']],
  ['lib/whatif.mjs', '      if ((loads.get(cellKey(to.owner, to.sprint)) || 0) + sp > capOf(cfg, to.owner)) continue;', '', ['test/whatif-relieve.test.mjs', 'test/golden.test.mjs']],
  ['lib/whatif.mjs', "return fz.has(t.jira_status) || (String(k).startsWith('sp:')", "return (String(k).startsWith('sp:')", ['test/whatif-relieve.test.mjs', 'test/assure.test.mjs']],
  ['lib/whatif.mjs', 'budget = opts.budget ?? RELIEVE_BUDGET;', 'budget = Infinity;', ['test/whatif-relieve.test.mjs']],
  ['lib/whatif.mjs', 'rest.findIndex((m) => whatif(', 'rest.findIndex((m) => true || whatif(', ['test/whatif-relieve.test.mjs', 'test/assure.test.mjs']],
  ['src/commands/plan.mjs', "  return r.status === 'no_relief' ? 1 : 0;", '  return 0;', ['test/whatif-relieve.test.mjs']],
  ['src/commands/plan.mjs', "if (v.to !== undefined || v['apply-plan'] || v.write) throw usage(", "if (false) throw usage(", ['test/whatif-relieve.test.mjs']],
];

if (process.argv.includes('--list')) { for (const [f, a, b] of MUTATIONS) console.log(`${f}: ${a} -> ${b}`); process.exit(0); }
let jobs = 1;
try { jobs = parseJobs(process.argv, Math.min(os.availableParallelism(), 4)); } catch (e) { console.error(String(/** @type {Error} */ (e).message)); process.exit(2); }

/** Run `node --test files` in `cwd`; resolves the exit code (null on a signal, a spawn error or the 180 s timeout: all count as a failure).
 * @param {string} cwd @param {string[]} files @returns {Promise<number | null>} */
const runTests = (cwd, files) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['--test', ...files], { cwd, stdio: 'ignore', timeout: 180000 });
  c.on('error', () => resolve(null));
  c.on('close', (code) => resolve(code));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mutate-'));
const copies = Array.from({ length: Math.min(jobs, MUTATIONS.length) }, (_, k) => path.join(tmp, `repo-${k}`));
try {
  for (const work of copies) fs.cpSync(ROOT, work, { recursive: true, filter: (s) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(path.relative(ROOT, s)) });
  const stale = MUTATIONS.find(([file, from]) => fs.readFileSync(path.join(copies[0], file), 'utf8').split(from).length !== 2);
  if (stale) { console.error(`stale mutation (not exactly one match): ${stale[0]}: ${stale[1]}`); process.exitCode = 2; }
  else if (await runTests(copies[0], [...new Set(MUTATIONS.flatMap((m) => m[3]))]) !== 0) { console.error('baseline is red: refusing to mutate'); process.exitCode = 2; }
  else {
    // worker w owns copies[w]: it applies one mutant, runs that mutant's tests and restores the file before taking the next mutant
    const killedBy = await pool(MUTATIONS, copies.length, async ([file, from, to, tests], _k, w) => {
      const p = path.join(copies[w], file), orig = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, orig.replace(from, () => to));
      try { return (await runTests(copies[w], tests)) !== 0; } finally { fs.writeFileSync(p, orig); }
    });
    const survived = MUTATIONS.filter((_, k) => !killedBy[k]).map(([file, from]) => `${file}: ${from}`);
    console.log(`mutants ${MUTATIONS.length}, killed ${MUTATIONS.length - survived.length}, survived ${survived.length}`);
    for (const s of survived) console.log(`SURVIVED ${s}`);
    process.exitCode = survived.length ? 1 : 0;
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
