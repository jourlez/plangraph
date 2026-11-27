// The real runners behind `plangraph sync-fetch` (lib/fetch/* take a Runner and never touch a process or the network themselves).
// ghRunner: the user's own `gh` through execFile, argv only (no shell), GET only. jiraRunner: the same request shape answered by the existing
// read-only Jira client (its allowlist, credentials and redaction stay the only path to Atlassian). A runner never throws: a failed request
// is a result, and a request that is not a plain GET is refused before anything is run (code 126).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUTH_MODES, JiraError, dcHostsFromEnv, makeClient, siteHostsFromEnv } from '../lib/jira.ts';
import { clientBase, isMintedTrust, resolutionOf, resolveTenant, tenantCredentials } from './jira-tenant.ts';
import type { JiraSettings } from './jira-tenant.ts';
import type { Runner } from '../lib/fetch/gh.ts';
import type { JiraClient } from '../lib/jira.ts';
import type { Ctx } from './context.ts';

type Result = { code: number; out: string; err: string };
const refused = (why: string): Result => ({ code: 126, out: '', err: `refused: ${why}` });
const GH_PATH = /^[A-Za-z0-9/][A-Za-z0-9/._~%?&=:,@+*!$'()#-]*$/;
const HEADER = /^(Accept|If-None-Match): [\x20-\x7e]{1,200}$/;

/** `api --include --method GET [-H "Accept: .." | -H "If-None-Match: .."]... PATH` and nothing else. */
function plainGet(argv: readonly string[]): { path: string } | string {
  if (argv.length < 5 || argv[0] !== 'api' || argv[1] !== '--include' || argv[2] !== '--method' || argv[3] !== 'GET') return 'only `api --include --method GET PATH` is allowed';
  const path = argv[argv.length - 1] as string;
  for (let i = 4; i < argv.length - 1; i += 2) if (argv[i] !== '-H' || !HEADER.test(argv[i + 1] ?? '')) return 'only the Accept and If-None-Match headers are allowed';
  if ((argv.length - 5) % 2 !== 0 || path.includes('://') || !GH_PATH.test(path)) return 'the request path is not plain';
  return { path };
}

type ExecFileLike = (file: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
const execP = promisify(execFile) as unknown as ExecFileLike;

/** `gh` with the user's own token. `exec` is a test seam. */
export function ghRunner(exec: ExecFileLike = execP): Runner {
  return async (argv): Promise<Result> => {
    const ok = plainGet(argv);
    if (typeof ok === 'string') return refused(ok);
    try {
      const r = await exec('gh', [...argv], { shell: false, maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true });
      return { code: 0, out: String(r.stdout), err: String(r.stderr) };
    } catch (e) {
      const x = e as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (x.code === 'ENOENT') return { code: 127, out: '', err: 'gh is not installed' };
      return { code: typeof x.code === 'number' ? x.code : 1, out: typeof x.stdout === 'string' ? x.stdout : '', err: typeof x.stderr === 'string' ? x.stderr : String((e as Error)?.message ?? e) };
    }
  };
}

const reply = (status: number, body: string, headers = ''): Result => ({ code: 0, out: `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}\r\n${headers}\r\n${body}`, err: '' });

/** A Runner over the read-only Jira client. The search path of Cloud is answered by client.search (its POST is on the allowlist); other
 *  GETs go through client.request, whose allowlist decides. A rate limit becomes a 429 with Retry-After so the fetchers stop and keep their cursor. */
export function jiraRunner(client: Pick<JiraClient, 'mode' | 'search' | 'request'>): Runner {
  return async (argv): Promise<Result> => {
    const ok = plainGet(argv);
    if (typeof ok === 'string') return refused(ok);
    const u = new URL(ok.path, 'https://x.invalid'), q = Object.fromEntries(u.searchParams);
    try {
      if (u.pathname === '/rest/api/3/search/jql') {
        if (client.mode === AUTH_MODES.DATACENTER) return { code: 1, out: '', err: 'Data Center is not supported by sync-fetch' };
        const page = await client.search({ jql: q.jql ?? '', fields: (q.fields ?? '').split(',').filter(Boolean), pageSize: Number(q.maxResults) || 100, ...(q.nextPageToken ? { cursor: q.nextPageToken } : {}) });
        return reply(200, JSON.stringify({ issues: page.issues, ...(page.cursor !== null && page.cursor !== undefined ? { nextPageToken: String(page.cursor) } : {}), isLast: page.last }));
      }
      return reply(200, JSON.stringify(await client.request('GET', u.pathname, { query: q })));
    } catch (e) {
      const code = String((e as { code?: unknown })?.code ?? '');
      if (code === 'quota' || code === 'rate_limit_wait' || code === 'rate_limited') {
        const at = Date.parse((e as { resetAt?: string }).resetAt ?? ''), after = Number.isFinite(at) ? Math.max(1, Math.min(86400, Math.ceil((at - Date.now()) / 1000))) : 60;
        return reply(429, '{}', `Retry-After: ${after}\r\n`);
      }
      return { code: 1, out: '', err: String((e as Error)?.message ?? e) };
    }
  };
}

/** What sync-fetch needs from the outside world. Production builds it from the context; a test passes its own as `ctx.fetchDeps`. */
export interface FetchDeps {
  github(): Runner;
  atlassian: { tenant(): string; runner(): Promise<Runner> };
}

/** The tenant (cloud id or host) is decided without credentials; credentials are read only when `runner()` is called, after the trust check. */
export function defaultFetchDeps(ctx: Ctx): FetchDeps {
  const committed = (): JiraSettings | undefined => ctx.config().jira as JiraSettings | undefined;
  let cached: Promise<Runner> | undefined;
  return {
    github: () => ghRunner(),
    atlassian: {
      tenant: () => resolveTenant(committed(), ctx.root, ctx.env).tenant,
      runner: () => (cached ??= (async () => {
        const res = resolveTenant(committed(), ctx.root, ctx.env);
        if (!isMintedTrust(res.trust)) throw new JiraError('bad_config', 'the tracker needs a tenant decision minted by resolveTenant');
        const r = resolutionOf(res.trust), base = clientBase(r, ctx.env), creds = await tenantCredentials(r, ctx.env, ctx.exec ? { exec: ctx.exec } : {});
        const client = makeClient({ baseConfig: base, creds, dcHosts: dcHostsFromEnv(ctx.env), siteHosts: siteHostsFromEnv(ctx.env), now: ctx.now, ...(ctx.fetch ? { fetchImpl: ctx.fetch } : {}) });
        return jiraRunner(client);
      })()),
    },
  };
}
