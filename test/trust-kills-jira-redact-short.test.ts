// lib/jira/redact.ts with ONLY a short raw token registered (12 to 15 characters, no window): it is found in any case, and only whole.
// A file of its own because the registry is process-wide.
import './helpers/runaway.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSecret, redact } from '../lib/jira/redact.ts';

test('a short raw token alone is still found in any case', () => {
  registerSecret({ raw: 'OnlyShort-1234' }); // 14 characters
  assert.equal(redact('x onlyshort-1234 y'), 'x [redacted] y');
  assert.equal(redact('x ONLYSHORT-1234 y'), 'x [redacted] y');
  assert.equal(redact('x onlyshort-123 y'), 'x onlyshort-123 y');
  assert.equal(redact('x nothing here y'), 'x nothing here y');
});
