// Does a shell command write to the filesystem? A small structural reader for the eval graders (evals/run-p.ts), replacing the single
// regex the native harness has to use (schema.ts WRITE_BASH): that regex reads `print(v>c)` inside a `python3 - <<'E'` heredoc as a
// redirect. Here the command is split into the shell text and its heredoc bodies; quoted strings are blanked before the shell checks;
// code-level writes (python open(..., 'w'), fs.writeFileSync, os.remove ...) are looked for only in heredoc bodies and inline -c/-e code
// of an interpreter, so a `grep 'writeFileSync(' x` search is not a write. Pure: no I/O. Errs towards "write" on shell syntax it does
// not model (an unbalanced quote leaves the rest unblanked, so a later `>` still counts).

// Replace the characters inside '...' and "..." with spaces (same length, quote marks kept), so `>` or `;` in a string is not syntax.
export function blankQuotes(s: string): string {
  let out = '', q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!q) { if (ch === "'" || ch === '"') q = ch; out += ch; continue; }
    if (q === '"' && ch === '\\' && i + 1 < s.length) { out += '  '; i++; continue; }
    if (ch === q) { q = ''; out += ch; continue; }
    out += ch === '\n' ? '\n' : ' ';
  }
  return out;
}

// Split heredocs out: { shell: the command lines without heredoc bodies, bodies: [{ cmd: the line that opened it, text }] }.
export function splitHeredocs(cmd: unknown): { shell: string; bodies: Array<{ cmd: string; text: string }> } {
  const lines = String(cmd).split('\n'), shell: string[] = [], bodies: Array<{ cmd: string; text: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i++], bare = blankQuotes(raw);
    shell.push(raw);
    const pend: Array<{ strip: boolean; tag: string }> = [];
    const re = /(?<!<)<<(?!<)(-?)\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bare))) {
      const rest = raw.slice(m.index + m[0].length);
      const t = /^(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))/.exec(rest);
      if (t) pend.push({ strip: m[1] === '-', tag: (t[1] ?? t[2] ?? t[3]) as string }); // one of the three groups matched
    }
    for (const p of pend) {
      const body: string[] = [];
      while (i < lines.length && (p.strip ? lines[i].replace(/^\t+/, '') : lines[i]) !== p.tag) body.push(lines[i++]);
      i++; // the closing tag line (absent at the end: the body runs to the end, as bash reads it)
      bodies.push({ cmd: raw, text: body.join('\n') });
    }
  }
  return { shell: shell.join('\n'), bodies };
}

const DEV = String.raw`/dev/(?:null|stdout|stderr|tty|fd/[0-2])\b`;
// a `>` or `>>` (optionally after an fd number or &) whose target is a path, not /dev/null or an fd duplication (2>&1, >&2)
const REDIRECT = new RegExp(String.raw`(?:^|[^<>=!\-0-9])(?:[0-9]*|&)>>?\|?(?!&|\()[ \t]*(?!${DEV})[^\s&|;)]`, 'm');
const SEGMENT_SPLIT = /\|\||&&|[;|&\n()`]|\$\(/;
// first word of a segment (after VAR=x assignments and sudo/command/env/nice/xargs wrappers and their flags)
const LEAD = String.raw`^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|command|env|nice|nohup|time|xargs)\s+(?:-\S+\s+)*)*`;
const WRITE_CMD = new RegExp(`${LEAD}(?:rm|rmdir|mv|cp|touch|mkdir|tee|truncate|ln|install|chmod|chown|dd|unlink|patch|shred|rsync)\\b`);
const SED_I = new RegExp(`${LEAD}(?:g?sed|perl)\\b[^\\n]*\\s-[A-Za-z]*i`);
const GIT_W = new RegExp(`${LEAD}git\\b(?:\\s+-[cC]\\s+\\S+)*\\s+(?:commit|add|rm|mv|checkout|switch|reset|restore|apply|am|stash|merge|rebase|cherry-pick|revert|clean|push|pull|tag|config|init|worktree|update-index|notes)\\b`);
const PLANGRAPH_W = new RegExp(`${LEAD}(?:node\\s+)?(?:\\S*/)?plangraph\\s+(?:-\\S+\\s+)*(?:init|learn|migrate|refs-update|export|report|sp-ingest|sp-link|schedule-load|jira-pull|jira-import|units)\\b`);
const FIND_W = new RegExp(`${LEAD}find\\b[^\\n]*\\s-(?:delete|exec(?:dir)?\\s+(?:rm|mv|cp|sed\\s+-i|tee|truncate)\\b|fprint)`);
const INTERP = new RegExp(`${LEAD}(?:\\S*/)?(?:python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|osascript|sqlite3)\\b`);
// code-level writes in a script body (python, node, ruby, perl); SQL writes only where the code talks to sqlite
const CODE_W = new RegExp([
  String.raw`\bopen\s*\([^)\n]*,\s*(?:mode\s*=\s*)?[rbt]?['"][rbt]*[wax+]`,
  String.raw`\.(?:write_text|write_bytes|touch|mkdir|unlink|rmdir|symlink_to|hardlink_to)\s*\(`,
  String.raw`\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|truncate|symlink|link|chmod)\s*\(`,
  String.raw`\bshutil\.(?:move|copy\w*|rmtree)\s*\(`,
  String.raw`\b(?:writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync|mkdirSync|copyFileSync|cpSync|rmdirSync|truncateSync|symlinkSync|execSync|execFileSync|spawnSync)\s*\(`,
  String.raw`\b(?:fs|fsp|promises)\.(?:writeFile|appendFile|rm|unlink|rename|mkdir|copyFile|cp|rmdir|truncate|symlink|open)\s*\(`,
  String.raw`\bFile\.(?:write|open\s*\([^)\n]*['"][wa])`,
].join('|'));
const SQL_W = /\b(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE\s+INTO|VACUUM|ATTACH)\b/i;
const codeWrites = (text: string) => CODE_W.test(text) || (/sqlite/i.test(text) && SQL_W.test(text));

export function bashWrite(cmd: unknown): { write: boolean; why: string | null } {
  const s = String(cmd ?? '');
  if (/--(?:write|fix)\b/.test(blankQuotes(s))) return { write: true, why: '--write' };
  const { shell, bodies } = splitHeredocs(s);
  const bare = blankQuotes(shell);
  if (REDIRECT.test(bare)) return { write: true, why: 'redirect' };
  const segs = bare.split(SEGMENT_SPLIT);
  for (const seg of segs) {
    if (WRITE_CMD.test(seg)) return { write: true, why: 'command' };
    if (SED_I.test(seg)) return { write: true, why: 'in-place edit' };
    if (GIT_W.test(seg)) return { write: true, why: 'git write' };
    if (PLANGRAPH_W.test(seg)) return { write: true, why: 'plangraph write verb' };
    if (FIND_W.test(seg)) return { write: true, why: 'find write' };
  }
  // code: heredoc bodies fed to an interpreter, and inline code of an interpreter call (python -c '...', node -e '...')
  for (const b of bodies) {
    const opener = blankQuotes(b.cmd).split(SEGMENT_SPLIT).some((x) => INTERP.test(x));
    if (opener && codeWrites(b.text + '\n' + b.cmd)) return { write: true, why: 'script write' };
  }
  if (segs.some((x) => INTERP.test(x)) && codeWrites(shell)) return { write: true, why: 'script write' };
  return { write: false, why: null };
}
export const isWriteBash = (cmd: unknown) => bashWrite(cmd).write;
