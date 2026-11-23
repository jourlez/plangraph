// Docs must not name an npm script that package.json does not define, and CONTRIBUTING must not promise a fixed number of checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const docs = ['CONTRIBUTING.md', 'README.md', 'SECURITY.md', ...fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

/** @param {string} text @returns {string[]} script names after `npm run` */
export const namedScripts = (text) => [...text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);

test('every `npm run X` named in the docs exists in package.json scripts', () => {
  let seen = 0;
  for (const f of docs) {
    for (const s of namedScripts(fs.readFileSync(path.join(root, f), 'utf8'))) { seen++; assert.ok(Object.hasOwn(scripts, s), `${f} names npm run ${s}, which package.json does not define`); }
  }
  assert.ok(seen >= 2, 'the scan found no npm run references: the regex or the file list is broken');
});

test('the scan catches a misspelled script name', () => {
  assert.ok(namedScripts('run `npm run typechek` first').some((s) => !Object.hasOwn(scripts, s)));
});

test('CONTRIBUTING.md does not claim a fixed number of checks', () => {
  const t = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8');
  assert.ok(!/all (three|four|five|two) checks/i.test(t));
  assert.match(t, /Run these checks/);
});
