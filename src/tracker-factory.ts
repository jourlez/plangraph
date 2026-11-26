// The tracker provider of a context: tracker.kind of config.json (default jira) picks one of lib/tracker.ts PROVIDERS. It lives in src/ so
// lib/ has no value import from src/, and it reads the registry and the committed settings through src/jira-tenant.ts.
import { PROVIDERS } from '../lib/tracker.ts';
import { PlangraphError } from './errors.ts';
import { clientBase, isMintedTrust, resolutionOf, tenantCredentials } from './jira-tenant.ts';
import type { TrackerProvider } from '../lib/tracker.ts';
import type { Ctx } from './context.ts';

/** @throws PlangraphError DATA (exit 2) for an unknown kind (an own key of PROVIDERS only: `__proto__` and `constructor` are unknown). */
export function createTracker(ctx: Ctx): TrackerProvider {
  const block = (ctx.config() as { tracker?: unknown }).tracker; // config.json's tracker block: PlanConfig does not type it
  const kind = block !== null && typeof block === 'object' && Object.hasOwn(block, 'kind') ? (block as { kind?: unknown }).kind : 'jira';
  if (typeof kind !== 'string' || !Object.hasOwn(PROVIDERS, kind)) throw new PlangraphError('DATA', `unknown tracker.kind in config.json; known kinds: ${Object.keys(PROVIDERS).join(', ')}`);
  return (PROVIDERS[kind] as (typeof PROVIDERS)[string])(ctx, {
    verifyTrust: isMintedTrust,
    credentialsFor: (t) => tenantCredentials(resolutionOf(t), ctx.env, ctx.exec ? { exec: ctx.exec } : {}),
    clientBaseFor: (t) => clientBase(resolutionOf(t), ctx.env),
  });
}
