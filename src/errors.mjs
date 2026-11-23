// Typed errors and the exit-code contract of the brain CLI. No I/O.
// Exit codes: 0 ok, 1 not-ok verdict (ready/check/verify/whatif negative), 2 usage or data error, 3 environment missing,
// 4 refused (guard), 5 unknown/aborted, 6 verification failed.
// Every printed error ends with one `try: <exact command>` line (the error table below), so an agent always has a next step.
import { sanitizeText, neutralizeTags } from '../lib/sanitize.mjs';
import { FormatError } from '../lib/store.mjs';

export const EXIT = Object.freeze({ OK: 0, NOT_OK: 1, USAGE: 2, DATA: 2, NO_INDEX: 2, STALE: 2, ENV: 3, REFUSED: 4, UNKNOWN: 5, ABORTED: 5, VERIFY_FAILED: 6 });
const EXIT_BY_CODE = new Map(Object.entries(EXIT)); // Map: a code such as "constructor" can never hit a prototype member

/** What each exit code of `brain` means, in the order `brain explain` prints it (6 is the solver's, bin/brain-solve; brain never returns it). */
export const EXIT_MEANING = Object.freeze([[0, 'ok'], [1, 'negative answer'], [2, 'usage or data error'], [3, 'environment missing'], [4, 'refused'], [5, 'internal error']]);

// The error table: code -> exit code and the default `try:` command. `null` means "explain the command that failed" (brain explain CMD,
// or brain explain when no registered command is known). A hint that names a `brain ...` command in backticks overrides the default.
export const ERRORS = new Map([
  ['OK', { exit: EXIT.OK, try: null }],
  ['NOT_OK', { exit: EXIT.NOT_OK, try: null }],
  ['USAGE', { exit: EXIT.USAGE, try: null }],
  ['DATA', { exit: EXIT.DATA, try: null }],
  ['NO_INDEX', { exit: EXIT.NO_INDEX, try: 'brain build' }],
  ['STALE', { exit: EXIT.STALE, try: 'brain build' }],
  ['ENV', { exit: EXIT.ENV, try: 'brain doctor' }],
  ['REFUSED', { exit: EXIT.REFUSED, try: null }],
  ['UNKNOWN', { exit: EXIT.UNKNOWN, try: 'brain doctor' }],
  ['ABORTED', { exit: EXIT.ABORTED, try: null }],
  ['VERIFY_FAILED', { exit: EXIT.VERIFY_FAILED, try: 'brain verify' }],
]);

export class BrainError extends Error {
  /** @param {string} code @param {string} message @param {{ hint?: string, cause?: unknown }} [opts] */
  constructor(code, message, { hint, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BrainError';
    this.code = code;
    this.hint = hint;
    this.exitCode = EXIT_BY_CODE.get(code) ?? EXIT.UNKNOWN;
  }
}

/** Exit code for anything a command may throw. Parse and format errors of the data are 2; anything unexpected is 5. */
/** @param {unknown} e @returns {number} */
export function exitCodeOf(e) {
  if (e instanceof BrainError) return e.exitCode;
  if (e instanceof FormatError || (e instanceof Error && e.name === 'IngestError')) return EXIT.DATA;
  return EXIT.UNKNOWN;
}

/** One printed error line: escape sequences and invisible characters removed (sanitizeText), every whitespace run (newlines included)
 * collapsed to one space, capped. An `<untrusted>` fence tag is neutralized as in lib/sanitize.mjs fence(); other angle brackets stay,
 * so usage text such as `<command>` or `>=` reads as written. */
/** @type {(s: unknown, max?: number) => string} */
export const errText = (s, max) => neutralizeTags(sanitizeText(sanitizeText(s, { max: Infinity }).replace(/\s+/g, ' ').trim(), { max }));
const oneLine = errText;

// Edit distance with an early exit; callers cap both inputs (MAX_NAME), so this is at most MAX_NAME^2 steps.
const MAX_NAME = 60;
/** @param {string} a @param {string} b */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** The nearest known name within 2 edits (ties: the alphabetically first), or null. Deterministic. */
/** @param {unknown} name @param {Iterable<string>} known @returns {string | null} */
export function didYouMean(name, known) {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME) return null;
  let best = null, bestD = 3;
  for (const k of [...known].toSorted()) { if (k.length > MAX_NAME) continue; const d = distance(name, k); if (d < bestD) { best = k; bestD = d; } }
  return best;
}

// A `brain ...` command quoted in backticks in one of our own hints (hints are fixed strings, never data): plain string scan, no regex.
/** @param {unknown} hint */
function commandIn(hint) {
  const s = String(hint ?? ''); const i = s.indexOf('`brain ');
  if (i < 0) return null;
  const j = s.indexOf('`', i + 1);
  return j > i ? s.slice(i + 1, j) : null;
}
const COMMAND = /^[a-z][a-z0-9-]{0,39}$/;

/** The exact command of the `try:` line. `command` is the name of the command that failed, only when it is registered (checked by the
 * caller and again here by shape), so untrusted argv never reaches it. */
/** @param {unknown} e @param {{ command?: string }} [opts] */
export function tryOf(e, { command } = {}) {
  const explain = typeof command === 'string' && COMMAND.test(command) ? `brain explain ${command}` : 'brain explain';
  if (e instanceof BrainError) return commandIn(e.hint) ?? ERRORS.get(e.code)?.try ?? explain;
  if (e instanceof FormatError || (e instanceof Error && e.name === 'IngestError')) return 'brain doctor';
  return 'brain doctor';
}

/** The stderr lines for an error: one `error:` line per message line (IngestError keeps its file:line list), a `hint:` line when the
 * hint is prose (a hint that names a command becomes the try line instead), then exactly one `try: <exact command>` line.
 * Every line goes through errText, so a message carrying a newline or a fence tag cannot forge a second output line or a fence. */
/** `root` (the repository root, when known): every occurrence in a message is printed as `.`, so no error leaks the absolute path. */
/** @param {unknown} e @param {{ command?: string, root?: string }} [opts] */
export function errorLines(e, opts = {}) {
  const t = `try: ${tryOf(e, opts)}`, root = opts.root;
  const msg = (/** @type {unknown} */ m) => (typeof root === 'string' && root.length > 1 ? String(m).split(root).join('.') : String(m));
  if (e instanceof BrainError) return [`error: ${oneLine(msg(e.message), 400)}`, ...(e.hint && !commandIn(e.hint) ? [`hint: ${oneLine(e.hint, 200)}`] : []), t];
  if (e instanceof FormatError || (e instanceof Error && e.name === 'IngestError')) return [...msg(e.message).split('\n').slice(0, 11).map((l) => `error: ${oneLine(l, 300)}`), t];
  return [`error: internal error: ${oneLine(msg(e instanceof Error ? e.message : String(e)), 200)}`, t];
}
