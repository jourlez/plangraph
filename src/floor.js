// This file stays plain JavaScript (like src/entry.js) so a Node too old to strip types can still read it and print the floor
// message; test/floor.test.ts fails if a type annotation ever appears here.
// The Node floor, in one place. src/entry.js imports this BEFORE anything else, so it must parse on any old Node: plain
// syntax only (no `using`, no newer operators). The floor is 24.15, the first 24.x whose node:sqlite and type stripping print no runtime
// warning (24.2 to 24.14 print ExperimentalWarning lines on stderr for every command); the CLI also uses node:sqlite (24) and import.meta.main (24.2).
// package.json engines, README, CHANGELOG, docs/CONTRACT.md, `plangraph doctor` and the entry-point guard all say this value
// (test/floor.test.ts ties them together).
export const NODE_FLOOR = '24.15';
const [FLOOR_MAJOR, FLOOR_MINOR] = /** @type {[number, number]} */ (NODE_FLOOR.split('.').map(Number));

/** true when `version` (like "24.18.0" or "v24.18.0") is at or above the floor; anything unparsable is false. */
/** @param {unknown} version */
export function nodeSupported(version) {
  const m = /^v?(\d{1,4})\.(\d{1,4})/.exec(String(version));
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > FLOOR_MAJOR || (major === FLOOR_MAJOR && minor >= FLOOR_MINOR);
}

/** The one message for a too-old Node (stderr of the entry points, PlangraphError ENV in src/db.ts). The version is capped. */
export const floorMessage = (/** @type {unknown} */ version) => `plangraph needs Node >= ${NODE_FLOOR} (found ${String(version).slice(0, 20)}); it uses node:sqlite and current ES features`;

/** The one try line printed after floorMessage by src/entry.js (plain text: no command can run on a too-old Node). */
export const floorTry = `try: install Node ${NODE_FLOOR} or newer`;

/** The one stdout line the SessionStart hook prints below the floor (the hook stays exit 0 and writes nothing). The version is capped. */
export const floorHookLine = (/** @type {unknown} */ version) => `plangraph: needs Node >= ${NODE_FLOOR}, found ${String(version).slice(0, 20)}; install Node 24`;

/** Hook fast path (kept in this plain-JS file so entry.js stays thin). True when no plan directory can exist for this run: no --dir, PLANGRAPH_DIR, GIT_DIR or .plangraphrc, and no .plangraph in the repository root (the nearest ancestor with .git, else the cwd). Errs towards false. */
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
