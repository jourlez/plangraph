// lib/jira/provider.ts: the Jira TrackerProvider. Every networked member checks the Trust against the module-private registry of
// src/jira-tenant.ts (deps.verifyTrust: a type brand alone is not enough, a cast or an object spread would pass it) BEFORE any helper or
// request, and builds its client only for trust.tenant. No fs, no process.
import { AUTH_MODES } from './types.ts';
import { JiraError } from './error.ts';
import { makeClient } from './client.ts';
import { dcHostsFromEnv, siteHostsFromEnv } from './host.ts';
import { importIssues, pullSnapshot } from './snapshot.ts';
import { fetchIssueText, renderIssue } from './render.ts';
import type { Ctx } from '../../src/context.ts';
import type { Trust } from '../../src/jira-tenant.ts';
import type { ProviderDeps, TrackerProvider, TrackerSettings } from '../tracker.ts';
import type { JiraClient, JiraCredentials, PullOptions, PullResult } from './types.ts';

export function createJiraProvider(ctx: Ctx, deps: ProviderDeps): TrackerProvider {
  const env = ctx.env;
  // Same rule as src/jira-tenant.ts tenantOf: the cloud id for a scoped token, else the host of the base URL ('' when it cannot be told).
  const tenantOfRaw = (mode: unknown, cloudId: unknown, baseUrl: unknown): string => {
    if ((mode || AUTH_MODES.SCOPED) === AUTH_MODES.SCOPED) return String(cloudId || '').toLowerCase();
    try { return new URL(String(env.JIRA_BASE_URL || baseUrl)).host.toLowerCase(); } catch { return ''; }
  };
  const tenantId = (s: TrackerSettings): string => tenantOfRaw(s.auth?.mode, s.cloud_id, s.base_url);
  // The one gate: an unminted Trust (hand-built, cast, spread copy with another tenant) is refused before anything else happens.
  const gate = (trust: unknown): Trust => {
    if (!deps.verifyTrust(trust)) throw new JiraError('bad_config', 'the tracker needs a tenant decision minted by resolveTenant');
    return trust;
  };
  const clientFor = async (trust: Trust): Promise<JiraClient> => {
    const base = deps.clientBaseFor(trust);
    // the client may talk only to the site the decision was made for, even if the environment changed since
    if (tenantOfRaw(base.auth?.mode, base.cloudId, base.baseUrl) !== trust.tenant) throw new JiraError('bad_config', 'the client settings no longer match the tenant that was decided');
    const creds: JiraCredentials = await deps.credentialsFor(trust);
    return makeClient({ baseConfig: base, creds, dcHosts: dcHostsFromEnv(env), siteHosts: siteHostsFromEnv(env), now: ctx.now, ...(ctx.fetch ? { fetchImpl: ctx.fetch } : {}) });
  };
  return Object.freeze({
    kind: 'jira',
    tenantId,
    async credentials(trust: Trust): Promise<JiraCredentials> { return deps.credentialsFor(gate(trust)); },
    async pull(trust: Trust, opts: PullOptions): Promise<PullResult> { return pullSnapshot(await clientFor(gate(trust)), opts); },
    importIssues,
    renderIssue,
    async fetchIssueText(trust: Trust, key: string, opts?: { maxChars?: number }): Promise<string> { return fetchIssueText(await clientFor(gate(trust)), key, opts); },
  });
}
