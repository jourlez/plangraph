// lib/tracker.ts: the tracker provider seam. Commands talk to a TrackerProvider (src/context.ts Ctx.tracker()), never to lib/jira.ts directly.
// Every networked member takes the Trust that src/jira-tenant.ts resolveTenant minted, refuses anything else with bad_config before any
// credential helper or request, and builds its client only for that trust's tenant. Only type imports from src/ (erased at runtime), no fs.
import { createJiraProvider } from './jira/provider.ts';
import type { Ctx } from '../src/context.ts';
import type { Trust } from '../src/jira-tenant.ts';
import type { AuthMode, ImportResult, JiraCredentials, PullOptions, PullResult, RawImport, RawIssue, Snapshot } from './jira.ts';

export { siteTag, KEY_RE, parseSnapshotJsonl, snapshotToJsonl, toLegacyMap } from './jira.ts';
export type { Snapshot, RawIssue, RawImport, PullOptions, PullResult, LegacyIssue, JiraCredentials } from './jira.ts';

/** The tracker settings of one project (the committed config block with the user's projects entry laid over it). */
export interface TrackerSettings { kind?: string; tenant?: string; auth?: { mode: AuthMode }; base_url?: string; cloud_id?: string; jql?: string; sprint_field?: string }

/** One tracker. The networked members (credentials, pull, fetchIssueText) need a minted Trust and use only its tenant. */
export interface TrackerProvider {
  readonly kind: string;
  tenantId(s: TrackerSettings): string;
  credentials(trust: Trust): Promise<JiraCredentials>;
  pull(trust: Trust, opts: PullOptions): Promise<PullResult>;
  importIssues(previous: Snapshot | null, input: RawImport | RawIssue[] | null, opts?: { sprintField?: string | undefined; now?: () => Date }): ImportResult;
  renderIssue(key: string, raw: RawIssue | null | undefined, opts?: { maxChars?: number }): string;
  fetchIssueText(trust: Trust, key: string, opts?: { maxChars?: number }): Promise<string>;
}

/** What the provider may ask of src/jira-tenant.ts (which reads the registry and the committed settings; lib/ has no fs). */
export interface ProviderDeps {
  verifyTrust(t: unknown): t is Trust;
  credentialsFor(t: Trust): Promise<JiraCredentials>;
  clientBaseFor(t: Trust): { auth: { mode?: unknown } | undefined; cloudId: unknown; baseUrl: string | undefined };
}

/** The known provider kinds: a frozen null-prototype object, read with Object.hasOwn. */
export const PROVIDERS: Readonly<Record<string, (ctx: Ctx, deps: ProviderDeps) => TrackerProvider>> = Object.freeze(Object.assign(Object.create(null) as Record<string, (ctx: Ctx, deps: ProviderDeps) => TrackerProvider>, { jira: createJiraProvider })); // as Record: Object.create(null) is typed object
