// README truth checks: every claim here is compared with the code, the manifests or the CLI itself, so the README cannot drift silently.
// Covered: every `plangraph X` the README names (inline or in a code block) is a registered command; every relative link target exists; every
// in-page anchor matches a heading; the table of contents lists every section; the CI badge is exactly this repository's ci.yml badge;
// the install commands use the names in plugin.json and marketplace.json; the Node and Claude Code minimums equal package.json and
// plugin.json; the exit-code line is the one `plangraph explain` prints; every skill has a row in the Skills table; the userConfig option and
// its values are documented.
// NOT covered: that the copied command output still matches what the commands print today (it was copied from a synthetic fixture), the
// measured evaluation numbers (owner-run, data not in the repository), or how GitHub renders the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registry } from '../src/registry.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const readme = read('README.md');
const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
const market = JSON.parse(read('.claude-plugin/marketplace.json'));
const pkg = JSON.parse(read('package.json'));

/** GitHub's heading anchor: lowercase, punctuation dropped (hyphens and spaces kept), spaces to hyphens. */
export const slug = (h: string): string => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** The command names after `plangraph ` in inline code and in code-block lines. */
export function brainCommands(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`plangraph ([a-z][a-z-]*)/g)) out.push(m[1]);
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inBlock = !inBlock; continue; }
    if (!inBlock) continue;
    const m = /^\s*(?:\$\s+)?plangraph ([a-z][a-z-]*)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The headings of the README: lines inside a fenced block (such as the `## Plan questions` line `plangraph init` prints) are output, not headings. */
export function headingsOf(text: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inBlock = !inBlock; continue; }
    const m = !inBlock ? /^(#{2,4}) (.+)$/.exec(line) : null;
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}
const headings = () => headingsOf(readme);

test('every plangraph command the README names is a registered command, and the scan is not vacuous', () => {
  const cmds = brainCommands(readme);
  assert.ok(cmds.length > 50, `only ${cmds.length} plangraph commands found: the scan is broken`);
  for (const c of cmds) assert.ok(registry.has(c), `README names plangraph ${c}, which is not a registered command`);
  // the scanner itself: a planted unknown command in a block and inline is found
  assert.deepEqual(brainCommands('`plangraph nope x`\n```console\n$ plangraph zap\nplangraph zip --y\n```\nplangraph outside'), ['nope', 'zap', 'zip']);
});

test('a heading-shaped line inside a fenced block is output, not a heading', () => {
  assert.deepEqual(headingsOf('## A\n```text\n## B\n```\n### C\n'), [{ level: 2, text: 'A' }, { level: 3, text: 'C' }]);
});

test('every relative link target exists', () => {
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|#|mailto:)/.test(u));
  assert.ok(links.length > 10, 'too few relative links found');
  for (const l of links) assert.ok(fs.existsSync(path.join(root, l.split('#')[0])), `README links to ${l}, which does not exist`);
});

test('every in-page anchor matches a heading, and the table of contents lists every section', () => {
  const anchors = new Set(headings().map((h) => slug(h.text)));
  const used = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(used.length > 10);
  for (const a of used) assert.ok(anchors.has(a), `README links to #${a}, which is no heading`);
  const toc = readme.split('## Contents')[1].split('\n## ')[0];
  for (const h of headings().filter((x) => x.level === 2 && x.text !== 'Contents')) {
    assert.ok(toc.includes(`(#${slug(h.text)})`), `the table of contents lacks ${h.text}`);
  }
  assert.equal(slug('What it does, and what it does not do'), 'what-it-does-and-what-it-does-not-do');
  assert.equal(slug('`plangraph` and git'), 'plangraph-and-git');
});

test('the CI badge is exactly this repository\'s ci.yml badge, linked to the workflow page', () => {
  const repo = plugin.repository;
  assert.equal(repo, 'https://github.com/jourlez/plangraph');
  const badge = `[![ci](${repo}/actions/workflows/ci.yml/badge.svg)](${repo}/actions/workflows/ci.yml)`;
  assert.ok(readme.includes(badge), 'badge line missing or changed');
  assert.equal([...readme.matchAll(/badge\.svg/g)].length, 1, 'exactly one badge');
  assert.ok(fs.existsSync(path.join(root, '.github/workflows/ci.yml')));
});

test('install commands use the plugin and marketplace names from the manifests', () => {
  const id = `${plugin.name}@${market.name}`;
  assert.equal(market.plugins[0].name, plugin.name);
  const short = new URL(plugin.repository).pathname.slice(1);
  for (const cmd of [`/plugin marketplace add ${short}`, `/plugin install ${id}`, `claude plugin marketplace add ${short}`,
    `claude plugin install ${id}`, `claude plugin update ${id}`, `claude plugin uninstall ${id}`, `claude plugin marketplace update ${market.name}`,
    `claude plugin marketplace remove ${market.name}`, `/plugin configure ${id}`]) {
    assert.ok(readme.includes(cmd), `README lacks: ${cmd}`);
  }
  // no install line names another plugin or marketplace
  for (const m of readme.matchAll(/(?:plugin (?:install|update|uninstall|configure)) ([\w.-]+@[\w.-]+)/g)) assert.equal(m[1], id);
});

test('the Node and Claude Code minimums equal package.json and plugin.json', () => {
  const node = pkg.engines.node.replace(/^>=/, '');
  const cc = plugin.engines['claude-code'].replace(/^>=/, '');
  assert.ok(readme.includes(`\`engines.node\` is \`${pkg.engines.node}\``));
  assert.ok(readme.includes(`\`engines.claude-code\` is \`${plugin.engines['claude-code']}\``));
  assert.ok(readme.includes(`Node ${node} or newer`));
  assert.ok(readme.includes(`Claude Code ${cc} or newer`));
  assert.ok(readme.includes(`Node older than ${node}`));
});

test('the exit-code line is the one plangraph explain prints, and the table has one row per code', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-readme-data-')); // private data dir: the compile cache never goes to the real HOME
  const r = spawnSync(process.execPath, [path.join(root, 'bin/plangraph'), 'explain'], { encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PLUGIN_DATA: data } });
  fs.rmSync(data, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('exit: '));
  assert.ok(line && readme.includes(`\`${line}\``), `README does not quote: ${line}`);
  const sec = readme.split('### Exit codes')[1].split('\n## ')[0];
  const codes = [...line.matchAll(/(\d) /g)].map((m) => m[1]);
  assert.deepEqual(codes, ['0', '1', '2', '3', '4', '5']);
  for (const c of codes) assert.match(sec, new RegExp(`^\\| ${c} \\|`, 'm'), `exit code ${c} has no row`);
});

test('every skill has a row in the Skills table, and the card option is documented', () => {
  const sec = readme.split('## Skills')[1].split('\n## ')[0];
  const skills = fs.readdirSync(path.join(root, 'skills')).filter((n) => fs.existsSync(path.join(root, 'skills', n, 'SKILL.md')));
  assert.ok(skills.length >= 7);
  for (const n of skills) assert.match(sec, new RegExp(`^\\| \`${n}\` \\|`, 'm'), `no Skills row for ${n}`);
  const opt = plugin.userConfig.card;
  for (const v of opt.options) assert.ok(readme.includes(`\`${v}\``), `card value ${v} not documented`);
  assert.ok(readme.includes('--config card=auto') && readme.includes('PLANGRAPH_CARD=off') && readme.includes('prompt_hook') && readme.includes('PLANGRAPH_PROMPT_HOOK=on'));
  assert.ok(readme.includes('no token or accuracy benefit has been measured; the default injections were measured and found not to help on a small plan'.replace(/^n/, 'N')), 'the plain statement of the ruling');
});

test('the network hosts named in the README are exactly the ones plugin.json declares', () => {
  const sec = readme.split('## What runs on your machine')[1].split('\n## ')[0];
  for (const h of plugin.network.hosts) assert.ok(sec.includes(`\`${h.replace('*', '<site>')}\``), `host ${h} not named`);
  assert.match(sec, new RegExp(`declares the ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][plugin.network.hosts.length]} network hosts`));
});
