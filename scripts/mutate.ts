// Tiny mutation runner: applies a fixed list of one-line source mutations to a COPY of the repo (the working tree is never touched),
// runs the relevant test files against each, and prints killed/survived counts. A mutation is killed when its tests fail or time out.
// The mutants run in parallel, one repository copy per worker (scripts/mutate-pool.ts); the report lists survivors in mutant order.
// Usage: node scripts/mutate.ts [--list] [--jobs N] (default: min(available cores, 4)).
// Exit 0 when all mutants are killed, 1 when any survived, 2 on a stale mutation, a red baseline or a bad --jobs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pool, parseJobs } from './mutate-pool.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const M = 'test/merge.test.ts', MR = 'test/merge-reference.test.ts', ST = 'test/stale.test.ts', OI = 'test/openitems.test.ts';
const SAN = ['test/sanitize.test.ts', 'test/security.test.ts', 'test/security-final.test.ts'];
const DB = ['test/build-extra.test.ts', 'test/cli-core.test.ts', 'test/security-final.test.ts'];
// [file, exact text (must occur exactly once), replacement, test files]
/** @type {Array<[string, string, string, string[]]>} */
const MUTATIONS: Array<[string, string, string, string[]]> = [
  ['lib/merge.ts', 'return { v: o === undefined ? t : o };', 'return { v: o };', [MR]],
  ['lib/merge.ts', 'if (so === sb) return { v: t };', 'if (so === sb) return { v: o };', [M, MR]],
  ['lib/merge.ts', 'if (st === sb) return { v: o };', 'if (st === sb) return { v: t };', [M, MR]],
  ['lib/merge.ts', '(!O.has(k) || !T.has(k))', '(!O.has(k) && !T.has(k))', [M, MR]],
  ['lib/merge.ts', 'else if (!o.lines.length) clash(', 'else if (o.lines.length) clash(', [M, MR]],
  ['lib/merge.ts', 'lines.length > 1 && !same(lines, b.lines)', 'lines.length > 9 && !same(lines, b.lines)', [M, MR]],
  ['lib/store.ts', 'if (isSet) items = [...new Set(items)].sort();', 'if (isSet) items = [...new Set(items)];', ['test/store.test.ts', M, MR]],
  ['lib/store.ts', 'if (out[out.length - 1] !== line)', 'if (out[out.length - 1] === line)', ['test/store.test.ts']],
  ['lib/store.ts', ".join('\\x00');\nexport const showKey", ".join('|');\nexport const showKey", ['test/store.test.ts', M]],
  ['lib/store.ts', 'const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);', 'const keys = Object.keys(obj);', ['test/store.test.ts']],
  ['lib/whatif.ts', '!Number.isInteger(sprint) || sprint < first ||', '!Number.isInteger(sprint) || sprint <= first ||', ['test/whatif.test.ts']],
  ['lib/whatif.ts', '    if (sprint < need) reasons.push', '    if (sprint <= need) reasons.push', ['test/whatif.test.ts']],
  ['lib/whatif.ts', 'if (cc.sprint < need) reasons.push', 'if (cc.sprint <= need) reasons.push', ['test/whatif.test.ts']],
  ['lib/whatif.ts', '|| 0) + sp <= cap) { alt = s; break; }', '|| 0) + sp < cap) { alt = s; break; }', ['test/whatif.test.ts']],
  ['lib/verify.ts', 'if (pc.sprint < need) add(', 'if (pc.sprint <= need) add(', ['test/verify.test.ts']],
  ['lib/verify.ts', 'if (v > cap && withFree', 'if (v >= cap && withFree', ['test/verify.test.ts']],
  ['lib/verify.ts', 'if (v > cap && withFree.has(', 'if (v > cap && !withFree.has(', ['test/frozen-history.test.ts']],
  ['lib/frozen.ts', 'export const linkBinds = (model: Model, frozen: (k: string) => boolean, c: string, p: string): boolean => !isClosed(model, p) && ', 'export const linkBinds = (model: Model, frozen: (k: string) => boolean, c: string, p: string): boolean => ', ['test/frozen-history.test.ts']],
  ['lib/frozen.ts', '&& !(frozen(c) && frozen(p));', ';', ['test/frozen-history.test.ts']],
  ['lib/verify.ts', 'if (v < min) add(', 'if (v <= min) add(', ['test/verify.test.ts']],
  ['lib/verify.ts', 'pp.sprint + (pp.owner !== pc.owner ? 1 : 0)', 'pp.sprint + (pp.owner === pc.owner ? 1 : 0)', ['test/verify.test.ts']],
  ['lib/verify.ts', " && !isSpKey(k)) add('UNPLACED'", ") add('UNPLACED'", ['test/verify.test.ts']],
  ['lib/verify.ts', 'if (cn === 1) {', 'if (cn === 2) {', ['test/verify.test.ts']],
  ['lib/verify.ts', 'if (p && p.sprint < first && !frozen(k))', 'if (p && p.sprint <= first && !frozen(k))', ['test/verify.test.ts']],
  ['lib/verify.ts', 'if (!p || p.owner !== f.owner || p.sprint !== f.sprint)', 'if (!p || p.owner !== f.owner && p.sprint !== f.sprint)', ['test/verify.test.ts']],
  ['lib/frozen.ts', "new Set(['Done', ...strs(config?.closed_statuses)])", 'new Set([...strs(config?.closed_statuses)])', ['test/verify.test.ts', 'test/frozen-history.test.ts']],
  ['lib/stale.ts', ".replace(/\\r\\n?/g, '\\n')", ".replace(/\\r\\n/g, '\\n')", [ST]],
  ['lib/stale.ts', 'if (fp.jira_updated != null && fp.jira_updated', 'if (fp.jira_updated', [ST]],
  ['lib/openitems.ts', 'due - lead <= currentSprint', 'due - lead < currentSprint', [OI]],
  ['lib/openitems.ts', 'late: due < currentSprint', 'late: due <= currentSprint', [OI]],
  ['lib/openitems.ts', "(o.status === 'done' && !pruneClosed)", "(o.status === 'done')", [OI]],
  ['lib/sanitize.ts', ".replace(/[<>]/g, '?')", ".replace(/[<]/g, '?')", SAN],
  ['lib/sanitize.ts', '.slice(0, 8) !== m[1]) continue;', '.slice(0, 8) !== m[1] && false) continue;', SAN],
  ['src/db.ts', '\\0-\\0`); continue; }', '\\0\\x30\\0\\0`); continue; }', DB], // a missing source file hashes like an empty one
  ['src/db.ts', "if (h.stale) h.exec('PRAGMA query_only = ON');", 'if (h.stale) { /* query_only left off */ }', DB],
  ['src/db.ts', 'info.some((c) => c.hidden !== 0) || ', '', DB],
  ['src/db.ts', 'if (old || dead) fs.rmSync', 'if (old && dead) fs.rmSync', DB],
  ['lib/gitsafe.ts', 'if (variable > 1) throw', 'if (variable > 9) throw', ['test/gitsafe.test.ts']], // two variable # runs: backtracking
  // deliberately quadratic, output-identical mutants: killed by the deterministic size-axis work counts (test/helpers/perf.ts workScaling,
  // n vs 4n, no clock), so the kill does not depend on the machine; the wall-clock timing checks in the same files time the whole path too
  ['lib/gitsafe.ts', 'nextIndex: (/** @type {string} */ text) => text.search(prefix),', "nextIndex: (/** @type {string} */ text) => { let k = 0; for (let i = 0; i < text.length; i++) k += text.indexOf('\\0', i) >>> 31; return k >= 0 ? text.search(prefix) : -1; },", ['test/gitsafe.test.ts']],
  ['lib/render.ts', 'vc.set(v, (vc.get(v) || 0) + 1); }', "vc.set(v, [...model.tickets.values()].filter((u) => String(u.verdict || 'unrated').slice(0, 20) === String(t.verdict || 'unrated').slice(0, 20)).length); }", ['test/hook.test.ts']],
  ['lib/store.ts', "text.split('\\n').some((l) => l.trim() ===", "text.split('\\n').some((l, i, a) => a.slice(0, i).join('\\n').length >= 0 && l.trim() ===", ['test/driver-wiring.test.ts']],
  // endless lock loops (the counter, the retry guard, the steal result, a held guard): killed by an attempt count, not by this runner's timeout
  ['lib/store.ts', '/* gone */ }\n    return false;', '/* gone */ }\n    return true;', ['test/lock-bound.test.ts']],
  ['lib/store.ts', 'for (let i = 0; ; i++) {', 'for (let i = 0; ; i--) {', ['test/lock-bound.test.ts']],
  ['lib/store.ts', 'if (stealStale(lockPath, staleMs, onStealDecision)) continue;', 'if (!stealStale(lockPath, staleMs, onStealDecision)) continue;', ['test/lock-bound.test.ts']],
  ['lib/store.ts', '      if (i >= retries) throw locked();\n      sleepMs(waitMs);', '      sleepMs(waitMs);', ['test/lock-bound.test.ts']],
  // limitations wave: index content digest, swap races, 0-SP capacity, stale driver target
  ['src/db.ts', 'if (got !== want) throw new PlangraphError', 'if (got !== want && false) throw new PlangraphError', ['test/index-integrity.test.ts']],
  ['lib/jsonl.ts', 'if (pre && (st.dev !== pre.dev || st.ino !== pre.ino || st.ctimeMs !== pre.ctimeMs)) throw', 'if (false) throw', ['test/toctou-race.test.ts']],
  ['lib/jsonl.ts', 'st.ino !== pre.ino || st.ctimeMs !== pre.ctimeMs)) throw', 'st.ino !== pre.ino)) throw', ['test/toctou-race.test.ts']],
  ['src/db.ts', 'mine = fs.fstatSync(tfd); }', 'mine = fs.fstatSync(tfd); fs.closeSync(tfd); }', ['test/toctou-race.test.ts']],
  ['lib/fsafe.ts', "    if (!same(f.lstatSync(tmp), mine)) throw swapped('the temp file');", '', ['test/toctou-race.test.ts']],
  ['lib/whatif.ts', 'if (na > cap && na > nb) {', 'if (na > cap) {', ['test/whatif-zero-sp.test.ts']],
  ['lib/store.ts', 'else if (expected && !sameFile(t, expected))', 'else if (false && expected && !sameFile(t, expected))', ['test/driver-stale.test.ts']],
  // fix wave B: each one killed by the test that came with its fix
  ['src/cli.ts', '.slice(0, MAX_NEXT) }; }', '.slice(0, 9) }; }', ['test/cli-core.test.ts']],
  ['src/cli.ts', "  const all = text ? text.split('\\n') : [];", "  if (!text) return ''; const all = text.split('\\n');", ['test/json-envelope.test.ts']],
  ['lib/verify.ts', 'const spanOk = maxS - first <= MAX_SPAN;', 'const spanOk = maxS - first <= MAX_SPAN + 1;', ['test/verify.test.ts']],
  ['lib/verify.ts', 'if (!spanOk && checked.length) add(', 'if (!spanOk) add(', ['test/verify.test.ts']],
  ['lib/model.ts', "if ((e as Coded).code === 'SYMLINK') throw fail('is a symlink', 'SYMLINK');", '', ['test/config-read.test.ts']],
  ['lib/report.ts', 'over: c.sp > capOf(model.config, c.owner)', 'over: c.sp >= capOf(model.config, c.owner)', ['test/report.test.ts']],
  ['lib/report.ts', '(d === depth.get(v) && cmp(u, prev.get(v)) < 0)', '(d === depth.get(v) && cmp(u, prev.get(v)) > 0)', ['test/report.test.ts']],
  ['lib/ready.ts', '  if (done) return { found: true, ready: false, done, reasons: [] };', '', ['test/ready.test.ts', 'test/report.test.ts']],
  // bulk ready (`plangraph ready --person/--sprint`): the scope filter, the verdict group, the cap marker and the exit code
  ['lib/ready.ts', '(owner === undefined || s.owner === owner)', '(owner === undefined || s.owner !== undefined)', ['test/ready-bulk.test.ts', 'test/assure.test.ts']],
  ['lib/ready.ts', "    if (r.reasons.some((x) => x.code === 'VERDICT')) verdict.push(key);", '', ['test/ready-bulk.test.ts', 'test/assure.test.ts']],
  ['src/commands/queries.ts', '`${ks.slice(0, n).map(', '`${ks.slice(0).map(', ['test/ready-bulk.test.ts']],
  ['src/commands/queries.ts', '  return s.ready.length ? 0 : 1;', '  return 0;', ['test/ready-bulk.test.ts']],
  // whatif --relieve: the choice rule, the links inside the cell, both capacity checks, frozen tickets, the budget, the apply order, the CLI
  ['lib/whatif.ts', 'if (x.slip !== y.slip) return x.slip < y.slip;', 'if (x.slip !== y.slip) return x.slip > y.slip;', ['test/whatif-relieve.test.ts', 'test/assure.test.ts']],
  ['lib/whatif.ts', 'if (x.oc !== y.oc) return x.oc < y.oc;', 'if (x.oc !== y.oc) return x.oc > y.oc;', ['test/whatif-relieve.test.ts']],
  ['lib/whatif.ts', 'if (pp && pc && !okLink(pp, pc)) { ok = false; break; }', '', ['test/whatif-relieve.test.ts', 'test/assure.test.ts']],
  ['lib/whatif.ts', '        if (cur > capOf(cfg, to.owner)) continue;', '', ['test/whatif-relieve.test.ts', 'test/assure.test.ts']],
  ['lib/whatif.ts', '      if ((loads.get(cellKey(to.owner, to.sprint)) || 0) + sp > capOf(cfg, to.owner)) continue;', '', ['test/whatif-relieve.test.ts', 'test/golden.test.ts']],
  ['lib/frozen.ts', 'if (closed.has(st) || fst.has(st)) return true;', 'if (closed.has(st)) return true;', ['test/frozen.test.ts', 'test/whatif-relieve.test.ts']],
  ['lib/whatif.ts', 'budget = opts.budget ?? RELIEVE_BUDGET;', 'budget = Infinity;', ['test/whatif-relieve.test.ts']],
  ['lib/whatif.ts', 'rest.findIndex((m) => whatif(', 'rest.findIndex((m) => true || whatif(', ['test/whatif-relieve.test.ts', 'test/assure.test.ts']],
  ['src/commands/plan.ts', "  return r.status === 'no_relief' ? 1 : 0;", '  return 0;', ['test/whatif-relieve.test.ts']],
  ['src/commands/plan.ts', "if (v.to !== undefined || v['apply-plan'] || v.write) throw usage(", "if (false) throw usage(", ['test/whatif-relieve.test.ts']],
];

if (process.argv.includes('--list')) { for (const [f, a, b] of MUTATIONS) console.log(`${f}: ${a} -> ${b}`); process.exit(0); }
let jobs = 1;
try { jobs = parseJobs(process.argv, Math.min(os.availableParallelism(), 4)); } catch (e) { console.error(String((e as Error).message)); process.exit(2); } // as Error: whatever parseJobs threw

/** Run `node --test files` in `cwd`; resolves the exit code (null on a signal, a spawn error or the 180 s timeout: all count as a failure).
 * @param {string} cwd @param {string[]} files @returns {Promise<number | null>} */
const runTests = (cwd: string, files: string[]) => new Promise<number | null>((resolve) => {
  const c = spawn(process.execPath, ['--test', ...files], { cwd, stdio: 'ignore', timeout: 180000 });
  c.on('error', () => resolve(null));
  c.on('close', (code) => resolve(code));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-mutate-'));
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
