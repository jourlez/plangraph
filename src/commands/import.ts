// plangraph import --sys S FILE... [--tenant ALIAS] [--ledger FILE]: turn data another tool saved to a file (a Jira issue export, a superpowers plan,
// a plangraph-ext-batch@1 batch) into observations in the uncommitted cache <dir>/cache/<S>.jsonl (git-ignored, mode 0600). No network, no
// credentials. An observation is advisory: this command never writes tickets, edges, schedule or any other plan file, and never prints text
// from the input. Re-importing the same input gives the same cache bytes (the `seen` day aside).
import fs from 'node:fs';
import path from 'node:path';
import { readCapped, parseJsonl } from '../../lib/jsonl.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { isoDay } from '../../lib/clock.ts';
import { assertInside, writeAtomicSafe } from '../../lib/fsafe.ts';
import { canonFile } from '../../lib/store.ts';
import { dataError, needBrain, precheckTargets, readJsonInput, refuseWrite, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';
import type { Observation, ObsRow } from '../../lib/graph/provider.ts';

const IGNORE = 'cache/'; // the plan dir's .gitignore line that keeps every observation out of git

const keyOf = (o: { sys: string; xid: string }): string => `${o.sys}\0${o.xid}`;
const rowKey = (r: Record<string, unknown>): string => `${String(r.sys)}\0${String(r.xid)}`;
const oneError = (e: unknown): string => oneLine(String((e as { message?: unknown } | null)?.message ?? e).split('\n')[0], 300);

/** Append the cache line to the plan dir's .gitignore (created when missing); every user line stays byte for byte. */
function ignoreCache(ctx: Ctx): void {
  const gi = path.join(ctx.dir, '.gitignore');
  precheckTargets(ctx, [gi]);
  let old: string | null = null; try { old = readCapped(gi, 1024 * 1024); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw dataError('cannot read the plan directory .gitignore'); }
  if (old !== null && old.split(/\r?\n/).some((l) => l.trim() === IGNORE || l.trim() === '/cache/' || l.trim() === 'cache')) return;
  const eol = old?.includes('\r\n') ? '\r\n' : '\n';
  const next = old === null ? `${IGNORE}\n` : `${old}${old === '' || old.endsWith('\n') ? '' : eol}${IGNORE}${eol}`;
  try { writeAtomicSafe(gi, next, { root: ctx.root }); } catch (e) { refuseWrite(e); }
}

async function importCmd(ctx: Ctx, args: Args<{ sys?: string; tenant?: string; ledger?: string }>): Promise<number> {
  const { providerOf, MAX_INPUT_BYTES, MAX_OBSERVATIONS, CACHE_FILES, OBS_COLUMNS, obsProblem } = await import('../../lib/graph/provider.ts');
  const v = args.values, files = args.positionals;
  if (!v.sys || !files.length) throw usage('usage: plangraph import --sys jira|sp|generic|github FILE... [--tenant ALIAS] [--ledger FILE]');
  const provider = providerOf(v.sys);
  if (!provider) throw usage(`unknown provider ${oneLine(v.sys, 40)}; known: generic, github, jira, sp`);
  if (v.ledger !== undefined && (v.sys !== 'sp' || files.length !== 1)) throw usage('--ledger goes with --sys sp and exactly one plan file');
  needBrain(ctx);
  const cfgTenant = (ctx.config() as { jira?: { tenant?: unknown } }).jira?.tenant;
  const tenant = v.tenant ?? (typeof cfgTenant === 'string' ? cfgTenant : '');
  const day = isoDay(ctx.now()), cache = path.join(ctx.dir, 'cache'), file = path.join(cache, `${v.sys}.jsonl`);
  if (!CACHE_FILES.includes(`cache/${v.sys}.jsonl`)) throw usage('no cache file for this provider'); // CACHE_FILES and PROVIDERS list the same names (a test pins it)

  // what the cache holds now, keyed sys+xid (an unreadable or hand-damaged cache is a data error: delete the file and import again)
  const old = new Map<string, Record<string, unknown>>();
  try {
    const text = fs.existsSync(file) ? readCapped(file, 64 * 1024 * 1024, { follow: false }) : '';
    for (const r of parseJsonl(text, `cache/${v.sys}.jsonl`, { validate: obsProblem })) old.set(rowKey(r), r);
  } catch (e) { throw dataError(`cache/${v.sys}.jsonl: ${oneError(e)}`, 'delete the cache file and import again'); }
  const prev = new Map<string, Observation>([...old].map(([k, r]) => [k, r as unknown as Observation]));

  const fresh = new Map<string, ObsRow>(); let dropped = 0; const warnings: string[] = [];
  for (const f of files) {
    const shown = oneLine(path.basename(String(f)), 80);
    let input: unknown;
    if (provider.input === 'json') input = readJsonInput(f, 'input file', MAX_INPUT_BYTES);
    else {
      let planText: string, ledgerText: string | undefined;
      try {
        planText = readCapped(path.resolve(ctx.cwd ?? process.cwd(), f), MAX_INPUT_BYTES);
        if (v.ledger !== undefined) ledgerText = readCapped(path.resolve(ctx.cwd ?? process.cwd(), v.ledger), MAX_INPUT_BYTES);
      } catch { throw dataError(`cannot read input file ${shown}`, 'check the path'); }
      const abs = path.resolve(ctx.cwd ?? process.cwd(), f), inside = (() => { try { assertInside(ctx.root, abs); return true; } catch { return false; } })();
      input = { name: inside ? path.relative(fs.realpathSync.native(ctx.root), fs.realpathSync.native(abs)).split(path.sep).join('/') : path.basename(abs), text: planText, ...(ledgerText !== undefined ? { ledger: ledgerText } : {}) };
    }
    let batch: ReturnType<typeof provider.normalize>;
    try { batch = provider.normalize(input, { tenant, now: day, prev }); } catch (e) { throw dataError(`${shown}: ${oneError(e)}`); }
    dropped += batch.dropped;
    for (const w of batch.warnings) warnings.push(w);
    for (const o of batch.observations) fresh.set(keyOf(o), { ...o, seen: day });
    if (fresh.size > MAX_OBSERVATIONS) throw dataError(`more than ${MAX_OBSERVATIONS} observations`);
  }
  if (!fresh.size) throw dataError(`no observation could be read from the input (${dropped} dropped)`);
  for (const w of warnings.slice(0, 20)) ctx.io.err(`warning: ${oneLine(w, 160)}`);

  const merged = new Map<string, Record<string, unknown>>(old);
  for (const [k, r] of fresh) merged.set(k, r as unknown as Record<string, unknown>);
  if (merged.size > MAX_OBSERVATIONS) throw dataError(`the cache would hold more than ${MAX_OBSERVATIONS} observations`, 'delete the cache file and import again');
  const body = canonFile([...merged.values()], { order: [...OBS_COLUMNS], id: rowKey });

  // the ignore line first: there is never a moment when the cache exists and git would pick it up
  ignoreCache(ctx);
  precheckTargets(ctx, [file]);
  try { const st = fs.lstatSync(cache); if (!st.isDirectory()) throw new Error('not a directory'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw dataError('the cache path is not a directory'); fs.mkdirSync(cache, { mode: 0o700 }); }
  try { writeAtomicSafe(file, body, { root: ctx.root, mode: 0o600 }); } catch (e) { refuseWrite(e); }

  const changed = [...fresh].filter(([k, r]) => old.get(k)?.fp !== r.fp).length;
  ctx.io.out(`imported ${fresh.size} observation(s) from ${files.length} file(s) into cache/${v.sys}.jsonl (changed ${changed}, dropped ${dropped}); cache now ${merged.size}`);
  ctx.io.data?.({ sys: v.sys, imported: fresh.size, changed, dropped, cache: merged.size }, { next: [] });
  return 0;
}

const S = { type: 'string' };
export const commands: CommandMap = {
  import: {
    run: importCmd as never, positionals: [0, Infinity], writes: 'text', guard: 'soft',
    options: { sys: S, tenant: S, ledger: S },
    summary: '--sys jira|sp|generic|github FILE... [--tenant ALIAS] [--ledger FILE]: saved tool output to observations in the git-ignored cache (advisory; never writes plan files)',
  },
};
