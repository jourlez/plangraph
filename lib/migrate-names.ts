// The one bridge from the names used before the rename to plangraph (0.3.0) to the current names. There is no fallback anywhere else:
// the CLI reads only the new names, so state kept under an old name is invisible until this command copies or renames it.
// Pure planning: every file system and git access goes through the injected MigrateFs and MigrateGit, so a test can plant any state.
// Explicit only (src/commands/migrate-names.ts): never run by a hook, `card` or any other command. Dry run unless apply is asked for.
// User state: copies (never moves) jira-sites.json and autopilot.json from the old config folder to the new one with mode 0600; a symlink
// or a non-regular file is refused, an existing new file is never overwritten, nothing else is written. The keychain is never read or
// written (a secret written by this process would sit on a process argument list): a one-line recipe to re-save it is printed instead.
// Repository: .brainrc -> .plangraphrc (content unchanged), the default .brain directory -> .plangraph (a directory named by the rc
// keeps its path), the .gitattributes merge line and the .gitignore lines, the merge driver's git config. A working tree with
// uncommitted changes to tracked files is refused for the repository part. CLAUDE.md and permission rules are only named, never edited.
import path from 'node:path';

/** What an lstat answered: never follows a symlink. null when the path does not exist. */
export interface Entry { kind: 'file' | 'dir' | 'symlink' | 'other'; size: number }
export interface MigrateFs {
  lstat(p: string): Entry | null;
  /** A regular file's text, at most max bytes; a symlink is refused. */
  read(p: string, max: number): string;
  /** Create dst exclusively with mode 0600 holding src's bytes (src read without following a symlink); never overwrites. */
  copyPrivate(src: string, dst: string): void;
  /** Create a directory (and its parents) with mode 0700. */
  mkdirPrivate(dir: string): void;
  rename(from: string, to: string): void;
  /** Replace a repository file atomically. */
  write(p: string, text: string): void;
}
/** git in the repository root: ok with stdout, or not ok. Never throws. */
export type MigrateGit = (args: string[]) => { ok: boolean; out: string };
export interface MigrateInput {
  home: string;
  oldConfigDir: string;
  newConfigDir: string;
  /** the repository root, or null outside a git repository */
  root: string | null;
  fs: MigrateFs;
  git: MigrateGit;
  /** Creates the stable merge shim and returns the git config driver command for it (called only when the config is changed). */
  driverCommand(): string;
}
interface Step { text: string; run(): void }
export interface MigratePlan { steps: Step[]; refused: string[]; notes: string[]; found: boolean; copied: boolean; oldConfigDir: string }

const OLD = Object.freeze({ configFolder: 'project-brain', rc: '.brainrc', dir: '.brain', driver: 'brain-jsonl', index: 'brain.sqlite', keychain: 'project-brain-jira' });
const NEW = Object.freeze({ configFolder: 'plangraph', rc: '.plangraphrc', dir: '.plangraph', driver: 'plangraph-jsonl', index: 'plangraph.sqlite', keychain: 'plangraph-jira' });
const USER_FILES = Object.freeze(['jira-sites.json', 'autopilot.json']);
const MAX = 64 * 1024;
const MAX_TEXT = 1024 * 1024;

/** The old user config folder: $XDG_CONFIG_HOME/project-brain, else ~/.config/project-brain (the old variable is not read). */
export const oldConfigDir = (env: Record<string, string | undefined>, home: string): string => path.join(env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(home, '.config'), OLD.configFolder);

const tilde = (p: string, home: string): string => (home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const token = (s: string): RegExp => new RegExp(`(?<![\\w.-])${escapeRe(s)}(?!\\w)`, 'g'); // brain.sqlite-journal is the index's sidecar: it follows

/** One line's rewrite for .gitattributes and .gitignore: the driver and index names, and the default directory when it moves. */
export function rewriteLine(line: string, dirMoved: boolean): string {
  let l = line.replace(new RegExp(`merge=${escapeRe(OLD.driver)}(?![\\w-])`, 'g'), `merge=${NEW.driver}`).replace(token(OLD.index), NEW.index);
  if (dirMoved) l = l.replace(new RegExp(`^(\\s*!?(?:\\*\\*/)?/?)${escapeRe(OLD.dir)}(?=/|\\s|$)`), `$1${NEW.dir}`); // an optional negation, an optional **/ and an optional anchoring slash come first
  return l;
}
const stillNamesDir = (line: string): boolean => !line.trimStart().startsWith('#') && new RegExp(`(?<![\\w.-])${escapeRe(OLD.dir)}(?!\\w)`).test(line);
const rewriteText = (text: string, dirMoved: boolean): string => text.split('\n').map((l) => rewriteLine(l, dirMoved)).join('\n');

function userPart(input: MigrateInput, plan: MigratePlan): void {
  const { fs, home } = input, od = input.oldConfigDir, nd = input.newConfigDir, show = (p: string) => tilde(p, home);
  const o = fs.lstat(od);
  if (!o) return;
  plan.found = true;
  if (o.kind !== 'dir') { plan.refused.push(`${show(od)} is not a directory (a symlink is refused): nothing copied`); return; }
  const n = fs.lstat(nd);
  if (n && n.kind !== 'dir') { plan.refused.push(`${show(nd)} is not a directory (a symlink is refused): nothing copied`); return; }
  let madeDir = Boolean(n);
  for (const f of USER_FILES) {
    const src = path.join(od, f), dst = path.join(nd, f), s = fs.lstat(src);
    if (!s) continue;
    if (s.kind === 'symlink') { plan.refused.push(`${show(src)} is a symlink: not copied`); continue; }
    if (s.kind !== 'file') { plan.refused.push(`${show(src)} is not a regular file: not copied`); continue; }
    if (s.size > MAX) { plan.refused.push(`${show(src)} is larger than 64 KiB: not copied`); continue; }
    if (fs.lstat(dst)) { plan.notes.push(`keep ${show(dst)}: it exists and is never overwritten`); continue; }
    const mk = !madeDir; madeDir = true;
    plan.copied = true;
    plan.steps.push({ text: `copy ${show(src)} to ${show(dst)} (mode 0600)`, run: () => { if (mk) fs.mkdirPrivate(nd); fs.copyPrivate(src, dst); } });
  }
}

const RC_DIR = (input: MigrateInput, rcFile: string): string | undefined => {
  try { const v: unknown = JSON.parse(input.fs.read(rcFile, MAX)); return v && typeof v === 'object' && typeof (v as { dir?: unknown }).dir === 'string' ? (v as { dir: string }).dir : undefined; } // a parsed JSON object: dir checked on the same line
  catch { return undefined; }
};

function repoPart(input: MigrateInput, plan: MigratePlan): void {
  const { fs, git } = input, root = input.root;
  if (!root || !git(['rev-parse', '--git-dir']).ok) return;
  const at = (p: string) => path.join(root, p);
  const rcOld = fs.lstat(at(OLD.rc)), rcNew = fs.lstat(at(NEW.rc));
  const dirOld = fs.lstat(at(OLD.dir)), dirNew = fs.lstat(at(NEW.dir));
  const textOf = (name: string): { text: string | null; refused?: string } => {
    const e = fs.lstat(at(name));
    if (!e) return { text: null };
    if (e.kind !== 'file') return { text: null, refused: `${name} is not a regular file (a symlink is refused): not rewritten` };
    if (e.size > MAX_TEXT) return { text: null, refused: `${name} is larger than 1 MiB: not rewritten` };
    return { text: fs.read(at(name), MAX_TEXT) };
  };
  const ga = textOf('.gitattributes'), gi = textOf('.gitignore');
  const cfgOld = git(['config', '--local', '--get-regexp', `^merge\\.${escapeRe(OLD.driver)}\\.`]);
  const rcDir = rcOld?.kind === 'file' ? RC_DIR(input, at(OLD.rc)) : rcNew?.kind === 'file' ? RC_DIR(input, at(NEW.rc)) : undefined;
  const defaultDir = rcDir === undefined;
  const oldDriverLine = (t: string | null) => t !== null && new RegExp(`merge=${escapeRe(OLD.driver)}(?![\\w-])`).test(t);
  const found = Boolean(rcOld) || (defaultDir && Boolean(dirOld)) || oldDriverLine(ga.text) || (gi.text !== null && gi.text !== rewriteText(gi.text, defaultDir && Boolean(dirOld))) || (cfgOld.ok && cfgOld.out.trim() !== '') || Boolean(ga.refused) || Boolean(gi.refused);
  if (!found) return;
  plan.found = true;
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (!dirty.ok || dirty.out.trim()) { plan.refused.push('the repository has uncommitted changes to tracked files: commit or stash them, then run again (repository part skipped)'); return; }
  for (const r of [ga.refused, gi.refused]) if (r) plan.refused.push(r);
  const tracked = (p: string) => { const r = git(['ls-files', '--', p]); return r.ok && r.out.trim() !== ''; };
  const move = (from: string, to: string, label: string) => {
    const viaGit = tracked(from);
    plan.steps.push({ text: `${viaGit ? 'git mv' : 'rename'} ${from} ${to}${label}`, run: () => {
      if (!viaGit) { fs.rename(at(from), at(to)); return; }
      const r = git(['mv', '--', from, to]);
      if (!r.ok) throw new Error(`git mv ${from} ${to} failed`);
    } });
  };
  if (rcOld) {
    if (rcOld.kind !== 'file') plan.refused.push(`${OLD.rc} is not a regular file (a symlink is refused): not renamed`);
    else if (rcNew) plan.refused.push(`${NEW.rc} exists: ${OLD.rc} not renamed (merge them by hand)`);
    else move(OLD.rc, NEW.rc, ' (content unchanged)');
  }
  let moved = false;
  if (!defaultDir) plan.notes.push(`keep ${rcDir}: the directory is named by the rc file`);
  else if (dirOld) {
    if (dirOld.kind !== 'dir') plan.refused.push(`${OLD.dir} is not a directory (a symlink is refused): not moved`);
    else if (dirNew) plan.refused.push(`${NEW.dir} exists: ${OLD.dir} not moved`);
    else { move(OLD.dir, NEW.dir, ''); moved = true; if (fs.lstat(at(path.join(OLD.dir, OLD.index)))) plan.notes.push(`the old index ${NEW.dir}/${OLD.index} can be deleted: \`plangraph build\` writes ${NEW.dir}/${NEW.index}`); }
  }
  for (const [name, t] of [['.gitattributes', ga.text], ['.gitignore', gi.text]] as const) {
    if (t === null) continue;
    const next = rewriteText(t, moved);
    if (moved) next.split('\n').forEach((l, i) => { if (stillNamesDir(l)) plan.notes.push(`${name} line ${i + 1} still names ${OLD.dir} after the rewrite: change it by hand to ${NEW.dir} (printed only, not edited)`); });
    if (next === t) continue;
    const changed = t.split('\n').map((l, i) => [l, next.split('\n')[i] as string] as const).filter(([a, b]) => a !== b).map(([a, b]) => `${a.trim()} to ${b.trim()}`);
    plan.steps.push({ text: `${name}: ${changed.join('; ')}`, run: () => fs.write(at(name), next) });
  }
  const hasOldCfg = cfgOld.ok && cfgOld.out.trim() !== '';
  if (hasOldCfg || oldDriverLine(ga.text)) {
    plan.steps.push({ text: `git config: set merge.${NEW.driver}.name and .driver (the stable merge shim)${hasOldCfg ? `, remove merge.${OLD.driver}` : ''}`, run: () => {
      const cmd = input.driverCommand();
      for (const [k, v] of [['name', 'plangraph jsonl three-way merge'], ['driver', cmd]] as const) if (!git(['config', `merge.${NEW.driver}.${k}`, v]).ok) throw new Error(`git config merge.${NEW.driver}.${k} failed`);
      if (hasOldCfg && !git(['config', '--local', '--remove-section', `merge.${OLD.driver}`]).ok) throw new Error(`git config --remove-section merge.${OLD.driver} failed`);
    } });
  }
  const marker = `${OLD.dir}/*.jsonl`;
  const claude = textOf('CLAUDE.md');
  if (defaultDir && claude.text?.includes(marker)) plan.notes.push(`CLAUDE.md names ${marker}: change it to ${NEW.dir}/*.jsonl in the plan-questions lines (printed only, not edited)`);
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const n = (textOf(f).text?.match(/Bash\(brain(?=[\s:)*])/g) || []).length;
    if (n) plan.notes.push(`${f}: ${n} permission rule(s) start with Bash(brain: change them to Bash(plangraph (printed only, not edited)`);
  }
}

/** Plan every change; nothing is written. */
export function planMigration(input: MigrateInput): MigratePlan {
  const plan: MigratePlan = { steps: [], refused: [], notes: [], found: false, copied: false, oldConfigDir: input.oldConfigDir };
  userPart(input, plan);
  repoPart(input, plan);
  return plan;
}

/** The lines the command prints for a plan; `applied` says whether the steps were run. */
export function report(plan: MigratePlan, { apply, home, result }: { apply: boolean; home: string; result?: ApplyResult }): string[] {
  if (!plan.found) return ['migrate-names: no old names found, nothing to do'];
  if (!plan.steps.length && !plan.refused.length) return [`migrate-names: already migrated, nothing to do (${tilde(plan.oldConfigDir, home)} can be deleted once you no longer need it)`];
  const lines = [...plan.steps.map((s, i) => (result && i >= result.done ? (i === result.done && result.failed ? `failed: ${s.text}: ${result.failed.error}` : `not run: ${s.text}`) : `${apply ? 'done' : 'would'}: ${s.text}`)), ...plan.refused.map((r) => `refused: ${r}`), ...plan.notes.map((n) => `note: ${n}`)];
  lines.push(`keychain: never read or written here; if a Jira token is stored under ${OLD.keychain}[:host], re-save it as ${NEW.keychain}[:host] (macOS: security add-generic-password -s ${NEW.keychain} -a "$JIRA_EMAIL" -w)`);
  if (plan.copied) lines.push(`the old folder ${tilde(plan.oldConfigDir, home)} is left in place and is safe to delete${apply ? '' : ' after --apply'}`);
  lines.push(result?.failed ? `failed after ${result.done} of ${plan.steps.length} change(s): fix the cause, commit what was already changed, then run \`plangraph migrate-names --apply\` again` : apply ? `applied ${plan.steps.length} change(s)` : `dry run: nothing changed; run \`plangraph migrate-names --apply\` to apply ${plan.steps.length} change(s)`);
  return lines;
}

/** What running the steps did: the steps completed in order, and the first one that failed (the rest were not run). */
export interface ApplyResult { done: number; failed: { text: string; error: string } | null }
/** Run the planned steps in order (user copies first, then the repository). Stops at the first failure and says which step it was; never throws. */
export function applyMigration(plan: MigratePlan): ApplyResult {
  for (const [i, s] of plan.steps.entries()) {
    try { s.run(); } catch (e) { return { done: i, failed: { text: s.text, error: e instanceof Error ? e.message : String(e) } }; }
  }
  return { done: plan.steps.length, failed: null };
}
