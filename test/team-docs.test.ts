// The docs a second teammate reads must name only commands and scripts that exist, and the skills that write must not be model-invocable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registry } from '../src/registry.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');
const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
const docs = ['docs/TEAM.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md'];

/** The command word of every inline-code span or `$ ` shell line that starts with `plangraph `. */
export const commandsIn = (text: string): string[] =>
  [...text.matchAll(/(?:^\$ |`)plangraph ([a-z][a-z0-9-]*)/gm)].map((m) => m[1] as string);
const scriptsIn = (text: string): string[] => [...text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1] as string);

test('docs/TEAM.md exists and covers the second-teammate path', () => {
  const t = read('docs/TEAM.md');
  for (const needle of ['--scope project', 'plangraph check', 'plangraph resolve', 'JIRA.md', '.gitattributes', 'plangraph.sqlite', 'v0.3.0', 'conflict']) {
    assert.ok(t.includes(needle), `TEAM.md does not mention ${needle}`);
  }
});

test('every `plangraph <command>` the docs name is a registered command', () => {
  let seen = 0;
  for (const f of docs) {
    for (const c of commandsIn(read(f))) {
      seen++;
      assert.ok(registry.has(c), `${f} names \`plangraph ${c}\`, which is not a command`);
    }
  }
  assert.ok(seen >= 10, 'the scan found almost no commands: the regex is broken');
});

test('every `npm run <script>` the docs name is defined in package.json', () => {
  let seen = 0;
  for (const f of docs) for (const s of scriptsIn(read(f))) { seen++; assert.ok(Object.hasOwn(scripts, s), `${f} names npm run ${s}, which package.json does not define`); }
  assert.ok(seen >= 3);
});

test('the scans catch a misspelled command and script', () => {
  assert.ok(commandsIn('run `plangraph doctr --fix`').some((c) => !registry.has(c)));
  assert.ok(scriptsIn('`npm run typechek`').some((s) => !Object.hasOwn(scripts, s)));
});

test('README: Windows unsupported and the Node box are in Requirements, before the table', () => {
  const t = read('README.md');
  const req = t.slice(t.indexOf('\n## Requirements'), t.indexOf('\n## Installation'));
  assert.ok(req.indexOf('Windows is not supported') > 0 && req.indexOf('Windows is not supported') < req.indexOf('| Requirement |'));
  assert.match(req, /Which Node, how to get it/);
  for (const w of ['nvm', 'fnm', '.node-version', '24.15']) assert.ok(req.includes(w), `Requirements lacks ${w}`);
});

test('SECURITY.md carries one honest response line and no timeline table', () => {
  const t = read('SECURITY.md');
  assert.match(t, /single maintainer/);
  assert.match(t, /private vulnerability reporting/i);
  assert.doesNotMatch(t, /\|\s*(days?|hours?)\s*\|/i);
});
test('SECURITY.md states the design limits of token redaction under "Limits you should know"', () => {
  const limits = read('SECURITY.md').split('## Limits you should know')[1]?.split(/\n## /)[0] ?? '';
  for (const re of [/Redaction of the Jira API token/, /case-changed piece of the token shorter than 16 characters/, /case-changed token shorter than 12 characters/, /case-changed derived form/, /percent-encoding or JSON escaping/]) assert.match(limits, re);
});

test('CHANGELOG: one [Unreleased] heading with the 0.3.0 Added section; history untouched in count', () => {
  const t = read('CHANGELOG.md');
  assert.equal(t.match(/^## \[Unreleased\]$/gm)?.length, 1);
  assert.match(t, /^### Added$/m);
  assert.ok(t.includes('docs/TEAM.md'));
  assert.ok(/^## 0\.2\.4$/m.test(t) && /^## 0\.2\.0$/m.test(t));
});

test('dependabot: labels, grouped updates, and no version ignored (every dependency follows the latest release)', () => {
  const t = read('.github/dependabot.yml');
  assert.match(t, /labels:\n\s+- dependencies/);
  assert.doesNotMatch(t, /^\s+ignore:/m);
  assert.match(t, /groups:/);
});

test('skills that write to Jira, plan data or the schedule are not model-invocable; read-only skills are', () => {
  const flag = (n: string): boolean => /^disable-model-invocation: true$/m.test((/^---\n([\s\S]*?)\n---/.exec(read(`skills/${n}/SKILL.md`)) as RegExpExecArray)[1] as string);
  for (const n of ['autopilot', 'audit', 'init']) assert.ok(flag(n), `skills/${n} must set disable-model-invocation: true`);
  // plan and onboard only write local plan files that git can revert, so the model may offer them
  for (const n of ['onboard', 'plan', 'plangraph', 'report', 'whatif']) assert.ok(!flag(n), `skills/${n} stays model-invocable`);
  for (const n of ['plangraph', 'report', 'whatif']) assert.ok(!flag(n), `skills/${n} is read-only and must stay invocable`);
});
