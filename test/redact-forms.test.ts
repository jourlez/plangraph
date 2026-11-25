// Redaction of the case-changed and partial forms of a registered API token (decision D11). The raw token is matched case-insensitively
// (ASCII letters only, so offsets never move) and through any 16-character substring; a raw token of 12 to 15 characters is matched
// case-insensitively as a whole. Derived forms (base64, hex, percent, the Basic credential) are still matched whole only, never by window.
// Secrets are registered the way the product registers them: through getCredentials (finishCreds) and makeClient.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCredentials, makeClient, redact } from '../lib/jira.ts';

const EMAIL = 'someone.long.name@example.test'; // 30 bytes: the first 40 base64 characters of the Basic credential cover only the e-mail
const TOKEN = 'qZ7mK2pX9vR4tL8nW3jH6cF1bD5gS0yEuA2oIeQx'; // synthetic, 40 characters, mixed case, no Atlassian prefix
const SHORT = 'Rk4pQ9zW2mXa'; // synthetic, 12 characters
const CLIENT_TOKEN = 'Hn3VbQ8sLp0TzK5wYc7RdM1fJx9GaE4u'; // synthetic, 32 characters, registered through makeClient only
const noNet = (() => { throw new Error('no network in this test'); }) as unknown as typeof fetch; // deliberate misuse: never called

const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const swap = (s: string) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
const mixed = (s: string) => [...s].map((c, i) => (i % 3 === 0 ? c.toUpperCase() : c.toLowerCase())).join('');
/** true when the output still holds any 16-character window of the secret, in any letter case */
const leaks = (out: string, secret: string) => { const f = fold(out), t = fold(secret); for (let i = 0; i + 16 <= t.length; i++) if (f.includes(t.slice(i, i + 16))) return true; return false; };

test.before(async () => {
  assert.equal(TOKEN.length, 40); assert.equal(SHORT.length, 12);
  await getCredentials({ env: { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN } });
  await getCredentials({ env: { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: SHORT } });
  makeClient({ baseConfig: { mode: 'scoped', cloudId: 'cloud-0001', baseUrl: 'https://api.atlassian.com' }, creds: { email: EMAIL, token: CLIENT_TOKEN }, fetchImpl: noNet });
});

test('a case-changed token is redacted', () => {
  for (const tok of [TOKEN, CLIENT_TOKEN]) for (const form of [tok.toUpperCase(), tok.toLowerCase(), swap(tok), mixed(tok)]) {
    assert.notEqual(form, tok);
    const out = redact(`before ${form} after`);
    assert.equal(out, 'before [redacted] after', `${form} -> ${out}`);
    assert.ok(!leaks(out, tok));
  }
  assert.equal(redact(`k="${TOKEN.toUpperCase()}"`), 'k="[redacted]"');
});

test('a 16-character fragment of the token is redacted, a 15-character one is not', () => {
  for (const tok of [TOKEN, CLIENT_TOKEN]) for (let i = 0; i + 16 <= tok.length; i++) {
    const f16 = tok.slice(i, i + 16);
    for (const form of [f16, f16.toUpperCase(), swap(f16)]) assert.equal(redact(`<${form}>`), '<[redacted]>', form);
    const f15 = tok.slice(i, i + 15);
    assert.equal(redact(`<${f15}>`), `<${f15}>`);
  }
  // overlapping and adjacent fragments merge into one redaction that covers every character of the token
  const out = redact(`x ${TOKEN.slice(0, 20)}${swap(TOKEN.slice(20))} y ${TOKEN.slice(3, 25)}z`);
  assert.equal(out, 'x [redacted] y [redacted]z');
});

test('a fragment inside an unregistered Atlassian-shaped token does not cut it short of the prefix pattern', () => {
  // the window matching runs after the existing patterns: run first, it would leave `ATATT3xUNREGISTERED` behind, too short for the pattern
  assert.equal(redact(`tok ATATT3xUNREGISTERED${TOKEN.slice(4, 20).toUpperCase()} end`), 'tok [redacted] end');
  assert.equal(redact(`Authorization: Basic ${swap(TOKEN)}`), 'Authorization: [redacted]');
});

test('a 12-character raw token is redacted case-insensitively as a whole', () => {
  for (const form of [SHORT, SHORT.toUpperCase(), SHORT.toLowerCase(), swap(SHORT)]) assert.equal(redact(`a ${form} b`), 'a [redacted] b', form);
  assert.equal(redact(`a${SHORT.toLowerCase()}b`), 'a[redacted]b');
  // no 16-character window exists for 12 to 15 characters: an 11-character fragment stays
  assert.equal(redact(`a ${SHORT.slice(0, 11)} b`), `a ${SHORT.slice(0, 11)} b`);
  assert.equal(redact(`a ${SHORT.slice(1).toUpperCase()} b`), `a ${SHORT.slice(1).toUpperCase()} b`);
});

test("the { raw } form still redacts the token's base64, hex and percent forms", () => {
  for (const tok of [TOKEN, SHORT, CLIENT_TOKEN]) {
    const b = Buffer.from(tok), hex = b.toString('hex');
    const forms = [b.toString('base64'), b.toString('base64url'), hex, hex.toUpperCase(), hex.replace(/../g, '%$&'), hex.toUpperCase().replace(/../g, '%$&'), encodeURIComponent(tok), JSON.stringify(tok).slice(1, -1)];
    for (const f of forms) { const out = redact(`[${f}]`); assert.equal(out, '[[redacted]]', `${f} -> ${out}`); }
    for (const pre of ['', 'a', 'ab']) { // inside a longer base64 blob at every offset modulo 3
      const blob = Buffer.from(`${pre}${tok}-and-more`).toString('base64'), out = redact(blob);
      assert.ok(out.includes('[redacted]'), blob);
      assert.ok(!Buffer.from(out.split('[redacted]').join(''), 'base64').toString('latin1').includes(tok.slice(3, -3)));
    }
  }
  assert.equal(redact(Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')), '[redacted]'); // the whole Basic credential
});

test('a non-ASCII character before a case-changed token does not shift the redaction', () => {
  assert.equal('İ'.toLowerCase().length, 2); // the trap: toLowerCase() changes the length
  for (const pre of ['İ', 'İİİ', 'ßİ ', 'Ω']) for (const form of [TOKEN.toUpperCase(), swap(TOKEN), TOKEN.slice(2, 19).toUpperCase(), SHORT.toLowerCase()]) {
    assert.equal(redact(`${pre}${form}!tail`), `${pre}[redacted]!tail`, `${pre}${form}`);
  }
});

test('fragments of derived forms are not widened', () => {
  const b64 = Buffer.from(TOKEN).toString('base64'), hex = Buffer.from(TOKEN).toString('hex');
  for (const w of [b64.slice(4, 20), b64.slice(8, 24), hex.slice(2, 18), hex.slice(10, 26).toUpperCase()]) {
    const text = `QUJDREVGR0hJSktM${w}TU5PUFFSU1RVVldY`; // inside unrelated base64
    assert.equal(redact(text), text, w);
    assert.equal(redact(w.toLowerCase()), w.toLowerCase());
  }
});

test('no 16-character window of the Basic credential is redacted unless it is a registered core', () => {
  for (const tok of [TOKEN, CLIENT_TOKEN]) {
    const basic = Buffer.from(`${EMAIL}:${tok}`).toString('base64');
    for (let i = 0; i + 16 <= 40; i++) { const w = basic.slice(i, i + 16); assert.equal(redact(`x ${w} y`), `x ${w} y`, w); } // e-mail bytes only
    assert.equal(redact(`x ${basic} y`), 'x [redacted] y');
  }
  const email64 = Buffer.from(EMAIL).toString('base64');
  assert.equal(redact(email64.toLowerCase()), email64.toLowerCase());
});

test('ordinary text that shares no 16-character window with a secret is unchanged', () => {
  const sentences = [
    'The planning service reads the backlog once a day and writes a snapshot next to the project files.',
    'Each ticket keeps its key, its summary, its status and the sprint it belongs to, nothing more.',
    'When two people edit the same plan, the later change wins and the earlier one is kept in the history.',
    'Long identifiers such as abcdefghijklmnopqrstuvwxyz0123456789 and ABCDEFGHIJKLMNOPQRSTUVWXYZ stay as they are.',
    'A forecast is only as good as the estimates behind it, so the report shows the spread, not one date.',
    'Mixed-case words like PlanGraph, OrTools, JavaScript and TypeScript are ordinary words, not secrets.',
  ];
  let english = '';
  for (let i = 0; english.length < 2048; i++) english += `${sentences[i % sentences.length]} `;
  assert.ok(english.length >= 2048);
  assert.equal(redact(english), english);
  const issue = JSON.stringify({
    key: 'PLAN-123', fields: {
      summary: 'Move the nightly import to the new scheduler', status: { name: 'In Progress' },
      assignee: { displayName: 'Sample Person', accountId: '5b10ac8d82e05b22cc7d4ef5' }, updated: '2026-11-24T09:15:00.000+0000',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check the qZ7mK2pX9vR4tL8 prefix handling and the hex 0123456789abcdef0123.' }] }] },
      issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: { key: 'PLAN-124' } }],
    },
  });
  assert.equal(redact(issue), issue);
  assert.equal(redact(TOKEN.slice(0, 15).toUpperCase()), TOKEN.slice(0, 15).toUpperCase()); // 15 characters in another case: still not a window
});
