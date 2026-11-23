// The one steer toward `brain`, shared by the session card's last line, the CLAUDE.md snippet `brain init` PRINTS (brain never writes a
// repo's CLAUDE.md) and the `brain doctor` info check. Pure: no I/O. The brain dir is the only input; it comes from .brainrc or BRAIN_DIR
// (repo-controlled text), so it is one sanitized capped line before it is printed.
import { oneLine } from './sanitize.mjs';

export const STEER_COMMANDS = 'ticket, ready, whatif, blockers, sprint, person';
/** The brain dir as printed: one line, forward slashes, no trailing slash, at most 80 characters; empty or `.` means `.brain`. */
const dirOf = (/** @type {unknown} */ dir = undefined) => { const d = oneLine(dir ?? '', 80).replace(/\\/g, '/').replace(/\/+$/, ''); return d && d !== '.' ? d : '.brain'; };
/** The text whose presence `hasSteer` checks: `<dir>/*.jsonl`. */
export const steerMarker = (/** @type {unknown} */ dir = undefined) => `${dirOf(dir)}/*.jsonl`;
/** The card's last line. */
export const steerLine = (/** @type {unknown} */ dir = undefined) => `plan questions: use brain (${STEER_COMMANDS}); do not read ${steerMarker(dir)}`;
/** The three lines `brain init` suggests for the repo's own CLAUDE.md. */
export const claudeSnippet = (/** @type {unknown} */ dir = undefined) => [
  '## Plan questions',
  `Use \`brain\` for plan questions (${STEER_COMMANDS}); do not read ${steerMarker(dir)} or the index.`,
  'Run `brain explain` for the full command list.',
];
/** Does a CLAUDE.md text already carry the steer? A plain substring check on `<dir>/*.jsonl` (any wording around it counts). */
export const hasSteer = (/** @type {unknown} */ text, /** @type {unknown} */ dir = undefined) => String(text ?? '').includes(steerMarker(dir));
