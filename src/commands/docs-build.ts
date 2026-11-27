// plangraph docs-build [ID...] [--force] [--commit-ready]: write the generated documents. The live copy goes to docs.out (default docs/plangraph/),
// --commit-ready to docs.commit_out (default docs/generated/); both must be inside the repository root (exit 2 otherwise, nothing written).
// A hand edit inside a region is refused and that file left alone (--force overwrites it). A D24 or data-class finding in any document stops the
// whole build with exit 2 and one line per finding (kind and line, never the value); nothing is written.
import { openStore } from '../../lib/planstore.ts';
import { GENERATORS, buildDocs, checkOut } from '../../lib/docs/registry.ts';
import { loadExtras } from '../../lib/docs/extras.ts';
import { realFs } from '../../lib/docs/realfs.ts';
import { oneLine } from '../../lib/sanitize.ts';
import { modelFromDb, needBrain, usage } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

type V = { force?: boolean; 'commit-ready'?: boolean };

function docsBuild(ctx: Ctx, args: Args<V>): number {
  needBrain(ctx);
  const ids = args.positionals;
  const known = new Set(GENERATORS.map((g) => g.id));
  for (const i of ids) if (!known.has(i)) throw usage(`unknown generator ${oneLine(i, 60)}; ids: ${[...known].join(' ')}`);
  const base = ctx.config();
  const docsCfg = (base.docs ?? {}) as Record<string, unknown>;
  const commitOut = typeof docsCfg.commit_out === 'string' && docsCfg.commit_out !== '' ? docsCfg.commit_out : 'docs/generated';
  const cfg = args.values['commit-ready'] ? { ...base, docs: { ...docsCfg, out: commitOut } } : base;
  let out: string;
  try { out = checkOut(cfg); } catch (e) { ctx.io.err(oneLine((e as Error).message, 200)); return 2; }
  const model = modelFromDb(ctx);
  const extras = loadExtras(openStore(ctx) as never);
  const generators = ids.length > 0 ? GENERATORS.filter((g) => ids.includes(g.id)) : GENERATORS;
  let res: ReturnType<typeof buildDocs>;
  try { res = buildDocs(model, cfg, realFs(ctx.root), extras, { generators, ...(args.values.force ? { force: true } : {}) }); } catch (e) {
    if ((e as { code?: string }).code === 'OUT_OUTSIDE_ROOT') { ctx.io.err(oneLine((e as Error).message, 200)); return 2; }
    throw e;
  }
  if (res.violations.length > 0) {
    for (const v of res.violations) ctx.io.err(`${v.code} ${oneLine(v.id, 60)} ${v.kind} at line ${v.line}`);
    return 2;
  }
  for (const r of res.refused) ctx.io.err(`refused ${oneLine(r.path, 120)} ${oneLine(r.id, 60)} ${r.reason}`);
  ctx.io.out(`wrote ${res.written.length} documents to ${oneLine(out, 120)}${res.refused.length > 0 ? `, refused ${res.refused.length} (hand edit: fix the source or pass --force)` : ''}`);
  return res.refused.length > 0 ? 1 : 0;
}

const B = { type: 'boolean' };
export const commands: CommandMap = {
  'docs-build': {
    run: docsBuild as never, positionals: [0, Infinity], writes: 'text', guard: 'strict', options: { force: B, 'commit-ready': B },
    summary: '[ID...] [--force] [--commit-ready]: write the generated documents to docs.out (or docs.commit_out); a hand edit inside a region is refused unless --force',
  },
};
