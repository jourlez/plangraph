// Scripted git repositories for tests: deterministic dates, no user or system config, no network.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Who { name: string; email: string }
export interface CommitSpec { files: Record<string, string | Buffer | null>; who?: Who; at?: number; message?: string }
export interface Repo {
  dir: string;
  git(...args: string[]): string;
  commit(spec: CommitSpec): string;
  rename(from: string, to: string, extra?: { who?: Who; at?: number }): string;
  cleanup(): void;
}
export const ANA: Who = { name: 'Ana Lopez', email: 'ana@example.test' };
export const BEN: Who = { name: 'Ben Ito', email: 'ben@example.test' };
export const T0 = 1_700_000_000; // 2023-11-14, a fixed base for scripted histories

export const gitEnv = (who: Who = ANA, at: number = T0): NodeJS.ProcessEnv => ({
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
  GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000`,
});
export const runGit = (dir: string, args: string[], env: NodeJS.ProcessEnv = gitEnv()): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });

export function makeRepo(opts: { dir?: string } = {}): Repo {
  const dir = opts.dir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-gitrepo-')));
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv(), stdio: 'ignore' });
  let clock = T0;
  const repo: Repo = {
    dir,
    git: (...args) => runGit(dir, args),
    commit({ files, who = ANA, at, message = 'change' }) {
      const when = at ?? (clock += 3600);
      for (const [p, body] of Object.entries(files)) {
        const f = path.join(dir, p);
        if (body === null) { fs.rmSync(f, { force: true }); continue; }
        fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body);
      }
      runGit(dir, ['add', '-A'], gitEnv(who, when));
      runGit(dir, ['commit', '-q', '--allow-empty', '-m', message], gitEnv(who, when));
      return runGit(dir, ['rev-parse', 'HEAD']).trim();
    },
    rename(from, to, { who = ANA, at }: { who?: Who; at?: number } = {}) {
      const when = at ?? (clock += 3600);
      fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      runGit(dir, ['mv', from, to], gitEnv(who, when));
      runGit(dir, ['commit', '-q', '-m', 'rename'], gitEnv(who, when));
      return runGit(dir, ['rev-parse', 'HEAD']).trim();
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return repo;
}

/** A repo of n commits built with `git fast-import` (seconds for 20,000): each commit changes file `m<i % files>.txt` and `shared.txt`. */
export function fastRepo(n: number, { files = 50, start = T0, step = 60 }: { files?: number; start?: number; step?: number } = {}): Repo {
  const repo = makeRepo();
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const body = `v${i}\n`, shared = `s${i}\n`, at = start + i * step;
    parts.push(`commit refs/heads/main\nmark :${i + 1}\nauthor ${i % 2 ? 'B' : 'A'} <${i % 2 ? 'b' : 'a'}@example.test> ${at} +0000\ncommitter T <t@example.test> ${at} +0000\ndata 1\nc\n`);
    if (i > 0) parts.push(`from :${i}\n`);
    parts.push(`M 100644 inline m${i % files}.txt\ndata ${body.length}\n${body}\nM 100644 inline shared.txt\ndata ${shared.length}\n${shared}\n`);
  }
  execFileSync('git', ['-C', repo.dir, 'fast-import', '--quiet'], { input: parts.join(''), env: gitEnv(), stdio: ['pipe', 'ignore', 'pipe'], maxBuffer: 1 << 28 });
  runGit(repo.dir, ['reset', '-q', '--hard', 'main']);
  return repo;
}
