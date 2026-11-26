// Behavior tests for lib/jira/credentials.ts and lib/jira/types.ts, written to kill the mutants of the trust-root run: the order of the credential
// sources, each refusal's exact message, the helper commands per platform, the per-host binding, and the real helper runner (a fake `op` on PATH,
// with its output cap). Helpers are doubles that record their calls; no real credential helper runs.
// NOT covered: the real 1Password and keychain helpers, and the helper timeout (no clock is waited on).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCredentials, getCredentialsFor, siteTag } from '../lib/jira/credentials.ts';
import { redact } from '../lib/jira/redact.ts';
import { AUTH_MODES, isAuthMode } from '../lib/jira/types.ts';
import type { JiraError } from '../lib/jira/error.ts';

const TOK = 'tok-credkills-0123456789';
const code = (c: string, msg?: string) => (e: JiraError) => e.code === c && (msg === undefined || e.message === msg);
const recorder = (answers: Record<string, string | Error> = {}) => {
  const calls: Array<[string, string[]]> = [];
  const exec = async (file: string, args: string[]) => { calls.push([file, args]); const a = answers[file]; if (a instanceof Error) throw a; if (a === undefined) throw new Error('missing'); return a; };
  return { calls, exec };
};
const NONE = 'no Jira credentials: set JIRA_EMAIL and JIRA_API_TOKEN, or JIRA_OP_REF, or store the token in the OS keychain (see docs/JIRA.md)';

test('auth modes: the table, the narrowing function', () => {
  assert.deepEqual({ ...AUTH_MODES }, { SCOPED: 'scoped', SITE_TOKEN: 'site-token', DATACENTER: 'datacenter' });
  assert.ok(Object.isFrozen(AUTH_MODES));
  for (const m of ['scoped', 'site-token', 'datacenter']) assert.equal(isAuthMode(m), true);
  for (const m of ['', 'Scoped', 'site', undefined, null, 5]) assert.equal(isAuthMode(m), false);
});

test('environment credentials: trimmed, token kept out of enumeration and JSON, source env', async () => {
  const c = await getCredentials({ env: { JIRA_EMAIL: '  ada@example.invalid ', JIRA_API_TOKEN: ` ${TOK}\n` }, platform: 'win32' });
  assert.equal(c.email, 'ada@example.invalid'); assert.equal(c.source, 'env'); assert.equal(c.token, TOK);
  assert.deepEqual(Object.keys(c), ['email', 'source']);
  assert.equal(JSON.stringify(c), '{"email":"ada@example.invalid","source":"env"}');
  assert.equal(Object.getOwnPropertyDescriptor(c, 'token')?.enumerable, false);
});

test('the email and the token are checked, with their own messages', async () => {
  for (const email of ['a b@c.d', 'a:b@c.d', '@c.d', 'a@', 'a@b@c', 'plain']) {
    await assert.rejects(() => getCredentials({ env: { JIRA_EMAIL: email, JIRA_API_TOKEN: TOK }, platform: 'win32' }), code('bad_credentials', 'JIRA_EMAIL is not an email address'), email);
  }
  assert.equal((await getCredentials({ env: { JIRA_EMAIL: 'a@b', JIRA_API_TOKEN: TOK }, platform: 'win32' })).email, 'a@b');
  for (const tok of ['short77', 'has space inside', 'café-token-0123456', 'tab\ttoken-0123456']) {
    await assert.rejects(() => getCredentials({ env: { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: tok }, platform: 'win32' }), code('bad_credentials', 'token from env is malformed (8+ printable characters, no spaces)'), tok);
  }
  assert.equal((await getCredentials({ env: { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: '12345678' }, platform: 'win32' })).token, '12345678');
  assert.equal((await getCredentials({ env: { JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: '~!~!~!~!' }, platform: 'win32' })).token, '~!~!~!~!');
});

test('a registered token is redacted afterwards, also as the Basic credential; a token alone registers no email form', async () => {
  const tok = 'REGISTERED-tok-9f8e7d6c5b4a', email = 'who@example.invalid';
  await getCredentials({ env: { JIRA_EMAIL: email, JIRA_API_TOKEN: tok }, platform: 'win32' });
  assert.equal(redact(`x ${tok} y`).includes(tok), false);
  const basic = Buffer.from(`${email}:${tok}`).toString('base64');
  assert.equal(redact(`Authorization: Basic ${basic}`).includes(basic), false);
});

test('a token alone: kept as a fallback while other sources are tried, returned last with no email', async () => {
  const none = recorder();
  const c = await getCredentials({ env: { JIRA_API_TOKEN: TOK }, exec: none.exec, platform: 'linux' });
  assert.equal(c.email, ''); assert.equal(c.source, 'env'); assert.equal(c.token, TOK);
  assert.deepEqual(none.calls, [['secret-tool', ['lookup', 'service', 'plangraph-jira']]], 'the keychain was still asked');
  const kc = recorder({ 'secret-tool': `kc@example.invalid:${TOK}-kc\n` });
  const d = await getCredentials({ env: { JIRA_API_TOKEN: TOK }, exec: kc.exec, platform: 'linux' });
  assert.equal(d.source, 'keychain'); assert.equal(d.email, 'kc@example.invalid'); assert.equal(d.token, `${TOK}-kc`);
});

test('no source at all is an exact no_credentials error, and win32 runs no helper', async () => {
  const r = recorder();
  await assert.rejects(() => getCredentials({ env: {}, exec: r.exec, platform: 'win32' }), code('no_credentials', NONE));
  assert.deepEqual(r.calls, []);
  await assert.rejects(() => getCredentials({ env: { JIRA_EMAIL: 'a@b.c' }, exec: r.exec, platform: 'win32' }), code('no_credentials', NONE));
});

test('keychain helpers per platform, with the service name', async () => {
  const mac = recorder({ security: `m@example.invalid:${TOK}\n` });
  const m = await getCredentials({ env: {}, exec: mac.exec, platform: 'darwin' });
  assert.deepEqual(mac.calls, [['security', ['find-generic-password', '-s', 'plangraph-jira', '-w']]]);
  assert.equal(m.source, 'keychain'); assert.equal(m.email, 'm@example.invalid');
  const lin = recorder({ 'secret-tool': `l@example.invalid:${TOK}` });
  await getCredentials({ env: {}, exec: lin.exec, platform: 'linux', names: { service: 'svc-x' } });
  assert.deepEqual(lin.calls, [['secret-tool', ['lookup', 'service', 'svc-x']]]);
  const failing = recorder({ security: new Error('not found') });
  await assert.rejects(() => getCredentials({ env: {}, exec: failing.exec, platform: 'darwin' }), code('no_credentials', NONE));
  const empty = recorder({ security: '   \n' });
  await assert.rejects(() => getCredentials({ env: {}, exec: empty.exec, platform: 'darwin' }), code('bad_credentials', 'keychain returned an empty or multi-line secret'));
  const multi = recorder({ security: `${TOK}\nsecond` });
  await assert.rejects(() => getCredentials({ env: {}, exec: multi.exec, platform: 'darwin' }), code('bad_credentials', 'keychain returned an empty or multi-line secret'));
});

test('a secret is "token" or "email:token": the first colon splits only when it is not first, and the env email fills in', async () => {
  const run = (secret: string, env: Record<string, string> = {}) => getCredentials({ env, exec: recorder({ security: secret }).exec, platform: 'darwin' });
  const a = await run('a@b.c:tok:with:colons-0123'); assert.equal(a.email, 'a@b.c'); assert.equal(a.token, 'tok:with:colons-0123');
  const b = await run(`:${TOK}`, { JIRA_EMAIL: 'env@b.c' }); assert.equal(b.email, 'env@b.c'); assert.equal(b.token, `:${TOK}`);
  const c = await run(TOK, { JIRA_EMAIL: 'env@b.c' }); assert.equal(c.email, 'env@b.c'); assert.equal(c.token, TOK); assert.equal(c.source, 'keychain');
  const d = await run(`  ${TOK}  `); assert.equal(d.email, ''); assert.equal(d.token, TOK);
  await assert.rejects(() => run('bad email@b.c:' + TOK), code('bad_credentials', 'JIRA_EMAIL is not an email address'));
});

test('the 1Password reference: shape check, helper call, failure message, and the result', async () => {
  const good = recorder({ op: `op@example.invalid:${TOK}\n` });
  const c = await getCredentials({ env: { JIRA_OP_REF: 'op://vault/item/field' }, exec: good.exec, platform: 'win32' });
  assert.deepEqual(good.calls, [['op', ['read', 'op://vault/item/field']]]); assert.equal(c.source, 'op'); assert.equal(c.email, 'op@example.invalid');
  for (const ref of ['vault/item', 'op://', 'op://a b', 'http://x/y', ' op://x/y/z']) {
    if (ref.trim() === ref || ref.startsWith(' ')) await assert.rejects(() => getCredentials({ env: { JIRA_OP_REF: ref }, exec: good.exec, platform: 'win32' }), code('bad_credentials', 'JIRA_OP_REF must look like op://vault/item/field'), ref);
  }
  await assert.rejects(() => getCredentials({ env: {}, exec: good.exec, platform: 'win32', names: { opRef: 'nope' } }), code('bad_credentials', 'op_ref must look like op://vault/item/field'));
  const bad = recorder({ op: new Error('signed out') });
  await assert.rejects(() => getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f' }, exec: bad.exec, platform: 'win32' }), code('no_credentials', 'op read failed for JIRA_OP_REF (is the 1Password CLI signed in?)'));
  await assert.rejects(() => getCredentials({ env: {}, exec: bad.exec, platform: 'win32', names: { opRef: 'op://v/i/f' } }), code('no_credentials', 'op read failed for op_ref (is the 1Password CLI signed in?)'));
  const multi = recorder({ op: 'a\nb' });
  await assert.rejects(() => getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f' }, exec: multi.exec, platform: 'win32' }), code('bad_credentials', 'op returned an empty or multi-line secret'));
  const names = await getCredentials({ env: { MY_OP: 'op://v/i/f' }, exec: good.exec, platform: 'win32', names: { opVar: 'MY_OP' } });
  assert.equal(names.source, 'op');
  const named = await getCredentials({ env: { JIRA_OP_REF: 'op://ignored/x/y' }, exec: good.exec, platform: 'win32', names: { opRef: 'op://explicit/x/y' } });
  assert.equal(good.calls.at(-1)?.[1]?.[1], 'op://explicit/x/y'); assert.equal(named.source, 'op');
  // an op secret without an email falls back to the environment's email, or stays token-only
  const tokOnly = recorder({ op: TOK });
  assert.equal((await getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f', JIRA_EMAIL: 'e@b.c' }, exec: tokOnly.exec, platform: 'win32' })).email, 'e@b.c');
  assert.equal((await getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f' }, exec: tokOnly.exec, platform: 'win32' })).source, 'op');
});

test('custom variable names are honoured', async () => {
  const c = await getCredentials({ env: { E: 'x@y.z', T: TOK, JIRA_EMAIL: 'wrong@y.z', JIRA_API_TOKEN: 'wrong-wrong-wrong' }, platform: 'win32', names: { emailVar: 'E', tokenVar: 'T' } });
  assert.equal(c.email, 'x@y.z'); assert.equal(c.token, TOK);
});

test('siteTag: the host without .atlassian.net, upper-cased, other characters as underscores', () => {
  assert.equal(siteTag('Acme.Atlassian.NET'), 'ACME');
  assert.equal(siteTag('jira.corp:8443'), 'JIRA_CORP_8443');
  assert.equal(siteTag('my-co.atlassian.net'), 'MY_CO');
  assert.equal(siteTag('a.atlassian.netx'), 'A_ATLASSIAN_NETX');
});

test('per-host credentials: registry entry first, then the convention, generic only when allowed', async () => {
  const H = 'acme.atlassian.net';
  const env = { JIRA_EMAIL__ACME: 'host@example.invalid', JIRA_API_TOKEN__ACME: TOK, JIRA_EMAIL: 'gen@example.invalid', JIRA_API_TOKEN: `${TOK}-generic` };
  const conv = await getCredentialsFor('ACME.atlassian.net', { env, platform: 'win32' });
  assert.equal(conv.source, `host ${H}:env`); assert.equal(conv.email, 'host@example.invalid'); assert.equal(conv.token, TOK);
  const reg = await getCredentialsFor(H, { env: { ...env, MY_E: 'reg@example.invalid', MY_T: `${TOK}-reg` }, platform: 'win32', registry: { [H]: { email_env: 'MY_E', token_env: 'MY_T' } } });
  assert.equal(reg.source, `registry ${H}:env`); assert.equal(reg.email, 'reg@example.invalid'); assert.equal(reg.token, `${TOK}-reg`);
  // an entry that finds nothing never falls back to the convention or the generic set
  await assert.rejects(() => getCredentialsFor(H, { env, platform: 'win32', registry: { [H]: { token_env: 'MISSING' } }, allowGeneric: true }), code('no_credentials', `registry entry for ${H} found no credentials (check the env var, op ref or keychain item it names)`));
  await assert.rejects(() => getCredentialsFor(H, { env, platform: 'win32', registry: { [H]: {} }, allowGeneric: true }), code('no_credentials', `registry entry for ${H} found no credentials (check the env var, op ref or keychain item it names)`));
  // other failures of an entry pass through unchanged
  await assert.rejects(() => getCredentialsFor(H, { env: { T2: 'short' }, platform: 'win32', registry: { [H]: { token_env: 'T2' } } }), code('bad_credentials', 'token from env is malformed (8+ printable characters, no spaces)'));
  // generic: refused unless allowed; the message names the host and tag
  const gen = { JIRA_EMAIL: 'gen@example.invalid', JIRA_API_TOKEN: `${TOK}-generic` };
  await assert.rejects(() => getCredentialsFor(H, { env: gen, platform: 'win32' }), code('no_credentials', `no credentials bound to ${H}: add it to ~/.config/plangraph/jira-sites.json, or set JIRA_EMAIL__ACME and JIRA_API_TOKEN__ACME, or store a keychain item named plangraph-jira:${H}; generic JIRA_* credentials are never sent to an unpinned site (see docs/JIRA.md)`));
  const g = await getCredentialsFor(H, { env: gen, platform: 'win32', allowGeneric: true });
  assert.equal(g.source, 'generic:env'); assert.equal(g.email, 'gen@example.invalid');
  await assert.rejects(() => getCredentialsFor(H, { env: {}, platform: 'win32', allowGeneric: true }), code('no_credentials', NONE));
  // a convention failure that is not "missing" passes through
  await assert.rejects(() => getCredentialsFor(H, { env: { JIRA_API_TOKEN__ACME: 'short', JIRA_EMAIL__ACME: 'a@b.c' }, platform: 'win32', allowGeneric: true }), code('bad_credentials'));
  // an entry key that is only on the prototype is not an entry
  const proto = await getCredentialsFor('constructor', { env: { JIRA_EMAIL__CONSTRUCTOR: 'c@b.c', JIRA_API_TOKEN__CONSTRUCTOR: TOK }, platform: 'win32', registry: {} });
  assert.equal(proto.source, 'host constructor:env');
});

test('per-host keychain service and op reference names', async () => {
  const H = 'acme.atlassian.net';
  const kc = recorder({ security: `k@example.invalid:${TOK}` });
  const a = await getCredentialsFor(H, { env: {}, exec: kc.exec, platform: 'darwin' });
  assert.deepEqual(kc.calls, [['security', ['find-generic-password', '-s', `plangraph-jira:${H}`, '-w']]]); assert.equal(a.source, `host ${H}:keychain`);
  const kc2 = recorder({ security: `k@example.invalid:${TOK}` });
  const b = await getCredentialsFor(H, { env: {}, exec: kc2.exec, platform: 'darwin', registry: { [H]: { keychain: 'my-service' } } });
  assert.deepEqual(kc2.calls, [['security', ['find-generic-password', '-s', 'my-service', '-w']]]); assert.equal(b.source, `registry ${H}:keychain`);
  const kc3 = recorder({ security: `k@example.invalid:${TOK}` });
  await getCredentialsFor(H, { env: {}, exec: kc3.exec, platform: 'darwin', registry: { [H]: {} } }).catch(() => undefined);
  assert.deepEqual(kc3.calls, [['security', ['find-generic-password', '-s', `plangraph-jira:${H}`, '-w']]]);
  const op = recorder({ op: `o@example.invalid:${TOK}` });
  const c = await getCredentialsFor(H, { env: { JIRA_OP_REF__ACME: 'op://v/i/f' }, exec: op.exec, platform: 'win32' });
  assert.deepEqual(op.calls, [['op', ['read', 'op://v/i/f']]]); assert.equal(c.source, `host ${H}:op`);
  const op2 = recorder({ op: `o@example.invalid:${TOK}` });
  const d = await getCredentialsFor(H, { env: {}, exec: op2.exec, platform: 'win32', registry: { [H]: { op_ref: 'op://r/i/f' } } });
  assert.deepEqual(op2.calls, [['op', ['read', 'op://r/i/f']]]); assert.equal(d.source, `registry ${H}:op`);
});

// the real helper runner, with a fake `op` first on PATH (POSIX only)
const posix = process.platform !== 'win32';
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'credbin-'));
after(() => fs.rmSync(bin, { recursive: true, force: true }));
const fakeOp = (script: string) => { fs.writeFileSync(path.join(bin, 'op'), `#!/bin/sh\n${script}\n`, { mode: 0o755 }); };
const withPath = async <T>(fn: () => Promise<T>): Promise<T> => { const old = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${old}`; try { return await fn(); } finally { process.env.PATH = old; } };
const viaOp = () => getCredentials({ env: { JIRA_OP_REF: 'op://v/i/f' }, platform: 'win32' });

test('the default helper runner returns what the helper prints and runs it with its arguments', { skip: !posix }, async () => {
  fakeOp(`[ "$1" = read ] && [ "$2" = "op://v/i/f" ] && printf 'run@example.invalid:${TOK}'`);
  const c = await withPath(viaOp);
  assert.equal(c.email, 'run@example.invalid'); assert.equal(c.token, TOK); assert.equal(c.source, 'op');
});

test('a failing helper is "op read failed"; its stderr and exit are never shown', { skip: !posix }, async () => {
  fakeOp('echo secret-leak >&2; exit 3');
  await assert.rejects(() => withPath(viaOp), (e: JiraError) => e.code === 'no_credentials' && e.message === 'op read failed for JIRA_OP_REF (is the 1Password CLI signed in?)');
});

test('the default helper runner caps the output at 64 KiB', { skip: !posix }, async () => {
  const big = (n: number) => `head -c ${n} /dev/zero | tr '\\0' 'x'`;
  fakeOp(big(65536));
  assert.equal((await withPath(viaOp)).token.length, 65536);
  fakeOp(big(65537));
  await assert.rejects(() => withPath(viaOp), code('no_credentials'));
});
