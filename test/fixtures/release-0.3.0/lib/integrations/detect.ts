// Tool detection: which companion tools are installed or active, from files only. Pure: every input comes from the arguments
// (root, home, env, fsImpl), no process is started, nothing touches the network, and nothing outside root, home/.claude, home/.openwolf
// and home/Library/Caches/GitKrakenCLI (existence only) is looked at. JSON is read through readCapped (regular files, 1 MiB) and
// parsed tolerantly: anything unreadable gives state `absent` plus the note `unreadable`. Never throws.
// Strings from files another tool or repo controls (plugin keys, versions, settings labels) are accepted only when they match a strict
// pattern, counted (never echoed) otherwise, and everything that still enters evidence or notes goes through oneLine.
// Note: readCapped opens files through the real fs, so fsImpl covers existence, stat and directory checks only.
import fs from 'node:fs';
import path from 'node:path';

import { readCapped } from '../jsonl.ts';
import { oneLine } from '../sanitize.ts';

/** The fs members detection calls (node:fs fits, so does a test double). */
export interface DetectFs { existsSync(p: string): boolean; statSync(p: string): { isDirectory(): boolean; isFile(): boolean } }
/** detectTools options. root and home are required: path.join throws without them, as it always did. */
export interface DetectOpts { root: string; home: string; env?: Record<string, string | undefined>; fsImpl?: DetectFs; names?: readonly string[] }
/** One detected tool. */
export interface DetectedTool { name: string; state: string; evidence: string[]; notes: string[]; version?: string }
/** A connector name-glob hint. */
export interface ConnectorHint { name: string; glob: string; purpose: string }
/** One line of the always-on token budget. */
export interface BudgetItem { name: string; tokens: number; source: string }
/** detectTools' answer. */
export interface DetectResult { tools: DetectedTool[]; connectorHints: ConnectorHint[]; budget: { items: BudgetItem[]; total: number } }
/** One settings file, read. */
type SettingsEntry = { label: string; file: string; state: 'ok'; json: Record<string, unknown> } | { label: string; file: string; state: 'missing' | 'unreadable'; json?: never };

const CAP = 1024 * 1024;
const MEASURED = 'measured 2026-11-22 on one machine';
// Static table of always-on injections in tokens (research other-tools.md section 6). Not a live measurement.
const BUDGET: Record<string, number> = { caveman: 936, superpowers: 871, openwolf: 1067, context7: 175, gitkraken: 0 };
const PLANGRAPH_CARD = 185;
const GITKRAKEN_NOTE = 'logs every prompt and tool result to ~/Library/Caches/GitKrakenCLI/sessions (per research); permission hook can wait up to 24 h without the desktop app';

// Name-glob patterns a skill can match against its own tool list. Connectors cannot be detected from a shell.
export const CONNECTOR_HINTS: ConnectorHint[] = [
  { name: 'atlassian', glob: 'mcp__*Atlassian*__getJiraIssue', purpose: 'read one Jira issue' },
  { name: 'atlassian', glob: 'mcp__*Atlassian*__searchJiraIssuesUsingJql', purpose: 'search Jira issues by JQL (delta import)' },
  { name: 'slack', glob: 'mcp__*Slack*__slack_send_message_draft', purpose: 'draft a message for a person to send' },
  { name: 'meetings', glob: 'mcp__*Meetings*__get_meeting_action_items', purpose: 'read meeting action items' },
  { name: 'google-drive', glob: 'mcp__*Google_Drive*__read_file_content', purpose: 'read a spec or plan document' },
  { name: 'claude-docs', glob: 'mcp__*Claude_Docs*__create', purpose: 'create an editable living document' },
  { name: 'artifacts', glob: 'Artifact', purpose: 'publish a private page (a tool named Artifact, not an MCP server)' },
];

const KEY_OK = /^[A-Za-z0-9][\w.@-]{0,99}$/, VERSION_OK = /^[\w.+-]{1,64}$/;
const KNOWN = ['superpowers', 'openwolf', 'caveman', 'context7', 'gitkraken'];
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

// Returns { ok, value }; ok is false when missing, too large, not a regular file, or not valid JSON.
function readJson(file: string): { ok: boolean; value: unknown } {
  try { return { ok: true, value: JSON.parse(readCapped(file, CAP)) }; }
  catch { return { ok: false, value: undefined }; }
}
const exists = (fsImpl: DetectFs, p: string): boolean => { try { return fsImpl.existsSync(p); } catch { return false; } };
const isDir = (fsImpl: DetectFs, p: string): boolean => { try { return fsImpl.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (fsImpl: DetectFs, p: string): boolean => { try { return fsImpl.statSync(p).isFile(); } catch { return false; } };
const nameOf = (key: string): string => String(key).split('@')[0] as string; // split always returns at least one element

function readSettings(files: Array<{ label: string; file: string }>, fsImpl: DetectFs): SettingsEntry[] {
  return files.map(({ label, file }): SettingsEntry => {
    if (!exists(fsImpl, file)) return { label, file, state: 'missing' };
    const r = readJson(file);
    return r.ok && isObj(r.value) ? { label, file, state: 'ok', json: r.value } : { label, file, state: 'unreadable' };
  });
}

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } };

// `names` is the list of tools to report (default: the five known ones, in this order). A name that is not one of them is looked up as a plain plugin (test-only seam).
export function detectTools({ root, home, env = process.env, fsImpl = fs, names = KNOWN }: DetectOpts = {} as DetectOpts): DetectResult { // every caller passes root and home
  const claude = path.join(home, '.claude');
  const notes: { superpowers: string[]; openwolf: string[]; caveman: string[]; context7: string[]; gitkraken: string[]; [name: string]: string[] | undefined } = { superpowers: [], openwolf: [], caveman: [], context7: [], gitkraken: [] };

  // ---- plugin registry (installed_plugins.json, version 2 shape) ----
  const regFile = path.join(claude, 'plugins', 'installed_plugins.json');
  const reg = readJson(regFile);
  const plugins = reg.ok && isObj(reg.value) && isObj(reg.value.plugins) ? reg.value.plugins : null;
  const registryOk = plugins !== null;

  // ---- settings: precedence local, project, user ----
  const settings = readSettings([
    { label: 'project settings.local.json', file: path.join(root, '.claude', 'settings.local.json') },
    { label: 'project settings.json', file: path.join(root, '.claude', 'settings.json') },
    { label: 'user settings.json', file: path.join(claude, 'settings.json') },
  ], fsImpl);

  const rootReal = real(root);
  // user-scope entries always count; project- and local-scope entries only for this project (projectPath, realpath-normalized).
  const forThisProject = (e: Record<string, unknown>) => (e.scope === 'project' || e.scope === 'local') ? typeof e.projectPath === 'string' && real(e.projectPath) === rootReal : true;

  function pluginInfo(name: string) {
    let ignored = 0;
    const keys: string[] = [];
    let version: string | undefined;
    for (const k of registryOk ? Object.keys(plugins as Record<string, unknown>) : []) { // registryOk: plugins is not null
      if (nameOf(k) !== name) continue;
      if (!KEY_OK.test(k)) { ignored++; continue; }
      const entries = Array.isArray((plugins as Record<string, unknown>)[k]) ? ((plugins as Record<string, unknown>)[k] as unknown[]).filter(isObj) : null; // registryOk: plugins is not null; Array.isArray is the check
      const mine = entries ? entries.filter(forThisProject) : [];
      if (entries && !mine.length) continue; // only other projects' entries: not installed here
      keys.push(k);
      const ok = (e: Record<string, unknown>) => typeof e.version === 'string' && VERSION_OK.test(e.version);
      ignored += mine.filter((e) => typeof e.version === 'string' && !VERSION_OK.test(e.version)).length;
      const pick = mine.find((e) => e.scope === 'user' && ok(e)) ?? mine.find(ok);
      if (pick && version === undefined) version = pick.version as string; // ok() tested it is a string
    }
    // Enabled-ness is per exact key, as Claude Code keys plugins (`name@marketplace`): for each key, the most specific settings layer that
    // names it decides (local, then project, then user). A key enabled in settings is the plugin only when that same key is installed, so
    // `superpowers@one-marketplace` enabled while `superpowers@another-marketplace` is installed is reported as two facts, never merged.
    const decided = new Map<string, { on: boolean; label: string }>();
    for (const s of settings) {
      if (s.state !== 'ok' || !isObj(s.json.enabledPlugins)) continue;
      const named = Object.entries(s.json.enabledPlugins).filter(([k, v]) => nameOf(k) === name && typeof v === 'boolean');
      const hit = named.filter(([k]) => KEY_OK.test(k)); ignored += named.length - hit.length;
      for (const [k, v] of hit) if (!decided.has(k)) decided.set(k, { on: v === true, label: s.label });
    }
    const enabledBy = keys.filter((k) => decided.get(k)?.on).map((k) => ({ key: k, label: (decided.get(k) as { label: string }).label })); // filtered to keys with a decision
    const enabledNotInstalled = [...decided].filter(([k, d]) => d.on && !keys.includes(k)).map(([k, d]) => ({ key: k, label: d.label })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const disabledSeen = keys.some((k) => decided.get(k)?.on === false);
    return { keys, version, enabledBy, enabledNotInstalled, disabledSeen, ignored };
  }

  function pluginTool(name: string, pluginName: string, withEnabledState: boolean): DetectedTool {
    const p = pluginInfo(pluginName);
    const t: DetectedTool = { name, state: 'absent', evidence: [], notes: notes[name] as string[] }; // unchecked: undefined for a name outside the five known ones (the test-only names seam), and a later push then throws (pre-existing)
    if (!registryOk) { t.notes.push('unreadable'); return t; }
    if (p.keys.length) {
      t.state = withEnabledState && p.enabledBy.length ? 'enabled' : 'installed';
      if (p.version !== undefined) t.version = oneLine(p.version, 64);
      for (const k of p.keys) t.evidence.push(oneLine(`installed: ${k}`));
      for (const e of p.enabledBy) t.evidence.push(oneLine(`enabled: ${e.key} in ${e.label}`));
      if (p.disabledSeen && !p.enabledBy.length) t.notes.push('disabled in settings');
      if (p.enabledNotInstalled.length) t.notes.push(oneLine(`enabled in settings but not installed: ${p.enabledNotInstalled.map((e) => `${e.key} (${e.label})`).join(', ')}`, 400));
    } else if (p.enabledNotInstalled.length) t.notes.push('enabled in settings but not installed');
    for (const e of p.enabledNotInstalled) t.evidence.push(oneLine(`enabled, not installed: ${e.key} in ${e.label}`));
    if (p.ignored) t.notes.push(`ignored ${p.ignored} entries with unsafe names`);
    return t;
  }

  const superpowers = pluginTool('superpowers', 'superpowers', true);
  const caveman = pluginTool('caveman', 'caveman', true);
  const context7 = pluginTool('context7', 'context7', true);
  const gitkraken = pluginTool('gitkraken', 'gitkraken-hooks', true); // the registry name of the plugin

  if (exists(fsImpl, path.join(claude, '.caveman-active'))) { caveman.notes.push('~/.claude/.caveman-active exists (a global hint, not per-session truth)'); caveman.evidence.push('~/.claude/.caveman-active'); }
  if (env && env.CAVEMAN_DEFAULT_MODE === 'off') caveman.notes.push('CAVEMAN_DEFAULT_MODE=off');
  if (gitkraken.state !== 'absent') {
    gitkraken.notes.push(GITKRAKEN_NOTE);
    if (isDir(fsImpl, path.join(home, 'Library', 'Caches', 'GitKrakenCLI'))) gitkraken.evidence.push('~/Library/Caches/GitKrakenCLI exists (contents never read)');
  }

  // ---- OpenWolf: absent | protocol-only | active | disabled (research openwolf.md section 4, P1-P4) ----
  const openwolf: DetectedTool = { name: 'openwolf', state: 'absent', evidence: [], notes: notes.openwolf };
  const wolf = path.join(root, '.wolf');
  if (isDir(fsImpl, wolf)) {
    openwolf.evidence.push('.wolf/ is a directory');
    const cfg = readJson(path.join(wolf, 'config.json'));
    const cfgObj = cfg.ok && isObj(cfg.value) ? cfg.value : null;
    const disabled = cfgObj !== null && isObj(cfgObj.openwolf) && cfgObj.openwolf.enabled === false;
    const hookFile = path.join(wolf, 'hooks', 'session-start.js');
    const hookInstalled = isFile(fsImpl, hookFile);
    if (hookInstalled) openwolf.evidence.push('.wolf/hooks/session-start.js exists');
    // Settings files: the three project/user ones plus the one the config names, only if it stays inside root.
    const files = settings.map((s) => ({ label: s.label, file: s.file }));
    const named = cfgObj && isObj(cfgObj.openwolf) && isObj(cfgObj.openwolf.claude) && typeof cfgObj.openwolf.claude.settings_file === 'string' ? cfgObj.openwolf.claude.settings_file : null;
    if (named) {
      const abs = path.resolve(root, named), rel = path.relative(root, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !files.some((f) => path.resolve(f.file) === abs)) files.push({ label: named, file: abs });
    }
    const registered: string[] = [];
    for (const f of files) {
      try { if (isFile(fsImpl, f.file) && readCapped(f.file, CAP).includes('/.wolf/hooks/session-start.js')) registered.push(f.label); } catch { /* unreadable: not evidence */ }
    }
    for (const l of registered) openwolf.evidence.push(oneLine(`hook registered in ${l}`));
    const rt = readJson(path.join(wolf, 'hooks', 'runtime.json'));
    if (rt.ok && isObj(rt.value) && typeof rt.value.version === 'string' && VERSION_OK.test(rt.value.version)) { openwolf.version = oneLine(rt.value.version, 64); openwolf.evidence.push(oneLine(`.wolf/hooks/runtime.json version ${rt.value.version}`)); }
    if (disabled) { openwolf.state = 'disabled'; openwolf.evidence.push('.wolf/config.json openwolf.enabled is false'); }
    else if (hookInstalled && registered.length) openwolf.state = 'active';
    else {
      openwolf.state = 'protocol-only';
      if (!hookInstalled) openwolf.notes.push('no .wolf/hooks/session-start.js');
      if (!registered.length) openwolf.notes.push('no hook registered in any settings file');
    }
  }
  const regOw = readJson(path.join(home, '.openwolf', 'registry.json'));
  if (regOw.ok && isObj(regOw.value) && Array.isArray(regOw.value.projects)) {
    const hit = (regOw.value.projects as unknown[]).some((p) => isObj(p) && typeof p.root === 'string' && path.resolve(p.root) === path.resolve(root)); // Array.isArray is the check
    openwolf.evidence.push(hit ? '~/.openwolf/registry.json lists this project' : '~/.openwolf/registry.json exists (project not listed)');
  }

  const known: Record<string, DetectedTool> = { superpowers, openwolf, caveman, context7, gitkraken };
  const tools = names.map((n) => known[n] ?? pluginTool(n, n, true));
  // A plugin costs tokens only when enabled (installed but not enabled injects nothing). OpenWolf counts for any state but absent:
  // its cost arrives through the CLAUDE.md `@.wolf/OPENWOLF.md` import, not through hooks.
  const costs = (t: DetectedTool) => (t.name === 'openwolf' ? t.state !== 'absent' : t.state === 'enabled');
  const items = tools.filter(costs).map((t) => ({ name: t.name, tokens: BUDGET[t.name] ?? 0, source: MEASURED }));
  items.push({ name: 'plangraph card', tokens: PLANGRAPH_CARD, source: MEASURED });
  return { tools, connectorHints: CONNECTOR_HINTS.map((h) => ({ ...h })), budget: { items, total: items.reduce((n, i) => n + i.tokens, 0) } };
}
