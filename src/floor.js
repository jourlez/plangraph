// This file stays plain JavaScript (the only .js file in the plugin) so a Node too old to strip types can still read it and print the floor
// message; test/floor.test.ts fails if a type annotation ever appears here.
// The Node floor, in one place. bin/plangraph imports this BEFORE anything else, so it must parse on any old Node: plain syntax only
// (no `using`, no newer operators). The floor is 24.2 because the CLI uses node:sqlite (24) and import.meta.main (24.2).
// package.json engines, README, CHANGELOG, docs/CONTRACT.md, `plangraph doctor` and the entry-point guard all say this value
// (test/floor.test.ts ties them together).
export const NODE_FLOOR = '24.2';
const [FLOOR_MAJOR, FLOOR_MINOR] = /** @type {[number, number]} */ (NODE_FLOOR.split('.').map(Number));

/** true when `version` (like "24.18.0" or "v24.18.0") is at or above the floor; anything unparsable is false. */
/** @param {unknown} version */
export function nodeSupported(version) {
  const m = /^v?(\d{1,4})\.(\d{1,4})/.exec(String(version));
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > FLOOR_MAJOR || (major === FLOOR_MAJOR && minor >= FLOOR_MINOR);
}

/** The one message for a too-old Node (stderr of the entry point, PlangraphError ENV in src/db.ts). The version is capped. */
export const floorMessage = (/** @type {unknown} */ version) => `plangraph needs Node >= ${NODE_FLOOR} (found ${String(version).slice(0, 20)}); it uses node:sqlite and current ES features`;

/** The one try line printed after floorMessage by bin/plangraph (plain text: no command can run on a too-old Node). */
export const floorTry = `try: install Node ${NODE_FLOOR} or newer`;
