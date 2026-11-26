// plangraph: planning memory for AI coding agents. The commands live in src/commands/ behind the registry (src/registry.ts); src/cli.ts
// parses, runs and prints. `plangraph explain` lists them (generated from the registry).
// bin/plangraph is a launcher only; the SessionStart hook runs this file directly (an extensioned file loads as an ES module on every Node
// that has ES modules, the extensionless launcher does not on Node 18 and 20.0 to 20.9).
// This file stays parseable on any old Node: it checks the floor first and only then loads the CLI (which uses current syntax). Nothing heavy
// loads before the check or the compile cache: floor.js is the only static import, src/cli.ts and its whole command tree load with one dynamic import.
// Too-old Node: exit 3 with the message and a try line; with --if-present exit 0 and nothing on stderr, and `card --if-present` (the
// SessionStart hook) prints ONE stdout line saying the floor; `card --if-present` is also silent with exit 0 on any failure in src/cli.ts.
// Compile cache (supported Node only, before the CLI loads): kept in a PRIVATE directory, <data>/compile-cache, where <data> is CLAUDE_PLUGIN_DATA
// when absolute, else ~/.cache/plangraph (the lib/driver.ts defaultDataDir rule, inlined: nothing from lib/ or a .ts file loads before the
// cache is on, since the first .ts file pays the type-stripper start-up). Node trusts a cache directory of any owner and mode (CRC32-checked
// entries, plain JavaScript in the transpile cache), so a shared one would run code another local user planted. Both directories must be real
// directories (lstat: no symlink) owned by this uid; <data> without group or world write (the driver's trust-root rule), the cache without any
// group or world bit (win32: owner and mode not checked). When NODE_COMPILE_CACHE is set, Node's own behavior is left untouched. Any error
// or refusal means no cache: it prints nothing, never throws and never changes the exit code (test/compile-cache.test.ts).
import { nodeSupported, floorMessage, floorTry, floorHookLine } from './floor.js';

if (!nodeSupported(process.versions.node)) {
  const quiet = process.argv.includes('--if-present');
  if (!quiet) process.stderr.write(`${floorMessage(process.version)}\n${floorTry}\n`);
  else if (process.argv[2] === 'card') process.stdout.write(`${floorHookLine(process.version)}\n`);
  process.exitCode = quiet ? 0 : 3;
} else {
  try {
    const { enableCompileCache } = await import('node:module'), { NODE_COMPILE_CACHE, CLAUDE_PLUGIN_DATA } = process.env; // destructured: satisfies both tsc (no dot access on env) and Biome (no literal key)
    if (!NODE_COMPILE_CACHE && typeof enableCompileCache === 'function') {
      const fs = await import('node:fs'), { join, isAbsolute } = await import('node:path'), { homedir } = await import('node:os');
      const base = CLAUDE_PLUGIN_DATA && isAbsolute(CLAUDE_PLUGIN_DATA) ? CLAUDE_PLUGIN_DATA : join(homedir(), '.cache', 'plangraph');
      const dir = join(base, 'compile-cache');
      /** @param {string} p @param {number} forbidden */
      const owned = (p, forbidden) => {
        const st = fs.lstatSync(p);
        if (!st.isDirectory()) return false;
        return process.platform === 'win32' || (typeof process.getuid === 'function' && st.uid === process.getuid() && (st.mode & forbidden) === 0);
      };
      if (!fs.lstatSync(base, { throwIfNoEntry: false }) || owned(base, 0o022)) { // checked before mkdir: never create through a symlink
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (owned(base, 0o022) && owned(dir, 0o077)) enableCompileCache(dir);
      }
    }
  } catch { /* the cache is optional: any error means no cache */ }
  const { main } = await import('./cli.ts');
  process.exitCode = await main(process.argv.slice(2), { env: process.env, cwd: process.cwd(), io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) } });
}
