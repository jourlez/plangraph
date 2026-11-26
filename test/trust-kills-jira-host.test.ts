// Behavior tests for lib/jira/host.ts and lib/jira/error.ts, written to kill the mutants of the trust-root run: every refusal of validateBase
// is asserted with its exact reason, and every accepted shape with its exact origin, host, kind and base path.
// NOT covered: DNS or TLS (only the parsed host is checked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBase } from '../lib/jira/host.ts';
import { JiraError } from '../lib/jira/error.ts';
import type { ValidateOptions } from '../lib/jira/types.ts';

const refused = (url: unknown, opts: ValidateOptions, why: string) =>
  assert.throws(() => validateBase(url, opts), (e: JiraError) => e instanceof JiraError && e.code === 'bad_host' && e.message === `base URL rejected: ${why}`, `${String(url)} ${JSON.stringify(opts)}`);
const DC = { mode: 'datacenter', dcHosts: 'jira.corp:8443,jira.other' } as const;
const LOOP = { allowInsecureLocalhostForTests: true } as const;

test('JiraError has the name JiraError, its code, and status and resetAt only when given', () => {
  const a = new JiraError('auth', 'nope');
  assert.equal(a.name, 'JiraError'); assert.equal(a.code, 'auth'); assert.equal(a.message, 'nope');
  assert.equal('status' in a, false); assert.equal('resetAt' in a, false);
  const b = new JiraError('quota', 'x', { status: 429, resetAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(b.status, 429); assert.equal(b.resetAt, '2026-01-01T00:00:00.000Z');
  assert.equal(new JiraError('http', 'x', { status: 0 }).status, 0);
  assert.ok(a instanceof Error && String(a) === 'JiraError: nope');
});

test('malformed input is refused with its own reason', () => {
  for (const bad of [undefined, null, 5, '']) refused(bad, {}, 'empty');
  for (const bad of ['https://api.atlassian.com/ x', 'https://api.atlassian.com/é', 'https://api.atlassian.com/\n', 'https://api.atlassian.com/\t']) refused(bad, {}, 'whitespace, control or non-ASCII character');
  for (const bad of ['https://api.atlassian.com\\x', 'https://api.atlassian.com/%41']) refused(bad, {}, 'backslash or percent-escape');
  refused('api.atlassian.com', {}, 'not an absolute URL');
  refused('https://', {}, 'not an absolute URL');
  for (const bad of ['https://u:p@api.atlassian.com/', 'https://u@api.atlassian.com/', 'https://:p@api.atlassian.com/']) refused(bad, {}, 'userinfo');
  for (const bad of ['https://api.atlassian.com/?x=1', 'https://api.atlassian.com/#f', 'https://api.atlassian.com/?', 'https://api.atlassian.com/#']) {
    if (new URL(bad).search || new URL(bad).hash) refused(bad, {}, 'query or fragment');
  }
  refused('https://api.atlassian.com/?a', { mode: 'scoped' }, 'query or fragment');
  refused('https://api.atlassian.com/#a', { mode: 'scoped' }, 'query or fragment');
});

test('plain http is only allowed for the loopback hosts and only when the test flag is exactly true', () => {
  refused('http://api.atlassian.com/', {}, 'https required');
  refused('http://127.0.0.1:3000/', {}, 'https required');
  for (const flag of [false, undefined, 1, 'true'] as unknown[]) refused('http://127.0.0.1:3000/', { allowInsecureLocalhostForTests: flag as boolean }, 'https required');
  refused('http://api.atlassian.com/', LOOP, 'https required');
  refused('http://example.com:3000/', LOOP, 'https required');
  refused('ftp://127.0.0.1/', LOOP, 'https required');
  for (const [url, host, origin] of [['http://127.0.0.1:3000/', '127.0.0.1', 'http://127.0.0.1:3000'], ['http://localhost:8080/', 'localhost', 'http://localhost:8080'], ['http://[::1]:9/', '[::1]', 'http://[::1]:9']] as const) {
    assert.deepEqual(validateBase(url, LOOP), { origin, host, kind: 'loopback', basePath: '' });
  }
  assert.deepEqual(validateBase('https://localhost:8443/', LOOP), { origin: 'https://localhost:8443', host: 'localhost', kind: 'loopback', basePath: '' });
  // a loopback host with the flag skips the host checks of the modes, whatever the mode
  for (const mode of ['scoped', 'site-token', undefined] as const) assert.equal(validateBase('http://localhost:1/', { ...LOOP, ...(mode ? { mode } : {}) }).kind, 'loopback');
  // a loopback Data Center test server may sit under a path; any other loopback may not
  assert.deepEqual(validateBase('http://127.0.0.1:5/jira/', { ...LOOP, mode: 'datacenter' }), { origin: 'http://127.0.0.1:5', host: '127.0.0.1', kind: 'loopback', basePath: '/jira' });
  refused('http://127.0.0.1:5/jira/', { ...LOOP, mode: 'site-token' }, 'path not allowed');
  refused('http://127.0.0.1:5/jira/', LOOP, 'path not allowed');
  // without the flag, a Data Center host is not loopback at all
  refused('https://127.0.0.1:5/', { mode: 'datacenter', dcHosts: 'jira.corp' }, 'host is not in the user-level Data Center allowlist (PLANGRAPH_JIRA_DC_HOSTS)');
});

test('Data Center: only a host:port of the user-level allowlist, with an optional plain path', () => {
  const why = 'host is not in the user-level Data Center allowlist (PLANGRAPH_JIRA_DC_HOSTS)';
  refused('https://jira.corp/', DC, why); // port 8443 is part of the allowed name
  refused('https://evil.example/', DC, why);
  refused('https://jira.corp:8443/', { mode: 'datacenter' }, why);
  assert.deepEqual(validateBase('https://jira.corp:8443/', DC), { origin: 'https://jira.corp:8443', host: 'jira.corp', kind: 'datacenter', basePath: '' });
  assert.deepEqual(validateBase('https://jira.other/', DC), { origin: 'https://jira.other', host: 'jira.other', kind: 'datacenter', basePath: '' });
  assert.deepEqual(validateBase('https://jira.corp:8443/a/b-c_d.e~f/', DC), { origin: 'https://jira.corp:8443', host: 'jira.corp', kind: 'datacenter', basePath: '/a/b-c_d.e~f' });
  assert.equal(validateBase('https://jira.corp:8443/jira', DC).basePath, '/jira');
  refused('https://jira.corp:8443/a//b', DC, 'path not allowed');
  refused('https://jira.corp:8443/a/(b)', DC, 'path not allowed');
  refused('https://jira.corp:8443/a b', DC, 'whitespace, control or non-ASCII character');
});

test('Cloud: the host allowlist depends on the mode, and a site may be pinned at user level', () => {
  const allow = 'host is not on the Atlassian allowlist';
  assert.deepEqual(validateBase('https://api.atlassian.com/', { mode: 'scoped' }), { origin: 'https://api.atlassian.com', host: 'api.atlassian.com', kind: 'gateway', basePath: '' });
  assert.deepEqual(validateBase('https://acme.atlassian.net/', { mode: 'site-token' }), { origin: 'https://acme.atlassian.net', host: 'acme.atlassian.net', kind: 'site', basePath: '' });
  refused('https://acme.atlassian.net/', { mode: 'scoped' }, allow);
  refused('https://api.atlassian.com/', { mode: 'site-token' }, allow);
  refused('https://evil.example/', { mode: 'scoped' }, allow);
  refused('https://evil.example/', { mode: 'site-token' }, allow);
  refused('https://acme.atlassian.net.evil.example/', { mode: 'site-token' }, allow);
  refused('https://-acme.atlassian.net/', { mode: 'site-token' }, allow);
  // no mode: either the gateway or a site
  assert.equal(validateBase('https://api.atlassian.com/').kind, 'gateway');
  assert.equal(validateBase('https://acme.atlassian.net/').kind, 'site');
  assert.equal(validateBase('https://acme.atlassian.net/', { mode: 'bogus' } as unknown as ValidateOptions).kind, 'site');
  refused('https://evil.example/', {}, allow);
  refused('https://xn--acme-9ua.atlassian.net/', { mode: 'site-token' }, 'punycode (xn--) host label');
  refused('https://xn--acme-9ua.atlassian.net/', {}, 'punycode (xn--) host label');
  refused('https://acme.atlassian.net:8443/', { mode: 'site-token' }, 'non-default port');
  refused('https://api.atlassian.com:8443/', { mode: 'scoped' }, 'non-default port');
  refused('https://api.atlassian.com/rest', { mode: 'scoped' }, 'path not allowed');
  refused('https://acme.atlassian.net/rest', { mode: 'site-token' }, 'path not allowed');
  // pins
  const pin = 'site is not in the user-level site allowlist (PLANGRAPH_JIRA_SITES)';
  refused('https://acme.atlassian.net/', { mode: 'site-token', siteHosts: 'other.atlassian.net' }, pin);
  refused('https://acme.atlassian.net/', { siteHosts: ['other.atlassian.net'] }, pin);
  assert.equal(validateBase('https://acme.atlassian.net/', { mode: 'site-token', siteHosts: 'Acme.atlassian.net,other.atlassian.net' }).host, 'acme.atlassian.net');
  assert.equal(validateBase('https://acme.atlassian.net/', { mode: 'site-token', siteHosts: '' }).host, 'acme.atlassian.net');
  assert.equal(validateBase('https://api.atlassian.com/', { mode: 'scoped', siteHosts: 'other.atlassian.net' }).kind, 'gateway');
  assert.equal(validateBase('https://api.atlassian.com/', { siteHosts: 'other.atlassian.net' }).kind, 'gateway');
});
