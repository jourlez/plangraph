// The one steer toward `plangraph`, shared by the session card's last line, the CLAUDE.md snippet `plangraph init` PRINTS (plangraph never writes a
// repo's CLAUDE.md) and the `plangraph doctor` info check. Pure: no I/O. The plan dir is the only input; it comes from .plangraphrc or PLANGRAPH_DIR
// (repo-controlled text), so it is one sanitized capped line before it is printed.
import { oneLine } from './sanitize.ts';

export const STEER_COMMANDS = 'ticket, ready, whatif, blockers, sprint, person';
/** The plan dir as printed: one line, forward slashes, no trailing slash, at most 80 characters; empty or `.` means `.plangraph`. */
const dirOf = (dir: unknown = undefined) => { const d = oneLine(dir ?? '', 80).replace(/\\/g, '/').replace(/\/+$/, ''); return d && d !== '.' ? d : '.plangraph'; };
/** The text whose presence `hasSteer` checks: `<dir>/*.jsonl`. */
const steerMarker = (dir: unknown = undefined): string => `${dirOf(dir)}/*.jsonl`;
/** The card's last line. */
export const steerLine = (dir: unknown = undefined): string => `plan questions: use plangraph (${STEER_COMMANDS}); do not read ${steerMarker(dir)}`;
/** The three lines `plangraph init` suggests for the repo's own CLAUDE.md. */
export const claudeSnippet = (dir: unknown = undefined): string[] => [
  '## Plan questions',
  `Use \`plangraph\` for plan questions (${STEER_COMMANDS}); do not read ${steerMarker(dir)} or the index.`,
  'Run `plangraph explain` for the full command list.',
];
/** Does a CLAUDE.md text already carry the steer? A plain substring check on `<dir>/*.jsonl` (any wording around it counts). */
export const hasSteer = (text: unknown, dir: unknown = undefined): boolean => String(text ?? '').includes(steerMarker(dir));
