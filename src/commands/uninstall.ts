// plangraph uninstall [--yes]: undo what `init`, `githooks-install` and `docs-build` added to a repository, and nothing else.
// Removed: the .githooks scripts that still equal the template plangraph wrote (a script you edited is kept), the .gitignore lines plangraph
// wrote (plan directory and repository root), and, only after confirmation (--yes, or a typed y on a terminal), the local derived files: the
// observation cache `cache/`, the index `plangraph.sqlite*` and the staging directory `.txn/`. The ignore lines of a derived file that is
// still there stay, so the tree does not turn dirty. Never touched: nodes/, events/, runs/, schedules/, meta.jsonl, config.json, format.json,
// history, the generated documents and any file you wrote. Every line printed is a fixed word plus a repository-relative path.
import fs from 'node:fs';
import path from 'node:path';
import { readCapped } from '../../lib/jsonl.ts';
import { precheckTargets, refuseWrite, writeState, rel } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const TEMPLATES = path.resolve(import.meta.dirname, '../../templates/githooks');
const HOOKS = ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite', 'pre-commit'];
const HOOKS_DIR = '.githooks';
// The lines init writes into the plan directory's .gitignore (src/commands/plan.ts IGNORE_LINES), by the derived thing each one hides.
const DERIVED: ReadonlyArray<{ line: string; names: readonly string[] }> = [
  { line: 'cache/', names: ['cache'] }, { line: 'plangraph.sqlite*', names: ['plangraph.sqlite', 'plangraph.sqlite-journal', 'plangraph.sqlite-wal', 'plangraph.sqlite-shm'] }, { line: '.txn/', names: ['.txn'] },
];
const KEPT = ['nodes/', 'events/', 'runs/', 'schedules/', 'config.json', 'format.json'];

const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
const text = (p: string): string | null => { try { return readCapped(p, 1024 * 1024); } catch { return null; } };

/** `old` without the lines of `drop` (compared after trimming); null when nothing was left but blank lines. Other lines and the line ending stay as they were. */
function withoutLines(old: string, drop: ReadonlySet<string>): string | null {
  const eol = old.includes('\r\n') ? '\r\n' : '\n';
  const keep = old.split(/\r?\n/).filter((l, i, all) => !drop.has(l.trim()) && !(l === '' && i === all.length - 1));
  return keep.every((l) => l.trim() === '') ? null : `${keep.join(eol)}${eol}`;
}
/** Rewrites `file` without the lines of `drop`; the file goes when only blank lines remain. Returns the lines that were really removed. */
function dropIgnoreLines(ctx: Ctx, file: string, drop: ReadonlySet<string>): string[] {
  const old = text(file);
  if (old === null) return [];
  const had = [...drop].filter((d) => old.split(/\r?\n/).some((l) => l.trim() === d));
  if (!had.length) return [];
  precheckTargets(ctx, [file]);
  const next = withoutLines(old, drop);
  if (next === null) { try { fs.rmSync(file); } catch (e) { refuseWrite(e); } } else writeState(ctx, file, next);
  return had;
}

/** The directory the generated documents go to, as an ignore line (the same rule init applies), or null. */
function docsIgnoreLine(ctx: Ctx): string | null {
  const c = ctx.config() as { docs?: { out?: unknown; commit?: unknown } };
  const d = c && typeof c === 'object' && c.docs && typeof c.docs === 'object' ? c.docs : {};
  if (d.commit === true) return null;
  const out = (typeof d.out === 'string' ? d.out : '').replace(/\/+$/, '');
  const p = out === '' ? 'docs/plangraph' : out;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || p === '.' || /[\0\r\n]/.test(p)) return null;
  return `/${p}/`;
}

function confirmed(ctx: Ctx, yes: boolean): boolean {
  if (yes) return true;
  if (!ctx.stdin.isTTY) return false;
  ctx.io.out('remove the local cache and the index? they are rebuilt by plangraph build; type y to confirm, anything else to keep them:');
  let typed = '';
  try { typed = String(ctx.stdin.readTty ? ctx.stdin.readTty(16) : ctx.stdin.readLine ? ctx.stdin.readLine(16) : ctx.stdin.read(16)).trim().toLowerCase(); } catch { return false; }
  return typed === 'y';
}

function uninstall(ctx: Ctx, args: Args<{ yes?: boolean }>): number {
  const say = (l: string): void => ctx.io.out(l);
  // 1. the git hook scripts, only when they are still byte for byte the template
  for (const name of HOOKS) {
    const f = path.join(ctx.root, HOOKS_DIR, name), shown = `${HOOKS_DIR}/${name}`;
    if (!exists(f)) continue;
    const tpl = text(path.join(TEMPLATES, name)), cur = text(f);
    if (tpl === null || cur !== tpl) { say(`kept ${shown} (it differs from the template: yours)`); continue; }
    precheckTargets(ctx, [f]);
    try { fs.rmSync(f); } catch (e) { refuseWrite(e); }
    say(`removed ${shown}`);
  }
  const hd = path.join(ctx.root, HOOKS_DIR);
  try { if (fs.readdirSync(hd).length === 0) { fs.rmdirSync(hd); say(`removed ${HOOKS_DIR}/ (empty)`); } } catch { /* absent or not empty */ }
  const wired = text(path.join(ctx.root, '.git', 'config'));
  if (wired !== null && /^\s*hooksPath\s*=\s*\.githooks\s*$/m.test(wired)) say('note: git config core.hooksPath still points at .githooks; unset it with: git config --unset core.hooksPath');

  // 2. the derived files, after confirmation
  const present = DERIVED.filter((d) => d.names.some((n) => exists(path.join(ctx.dir, n))));
  let removedDerived = false;
  if (present.length) {
    if (confirmed(ctx, Boolean(args.values.yes))) {
      for (const d of present) for (const n of d.names) { const p = path.join(ctx.dir, n); if (exists(p)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { refuseWrite(e); } } }
      say(`removed ${present.map((d) => rel(ctx, path.join(ctx.dir, d.line.replace(/\*$/, '')))).join(', ')}`);
      removedDerived = true;
    } else say(`kept ${present.map((d) => d.line).join(', ')} in ${rel(ctx, ctx.dir)} (pass --yes to remove the local cache and the index)`);
  }

  // 3. the ignore lines plangraph wrote: those of a derived file that is gone, and the generated documents' line when that directory is gone
  const dropHere = new Set(DERIVED.filter((d) => removedDerived || !d.names.some((n) => exists(path.join(ctx.dir, n)))).map((d) => d.line));
  const gone = dropIgnoreLines(ctx, path.join(ctx.dir, '.gitignore'), dropHere);
  if (gone.length) say(`removed ${gone.join(', ')} from ${rel(ctx, path.join(ctx.dir, '.gitignore'))}`);
  const dl = docsIgnoreLine(ctx);
  if (dl !== null && !exists(path.join(ctx.root, dl.slice(1, -1)))) {
    const g = dropIgnoreLines(ctx, path.join(ctx.root, '.gitignore'), new Set([dl]));
    if (g.length) say(`removed ${g.join(', ')} from .gitignore`);
  } else if (dl !== null) say(`kept ${dl} in .gitignore (the generated documents are still there; delete ${dl.slice(1)} yourself)`);

  say(`kept ${KEPT.join(' ')} in ${rel(ctx, ctx.dir)}: your plan data, never deleted here`);
  say('to finish: claude plugin uninstall plangraph@plangraph-marketplace');
  return 0;
}

export const commands: CommandMap = {
  uninstall: {
    run: uninstall as never, positionals: [0, 0], writes: 'file', guard: 'none', options: { yes: { type: 'boolean' } },
    summary: '[--yes]: remove what init and githooks-install added (unmodified .githooks scripts, the .gitignore lines) and, after confirmation, the local cache and index; never deletes nodes/, events/, runs/, schedules/, config.json or format.json',
  },
};
