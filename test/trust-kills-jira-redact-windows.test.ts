// lib/jira/redact.ts with ONLY a windowed raw token registered (no short raw token): the scan must not be skipped for want of short tokens.
// A file of its own because the registry is process-wide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, redact } from '../lib/jira/redact.ts';

test('a windowed raw token alone is still found in any case', () => {
  const tok = 'OnlyWindowsToken-9a8b7c6d5e4f';
  registerSecret({ raw: tok });
  assert.equal(redact(`x ${tok.toLowerCase()} y`), 'x [redacted] y');
  assert.equal(redact(`x ${tok.toUpperCase().slice(3, 25)} y`), 'x [redacted] y');
  assert.equal(redact('x nothing here y'), 'x nothing here y');
});
