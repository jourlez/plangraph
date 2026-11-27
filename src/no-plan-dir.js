// Hook fast path: kept out of entry.js (which stays thin). Plain JavaScript, imported only after the Node floor check.
/** True when no plan directory can exist for this run: no --dir, PLANGRAPH_DIR, GIT_DIR or .plangraphrc, and no .plangraph in the repository root (the nearest ancestor with .git, else the cwd). Errs towards false. */
export async function noPlanDir() {
  try {
    const fs = await import('node:fs'), { join, dirname, resolve } = await import('node:path');
    const { env, argv } = process;
    if (env.PLANGRAPH_DIR || env.GIT_DIR || env.GIT_WORK_TREE || argv.some((a) => a === '--dir' || a.startsWith('--dir='))) return false;
    let root = resolve(process.cwd());
    for (let d = root; ; d = dirname(d)) {
      if (fs.existsSync(join(d, '.git'))) { root = d; break; }
      if (dirname(d) === d) break;
    }
    return !fs.existsSync(join(root, '.plangraph')) && !fs.existsSync(join(root, '.plangraphrc'));
  } catch { return false; }
}
