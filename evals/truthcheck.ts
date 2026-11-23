// Independent check of generated ground truth against the real `brain` CLI (a different code path: SQLite index, command wiring),
// on a workspace built by the case's own generated scaffold.sh (so the scaffold and the overlay are tested too). Zero model calls.
// checkTruth(cases, { evalDir, tmp }) -> { checked: [ids], unchecked: [ids], mismatches: [{id, what}] }. Messages name the case and the
// field, never data values (real-project text must not leak into logs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { EvalCase, TruthArgs, TruthValue } from './schema.ts';

export interface TruthCheck { checked: string[]; unchecked: string[]; mismatches: Array<{ id: string; what: string }> }
// the JSON a `brain ... --json` command prints under `data`; each case reads only the fields it names
interface BrainData { lines?: string[]; found?: boolean; ready?: boolean; ok?: boolean; more?: unknown; reasons: Array<{ code: string; kind: string; key: string; detail?: string; warn?: boolean }>; violations?: Array<{ code: string; key: string }> }

const sortS = (a: Iterable<string>) => [...a].sort();
const same = (a: Iterable<string>, b: Iterable<string>) => JSON.stringify(sortS(a)) === JSON.stringify(sortS(b));

function scaffold(evalDir: string, c: EvalCase, tmp: string): { ws: string; error?: string } {
  const ws = fs.mkdtempSync(path.join(tmp, 'tc-'));
  const r = spawnSync('bash', [path.join(evalDir, c.id, 'scaffold.sh')], { cwd: ws, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp } });
  if (r.status !== 0) return { ws, error: 'scaffold failed' };
  return { ws };
}

export function checkTruth(cases: EvalCase[], { evalDir, tmp }: { evalDir: string; tmp: string }): TruthCheck {
  const brainBin = path.join(evalDir, '..', 'bin', 'brain');
  const out: TruthCheck = { checked: [], unchecked: [], mismatches: [] };
  for (const c of cases) {
    const t = c.truth;
    if (!t) { out.unchecked.push(c.id); continue; }
    const bad = (what: string) => out.mismatches.push({ id: c.id, what });
    const sc = scaffold(evalDir, c, tmp);
    if (sc.error) { bad(sc.error); continue; }
    // a private plugin data directory under the temp root: bin/brain's compile cache never goes to the real HOME
    const run = (...a: string[]) => spawnSync(process.execPath, [brainBin, ...a], { cwd: sc.ws, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'plugin-data') } });
    const json = (...a: string[]): BrainData | null => { const r = run(...a, '--json'); try { return JSON.parse(r.stdout).data; } catch { return null; } };
    const lines = (...a: string[]) => (json(...a)?.lines) || [];
    const v = t.value as Required<TruthValue>, a = t.args as Required<TruthArgs>; // the generator sets the fields each derive reads (evals/families.ts)
    let handled = true;
    const readyOf = (k: string, extra: string[] = []) => { const d = json('ready', k, ...extra); return d ? { ready: d.ready, kinds: d.reasons.filter((x) => x.code === 'OPEN_ITEM').map((x) => x.kind), waits: d.reasons.filter((x) => x.code === 'WAITS').map((x) => x.key), verdict: (d.reasons.find((x) => x.code === 'VERDICT') || {}).detail || 'READY' } : null; };
    switch (t.derive) {
      case 'lookup': {
        if (v.found === false) { const d = json('ready', a.key); if (!d || d.found !== false) bad('found'); break; }
        if (v.owner === undefined) { handled = false; break; }
        const l = lines('ticket', a.key)[0] || '';
        if (!new RegExp(`plan S${v.sprint} ${String(v.owner).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\||<\\/untrusted>)`).test(l)) bad('owner/sprint'); // the status/verdict/owner group sits inside one inline fence since wave B
        break;
      }
      case 'ready': {
        const r = readyOf(a.key); if (!r) { bad('ready output'); break; }
        if (r.ready !== v.ok) bad('ok');
        if (v.findings && !same(r.kinds, v.findings)) bad('findings');
        if (v.unfinished && !same(r.waits, v.unfinished)) bad('unfinished');
        if (v.verdict && r.verdict !== v.verdict) bad('verdict');
        break;
      }
      case 'blockers-of': { const r = readyOf(a.key); if (!r || !same(r.waits, v.blockers)) bad('blockers'); break; }
      case 'readySet': {
        const sched = fs.readFileSync(path.join(sc.ws, c.fixture.size === 'R' ? (fs.readFileSync(path.join(sc.ws, '.brainrc'), 'utf8').match(/"dir":"([^"]+)"/) as RegExpMatchArray)[1] : '.brain', 'schedule.jsonl'), 'utf8'); // as RegExpMatchArray: the scaffold wrote .brainrc with a "dir"
        const cell = sched.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => (r.version ?? 'current') === 'current' && r.owner === a.owner && r.sprint === a.sprint).map((r) => r.key);
        const got = cell.filter((k) => readyOf(k)?.ready === true);
        if (!same(got, v.ready)) bad('ready set');
        break;
      }
      case 'whatif': {
        const d = json('whatif', a.key, '--to', a.to, '--sprint', String(a.sprint));
        if (!d) { bad('whatif output'); break; }
        if (d.ok !== v.ok) bad('ok');
        if (!same([...new Set(d.reasons.filter((x) => !x.warn).map((x) => x.code))], v.codes)) bad('codes');
        if (d.more) bad('reasons truncated');
        break;
      }
      case 'proposeMove': {
        const txt = run('whatif', a.key, '--to', a.to, '--sprint', String(a.sprint), '--apply-plan').stdout;
        const moved = txt.split('\n').filter((l) => l.includes(' > ')).map((l) => l.split(' ')[0]).filter((k) => k !== a.key);
        if (!same(moved, v.moved)) bad('moved');
        break;
      }
      case 'computeStale': {
        const l = run('stale', '--ref', 'HEAD', '--list').stdout.split('\n');
        const st = l.filter((x) => /^\S+: /.test(x) && !x.startsWith('stale vs')).map((x) => x.split(':')[0]);
        if (!same(st, v.stale as string[])) bad('stale'); // as string[]: a stale case carries the list (the count form has no stale list)
        if (v.edited && !same(l.filter((x) => /: plan(?:,|$| via)/.test(x)).map((x) => x.split(':')[0]), v.edited)) bad('edited');
        break;
      }
      case 'chain': { const l = lines('chain', a.key)[0] || ''; if (!l.startsWith(`longest chain behind ${a.key}: ${v.hops} hops`)) bad('hops'); break; }
      case 'verifyPlan': {
        const d = json('verify');
        const cap = (d?.violations || []).filter((x) => x.code === 'CAPACITY');
        if (a.valid) { // reassign-safe: every slot whatif accepts is exactly the valid set
          for (const s of a.valid) { const w = json('whatif', a.key, '--to', s.to, '--sprint', String(s.sprint)); if (!w || !w.ok) { bad('a valid slot is refused by whatif'); break; } }
          break;
        }
        if (v.over && a.person === undefined) { if (!same(cap.map((x) => x.key), v.over)) bad('over'); if (v.count !== cap.length) bad('count'); }
        else if (v.over) { if (!same(cap.filter((x) => x.key.startsWith(a.person + ' S')).map((x) => x.key), v.over)) bad('over'); }
        else handled = false;
        break;
      }
      case 'blockers': {
        const l = lines('blockers');
        if (!(l[0] || '').startsWith(`${v.count} tickets not READY`)) bad('count');
        if (v.not_ready) { const ks = l.slice(1).flatMap((x) => x.replace(/^[^:]*:\s*/, '').split(/\s+/)).filter(Boolean); if (!same(ks, v.not_ready as string[])) bad('keys'); } // as string[]: the listing form carries not_ready
        break;
      }
      case 'blockers+verifyPlan': {
        const l = lines('blockers'); const n = Number(/^(\d+) tickets not READY/.exec(l[0] || '')?.[1] ?? (l.length ? Number.NaN : 0));
        if (!(n === v.not_ready || (Number.isNaN(n) && v.not_ready === 0))) bad('not_ready');
        if ((json('verify')?.violations || []).filter((x) => x.code === 'CAPACITY').length !== v.over_capacity) bad('over_capacity');
        break;
      }
      case 'readySet+jira': {
        for (const k of v.newly_ready) { if (readyOf(k, ['--jira', 'jira-snapshot.json'])?.ready !== true) bad('newly ready with snapshot'); if (readyOf(k)?.ready !== false) bad('newly ready was already ready'); }
        const snap = JSON.parse(fs.readFileSync(path.join(sc.ws, 'jira-snapshot.json'), 'utf8'));
        const changed = Object.keys(snap).filter((k) => !(lines('ticket', k)[0] || '').includes(`Jira ${snap[k].status} |`));
        if (!same(changed, v.changed)) bad('changed');
        break;
      }
      case 'forecast': { const l = lines('forecast')[0] || ''; if (!l.startsWith(`FORECAST [${v.state} `)) bad('state'); break; }
      default: handled = false;
    }
    (handled ? out.checked : out.unchecked).push(c.id);
    fs.rmSync(sc.ws, { recursive: true, force: true });
  }
  return out;
}
