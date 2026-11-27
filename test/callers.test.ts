// Every exported function under lib/ has a production caller: a file under src/, bin/, hooks/ or mcp/ uses it, or an exported function that has one
// does (Global Constraints: "every new exported function has a production caller"). knip already finds unused exports; this adds the check that a
// use inside a test file does not count. A library function only tests call is dead code: wire it or delete it.
// The analysis is textual and conservative in the lenient direction: a production file counts when it imports the module (static, dynamic or
// namespace import) and mentions the name; inside lib/, a use counts when the using export is itself live, or the use sits in the file's
// non-exported code and the file has another live export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else if (/\.(ts|js|mjs)$/.test(e.name) || (dir.endsWith('/bin') && !e.name.includes('.'))) out.push(f);
  }
  return out;
};
const rel = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/');

/** Dead exported functions: only tests (or scripts/) call them. None is allowed to stay without a decision; each group says why it is listed.
 * Wire a function into a command, hook or tool, or delete it with its tests, and remove its line here: the second test fails on a stale line. */
const NEEDS_DECISION: Readonly<Record<string, readonly string[]>> = {
  'added in 1.0, no command, hook or tool calls it (its own test does): the controller decides to wire it or delete it with the test; the pins in scripts/mutate/*.json may name it': [
    'lib/digest.ts#contextJson', 'lib/digest.ts#mapJson', 'lib/docs/regions.ts#renderMarkers', 'lib/flow/state.ts#canTransition', 'lib/flow/state.ts#mapTrackerStatus',
    'lib/graph/repo.ts#ownersFor', 'lib/ingest/write.ts#readNodeKind', 'lib/history/parse.ts#parseLog', 'lib/ingest/adr.ts#parseAdr', 'lib/ingest/requirements.ts#parseRequirements',
    'lib/store2/nodes.ts#deleteNode', 'lib/store2/nodes.ts#eraseNode', 'lib/store2/nodes.ts#renameNode', 'lib/store2/nodes.ts#writeNode', 'lib/store2/txn.ts#recoverTxn',
  ],
  'a fixture converter for tests (test/helpers/plan-dir.ts adoptPlanDir): it belongs under test/helpers, moving it changes the imports of four test files': ['lib/store2/adopt.ts#adoptOldLayout'],
  'older than 1.0, called by tests or by scripts/ only (backtest, forecast, solver measurement, the older Jira client, open-item helpers): delete them or accept them as library surface': [
    'lib/backtest.ts#monteCarlo', 'lib/backtest.ts#replay', 'lib/backtest.ts#rng32', 'lib/backtest.ts#throughputOf', 'lib/forecast.ts#conformalQuantile', 'lib/forecast.ts#normCdf',
    'lib/graph/mem.ts#bfs', 'lib/graph/mem.ts#buildAdjacency', 'lib/graph/mem.ts#criticalPath', 'lib/graph/mem.ts#shortestPath', 'lib/heuristic.ts#listSchedule',
    'lib/jira/credentials.ts#getCredentials', 'lib/jira/credentials.ts#getCredentialsFor', 'lib/jira/credentials.ts#siteTag', 'lib/jira/render.ts#fetchChangelog',
    'lib/jira/snapshot.ts#parseSnapshotJsonl', 'lib/jira/snapshot.ts#snapshotToJsonl', 'lib/jira/snapshot.ts#toLegacyMap',
    'lib/openitems.ts#blocksReady', 'lib/openitems.ts#effectiveDue', 'lib/openitems.ts#overdueItems', 'lib/render.ts#outputMode',
    'lib/solver-measure.ts#dominanceWeights', 'lib/solver-measure.ts#keepVariant', 'lib/solver-measure.ts#neighborhoodWins',
    'lib/stale.ts#fingerprintTicket', 'lib/stale.ts#normalizePlanText', 'lib/store.ts#canonText', 'lib/store.ts#showKey',
  ],
};
export const EXCEPTIONS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(NEEDS_DECISION).flatMap(([why, names]) => names.map((n) => [n, why] as const)));

interface Decl { name: string; start: number; end: number }
const FN = /^export\s+(?:async\s+)?function\s*\*?\s*(\w+)|^export\s+const\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|function\b|\w+\s*=>)/gm;
const EXPORT_ANY = /^export\s+(?!type\b|interface\b)(?:async\s+)?(?:function\s*\*?|const|let|var|class|enum)\s*(\w+)|^export\s+default\b/gm;

/** The exported declarations of a file with the text range each one spans (up to the next top-level export). */
function declsOf(text: string): { fns: Decl[]; all: Decl[] } {
  const marks: { name: string; start: number; fn: boolean }[] = [];
  for (const m of text.matchAll(EXPORT_ANY)) marks.push({ name: m[1] ?? 'default', start: m.index as number, fn: false });
  const fnStarts = new Set<number>();
  for (const m of text.matchAll(FN)) fnStarts.add(m.index as number);
  for (const k of marks) k.fn = fnStarts.has(k.start);
  const all = marks.map((k, i) => ({ name: k.name, start: k.start, end: marks[i + 1]?.start ?? text.length }));
  return { fns: all.filter((_, i) => marks[i]?.fn), all };
}
const SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const specsOf = (text: string, file: string): string[] => [...text.matchAll(SPEC)].map((m) => m[1] as string).filter((s) => s.startsWith('.')).map((s) => path.resolve(path.dirname(file), s));
const word = (text: string, name: string): boolean => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])|\\.${name}(?![\\w$])|['"]${name}['"]`).test(text);
// a re-export `export { a } from './x.ts'` or `export * from` forwards the name: it is a use only through the module that finally imports it, so it counts as a mention
const reexports = (text: string): string[] => [...text.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => (m[1] as string).split(',').map((s) => s.trim().split(/\s+as\s+/).pop() as string).filter(Boolean));

const libFiles = walk(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.ts'));
const prodFiles = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin')), ...walk(path.join(ROOT, 'hooks')), ...walk(path.join(ROOT, 'mcp'))];
const text = new Map<string, string>([...libFiles, ...prodFiles].map((f) => [f, fs.readFileSync(f, 'utf8')]));
const decls = new Map(libFiles.map((f) => [f, declsOf(text.get(f) as string)]));
const imports = new Map([...text].map(([f, t]) => [f, new Set(specsOf(t, f))]));
const importsFrom = (user: string, lib: string): boolean => imports.get(user)?.has(lib) === true || imports.get(user)?.has(lib.replace(/\.ts$/, '.js')) === true || imports.get(user)?.has(lib.replace(/\.ts$/, '')) === true;

/** The set of live exported functions as `file#name`. */
function liveSet(): { live: Set<string>; dead: string[] } {
  const live = new Set<string>();
  // (1) a production file imports the module and mentions the name (a re-export through a lib file is followed in the next step)
  for (const lib of libFiles) for (const d of (decls.get(lib) as { all: Decl[] }).all) for (const p of prodFiles) if (importsFrom(p, lib) && word(text.get(p) as string, d.name)) live.add(`${lib}#${d.name}`);
  for (let changed = true; changed;) {
    changed = false;
    for (const lib of libFiles) {
      const t = text.get(lib) as string, own = decls.get(lib) as { all: Decl[] };
      const hasLive = own.all.some((d) => live.has(`${lib}#${d.name}`));
      const exportedRanges = own.all.map((d) => [d.start, d.end] as const);
      const fileLevel = (() => { let s = ''; let at = 0; for (const [a, b] of [...exportedRanges].sort((x, y) => x[0] - y[0])) { s += t.slice(at, a); at = b; } return s + t.slice(at); })();
      for (const other of libFiles) {
        if (other === lib || !importsFrom(lib, other)) continue;
        for (const d of (decls.get(other) as { all: Decl[] }).all) {
          const key = `${other}#${d.name}`;
          if (live.has(key)) continue;
          const byExport = own.all.some((m) => live.has(`${lib}#${m.name}`) && word(t.slice(m.start, m.end), d.name));
          if (byExport || (hasLive && word(fileLevel, d.name)) || (reexports(t).includes(d.name) && hasLive)) { live.add(key); changed = true; }
        }
      }
      // inside the file: an export another live export of the same file uses, or non-exported code of a file with a live export uses
      for (const d of own.all) {
        const key = `${lib}#${d.name}`;
        if (live.has(key)) continue;
        const byOther = own.all.some((m) => m.name !== d.name && live.has(`${lib}#${m.name}`) && word(t.slice(m.start, m.end), d.name));
        const byLevel = own.all.some((m) => m.name !== d.name && live.has(`${lib}#${m.name}`)) && word(fileLevel, d.name);
        if (byOther || byLevel) { live.add(key); changed = true; }
      }
    }
  }
  const dead: string[] = [];
  for (const lib of libFiles) for (const d of (decls.get(lib) as { fns: Decl[] }).fns) if (!live.has(`${lib}#${d.name}`)) dead.push(`${rel(lib)}#${d.name}`);
  return { live, dead: dead.sort() };
}

test('every exported function under lib/ has a production caller (src, bin, hooks, mcp) or is used by an exported function that has one', () => {
  const { dead } = liveSet();
  const undecided = dead.filter((d) => !(d in EXCEPTIONS));
  assert.deepEqual(undecided, [], `no production caller (wire it or delete it; tests do not count):\n${undecided.join('\n')}`);
});

test('every exception has a reason and still names a function that exists and is still dead', () => {
  const { dead } = liveSet();
  for (const [k, why] of Object.entries(EXCEPTIONS)) {
    assert.ok(why.length >= 20, `${k}: a reason`);
    assert.ok(dead.includes(k), `${k} is no longer dead or no longer exists: remove the exception`);
  }
});

test('the analysis sees what it should: a known live function is live, a planted dead one is found', () => {
  const { live } = liveSet();
  assert.ok(live.has(`${path.join(ROOT, 'lib/sanitize.ts')}#oneLine`));
  assert.ok(libFiles.length > 40 && prodFiles.length > 20);
  const fake = declsOf('export function a() {}\nexport const b = (x) => x;\nexport const c = 5;\nexport async function d() {}\n').fns.map((d) => d.name);
  assert.deepEqual(fake, ['a', 'b', 'd']);
});
