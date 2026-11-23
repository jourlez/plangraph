// Tiny mutation runner: applies a fixed list of one-line source mutations to a COPY of the repo (the working tree is never touched),
// runs the relevant test files against each, and prints killed/survived counts. A mutation is killed when its tests fail or time out.
// Usage: node scripts/mutate.mjs [--list]. Exit 0 when all mutants are killed, 1 when any survived, 2 on a stale mutation or a red baseline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  ['lib/jsonl.mjs', 'if (pre && (st.dev !== pre.dev || st.ino !== pre.ino)) throw', 'if (false) throw', ['test/toctou-race.test.mjs']],
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
];

if (process.argv.includes('--list')) { for (const [f, a, b] of MUTATIONS) console.log(`${f}: ${a} -> ${b}`); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mutate-'));
const work = path.join(tmp, 'repo');
try {
  fs.cpSync(ROOT, work, { recursive: true, filter: (s) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(path.relative(ROOT, s)) });
  const runTests = (files) => spawnSync(process.execPath, ['--test', ...files], { cwd: work, encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 24 });
  const base = runTests([...new Set(MUTATIONS.flatMap((m) => m[3]))]);
  if (base.status !== 0) { console.error('baseline is red: refusing to mutate'); process.exitCode = 2; }
  else {
    let killed = 0; const survived = [];
    for (const [file, from, to, tests] of MUTATIONS) {
      const p = path.join(work, file), orig = fs.readFileSync(p, 'utf8');
      if (orig.split(from).length !== 2) { console.error(`stale mutation (not exactly one match): ${file}: ${from}`); process.exitCode = 2; break; }
      fs.writeFileSync(p, orig.replace(from, () => to));
      const r = runTests(tests);
      fs.writeFileSync(p, orig);
      if (r.status !== 0) killed++; else survived.push(`${file}: ${from}`);
    }
    if (process.exitCode !== 2) {
      console.log(`mutants ${MUTATIONS.length}, killed ${killed}, survived ${survived.length}`);
      for (const s of survived) console.log(`SURVIVED ${s}`);
      process.exitCode = survived.length ? 1 : 0;
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
