// plangraph githooks-install [--dry-run] [--pre-commit]: write the git hook scripts of templates/githooks/ into the tracked .githooks/ directory of the
// repository and print how to enable them. It never changes core.hooksPath (or any git config) itself. Every script ends with `exit 0` and runs
// `plangraph refresh --fast --quiet || true`, so a hook never blocks git; the optional pre-commit runs `plangraph check --quiet` and can fail a
// commit, so it is written only with --pre-commit. A script already in .githooks/ that differs from the template is kept and reported (never overwritten).
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomicSafe } from '../../lib/fsafe.ts';
import { precheckTargets, refuseWrite } from './shared.ts';
import type { Ctx, Args } from '../context.ts';
import type { CommandMap } from '../registry.ts';

const TEMPLATES = path.resolve(import.meta.dirname, '../../templates/githooks');
const ALWAYS = ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite'];
const HOOKS_DIR = '.githooks';

function githooksInstall(ctx: Ctx, args: Args<{ 'dry-run'?: boolean; 'pre-commit'?: boolean }>): number {
  const dry = Boolean(args.values['dry-run']), names = args.values['pre-commit'] ? [...ALWAYS, 'pre-commit'] : ALWAYS;
  const targets = names.map((n) => path.join(ctx.root, HOOKS_DIR, n));
  if (!dry) precheckTargets(ctx, targets); // a symlink or a path outside the repository is REFUSED before anything is written
  names.forEach((name, i) => {
    const text = fs.readFileSync(path.join(TEMPLATES, name), 'utf8'), dst = targets[i] as string, shown = `${HOOKS_DIR}/${name}`;
    let old: string | null = null;
    try { old = fs.readFileSync(dst, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (old === text) { ctx.io.out(`unchanged ${shown}`); return; }
    if (old !== null) { ctx.io.out(`kept ${shown} (it differs from the template; delete it to install the template)`); return; }
    if (dry) { ctx.io.out(`would write ${shown}`); return; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { writeAtomicSafe(dst, text, { root: ctx.root, mode: 0o755 }); fs.chmodSync(dst, 0o755); } catch (e) { refuseWrite(e); }
    ctx.io.out(`wrote ${shown}`);
  });
  ctx.io.outBlock([
    'to enable them, pick one (this command never changes git config):',
    `  git:      git config core.hooksPath ${HOOKS_DIR}`,
    '  lefthook: add to lefthook.yml, one block per hook, e.g.',
    '              post-commit: { commands: { plangraph: { run: plangraph refresh --fast --quiet || true } } }',
    '              (also post-merge, post-checkout, post-rewrite; for the check: pre-commit: plangraph check --quiet)',
    `  husky:    copy a script to .husky/<hook> (for example cp ${HOOKS_DIR}/post-commit .husky/post-commit)`,
  ]);
  return 0;
}

export const commands: CommandMap = {
  'githooks-install': {
    run: githooksInstall as never, positionals: [0, 0], writes: 'file', guard: 'none', options: { 'dry-run': { type: 'boolean' }, 'pre-commit': { type: 'boolean' } },
    summary: '[--dry-run] [--pre-commit]: write post-commit, post-merge, post-checkout and post-rewrite scripts (and with --pre-commit a pre-commit check) into .githooks/ and print how to enable them',
  },
};
