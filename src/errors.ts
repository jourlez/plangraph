// Typed errors and the exit-code contract of the plangraph CLI. No I/O.
// Exit codes: 0 ok, 1 not-ok verdict (ready/check/verify/whatif negative), 2 usage or data error, 3 environment missing,
// 4 refused (guard), 5 unknown/aborted, 6 verification failed.
// Every printed error ends with one `try: <exact command>` line (the error table below), so an agent always has a next step.
import { sanitizeText, neutralizeTags } from '../lib/sanitize.ts';
import { FormatError } from '../lib/store.ts';

export const EXIT = Object.freeze({ OK: 0, NOT_OK: 1, USAGE: 2, DATA: 2, NO_INDEX: 2, NO_PLANGRAPH: 2, STALE: 2, ENV: 3, REFUSED: 4, UNKNOWN: 5, ABORTED: 5, VERIFY_FAILED: 6 });
const EXIT_BY_CODE = new Map(Object.entries(EXIT)); // Map: a code such as "constructor" can never hit a prototype member

/** What each exit code of `plangraph` means, in the order `plangraph explain` prints it (6 is the solver's, bin/plangraph-solve; plangraph never returns it). */
export const EXIT_MEANING = Object.freeze([[0, 'ok'], [1, 'negative answer'], [2, 'usage or data error'], [3, 'environment missing'], [4, 'refused'], [5, 'internal error']]);

// The error table: code -> exit code and the default `try:` command. `null` means "explain the command that failed" (plangraph explain CMD,
// or plangraph explain when no registered command is known). A hint that names a `plangraph ...` command in backticks overrides the default.
export const ERRORS = new Map<string, { exit: number; try: string | null }>([
  ['OK', { exit: EXIT.OK, try: null }],
  ['NOT_OK', { exit: EXIT.NOT_OK, try: null }],
  ['USAGE', { exit: EXIT.USAGE, try: null }],
  ['DATA', { exit: EXIT.DATA, try: null }],
  ['NO_INDEX', { exit: EXIT.NO_INDEX, try: 'plangraph build' }],
  ['NO_PLANGRAPH', { exit: EXIT.NO_PLANGRAPH, try: 'plangraph init' }],
  ['STALE', { exit: EXIT.STALE, try: 'plangraph build' }],
  ['ENV', { exit: EXIT.ENV, try: 'plangraph doctor' }],
  ['REFUSED', { exit: EXIT.REFUSED, try: null }],
  ['UNKNOWN', { exit: EXIT.UNKNOWN, try: 'plangraph doctor' }],
  ['ABORTED', { exit: EXIT.ABORTED, try: null }],
  ['VERIFY_FAILED', { exit: EXIT.VERIFY_FAILED, try: 'plangraph verify' }],
]);

export class PlangraphError extends Error {
  declare code: string; // `declare`: no class-field initializer at run time
  declare hint: string | undefined;
  declare exitCode: number;
  constructor(code: string, message: string, { hint, cause }: { hint?: string | undefined; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PlangraphError';
    this.code = code;
    this.hint = hint;
    this.exitCode = EXIT_BY_CODE.get(code) ?? EXIT.UNKNOWN;
  }
}

// A plan or cache path that is not what it must be (a FIFO or a directory where a file belongs, a file where a directory belongs) is a data error with its own message, never an internal error.
const DATA_FS = new Set(['NOT_A_FILE', 'SWAPPED', 'ENOTDIR', 'EISDIR', 'ELOOP']);
const isDataFs = (e: unknown): boolean => e instanceof Error && DATA_FS.has((e as { code?: unknown }).code as string);

/** Exit code for anything a command may throw. Parse and format errors of the data are 2; anything unexpected is 5. */
export function exitCodeOf(e: unknown): number {
  if (e instanceof PlangraphError) return e.exitCode;
  if (e instanceof FormatError || (e instanceof Error && e.name === 'IngestError') || isDataFs(e)) return EXIT.DATA;
  return EXIT.UNKNOWN;
}

/** One printed error line: escape sequences and invisible characters removed (sanitizeText), every whitespace run (newlines included)
 * collapsed to one space, capped. An `<untrusted>` fence tag is neutralized as in lib/sanitize.ts fence(); other angle brackets stay,
 * so usage text such as `<command>` or `>=` reads as written. */
export const errText = (s: unknown, max?: number): string => neutralizeTags(sanitizeText(sanitizeText(s, { max: Infinity }).replace(/\s+/g, ' ').trim(), { max } as { max?: number })); // sanitizeText defaults an undefined max exactly as an absent one
const oneLine = errText;

// Edit distance with an early exit; callers cap both inputs (MAX_NAME), so this is at most MAX_NAME^2 steps.
const MAX_NAME = 60;
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)); // prev has b.length + 1 entries; cur[j - 1] was set just before (cur[0] = i)
    prev = cur;
  }
  return prev[b.length] as number; // prev always has b.length + 1 entries
}
/** The nearest known name within 2 edits (ties: the alphabetically first), or null. Deterministic. */
export function didYouMean(name: unknown, known: Iterable<string>): string | null {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME) return null;
  let best: string | null = null, bestD = 3;
  for (const k of [...known].toSorted()) { if (k.length > MAX_NAME) continue; const d = distance(name, k); if (d < bestD) { best = k; bestD = d; } }
  return best;
}

// A `plangraph ...` command quoted in backticks in one of our own hints (hints are fixed strings, never data): plain string scan, no regex.
function commandIn(hint: unknown): string | null {
  const s = String(hint ?? ''); const i = s.indexOf('`plangraph ');
  if (i < 0) return null;
  const j = s.indexOf('`', i + 1);
  return j > i ? s.slice(i + 1, j) : null;
}
const COMMAND = /^[a-z][a-z0-9-]{0,39}$/;

/** The exact command of the `try:` line. `command` is the name of the command that failed, only when it is registered (checked by the
 * caller and again here by shape), so untrusted argv never reaches it. */
export function tryOf(e: unknown, { command }: { command?: string | undefined } = {}): string {
  const explain = typeof command === 'string' && COMMAND.test(command) ? `plangraph explain ${command}` : 'plangraph explain';
  if (e instanceof PlangraphError) return commandIn(e.hint) ?? ERRORS.get(e.code)?.try ?? explain;
  if (e instanceof FormatError || (e instanceof Error && e.name === 'IngestError')) return 'plangraph doctor';
  return 'plangraph doctor';
}

/** The stderr lines for an error: one `error:` line per message line (IngestError keeps its file:line list), a `hint:` line when the
 * hint is prose (a hint that names a command becomes the try line instead), then exactly one `try: <exact command>` line.
 * Every line goes through errText, so a message carrying a newline or a fence tag cannot forge a second output line or a fence. */
/** `root` (the repository root, when known): every occurrence in a message is printed as `.`, so no error leaks the absolute path. */
export function errorLines(e: unknown, opts: { command?: string | undefined; root?: string | undefined } = {}): string[] {
  const t = `try: ${tryOf(e, opts)}`, root = opts.root;
  const msg = (m: unknown) => (typeof root === 'string' && root.length > 1 ? String(m).split(root).join('.') : String(m));
  if (e instanceof PlangraphError) return [`error: ${oneLine(msg(e.message), 400)}`, ...(e.hint && !commandIn(e.hint) ? [`hint: ${oneLine(e.hint, 200)}`] : []), t];
  if (isDataFs(e)) return [`error: ${oneLine(msg((e as Error).message), 300)}`, t];
  if (e instanceof FormatError || (e instanceof Error && e.name === 'IngestError')) return [...msg(e.message).split('\n').slice(0, 11).map((l) => `error: ${oneLine(l, 300)}`), t];
  return [`error: internal error: ${oneLine(msg(e instanceof Error ? e.message : String(e)), 200)}`, t];
}
