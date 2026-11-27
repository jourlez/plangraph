// This file stays plain JavaScript (like src/entry.js) so a Node too old to strip types can still read it and print the floor
// message; test/floor.test.ts fails if a type annotation ever appears here.
// The Node floor, in one place. src/entry.js imports this BEFORE anything else, so it must parse on any old Node: plain
// syntax only (no `using`, no newer operators). The floor is 26.0 (Node 26 is the Active LTS line); the CLI uses node:sqlite, type stripping and import.meta.main, which print no runtime
// warning there.
// package.json engines, README, CHANGELOG, docs/CONTRACT.md, `plangraph doctor` and the entry-point guard all say this value
// (test/floor.test.ts ties them together).
export const NODE_FLOOR = '26.0';
const [FLOOR_MAJOR, FLOOR_MINOR] = /** @type {[number, number]} */ (NODE_FLOOR.split('.').map(Number));

/** true when `version` (like "26.13.1" or "v26.13.1") is at or above the floor; anything unparsable is false. */
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
export const floorHookLine = (/** @type {unknown} */ version) => `plangraph: needs Node >= ${NODE_FLOOR}, found ${String(version).slice(0, 20)}; install Node 26`;

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

/** The opt-in hooks (benchmark ruling): `card --if-present` runs only when the option card (CLAUDE_PLUGIN_OPTION_CARD or PLANGRAPH_CARD) is `auto` or `on`, `hook-prompt` only when prompt_hook (CLAUDE_PLUGIN_OPTION_PROMPT_HOOK or PLANGRAPH_PROMPT_HOOK) is `on`. Unset, empty or anything else is off. Any other command: true. */
export function hookOptedIn(/** @type {string[]} */ argv, /** @type {Record<string, string | undefined>} */ env) {
  const is = (/** @type {Array<string | undefined>} */ vals, /** @type {string[]} */ ok) => vals.some((v) => ok.includes(String(v ?? '').trim().toLowerCase()));
  if (argv[2] === 'card' && argv.includes('--if-present')) return is([env.CLAUDE_PLUGIN_OPTION_CARD, env.PLANGRAPH_CARD], ['auto', 'on']);
  if (argv[2] === 'hook-prompt') return is([env.CLAUDE_PLUGIN_OPTION_PROMPT_HOOK, env.PLANGRAPH_PROMPT_HOOK], ['on']);
  return true;
}
