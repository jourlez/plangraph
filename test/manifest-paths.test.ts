// Every path a shipped manifest names must exist on disk: the plugin manifest, the hooks manifest and the MCP entry (plus .mcp.json when present).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const readJson = (rel: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));
const PLUGIN_ROOT = /\$\{CLAUDE_PLUGIN_ROOT\}\/?/g;
const TOP_DIRS = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name);
const PATH_KEYS = new Set(['skills', 'commands', 'agents', 'icon']); // every string under these keys is a path
const SCRIPT_EXT = /\.(ts|js|mjs)$/;

const normalize = (v: string): string => v.replace(PLUGIN_ROOT, '').replace(/^\.\//, '');
const looksLikePath = (v: string): boolean => v.includes('${CLAUDE_PLUGIN_ROOT}') || v.startsWith('./') || SCRIPT_EXT.test(v) || TOP_DIRS.some((d) => v === d || v.startsWith(`${d}/`));

/** Every repo-relative path a manifest names: strings under path keys, `command`/`args` strings that contain a slash, and any string
 * that starts with ./ or the plugin root variable, ends in .ts/.js/.mjs, or begins with a top-level repository directory. */
export function pathsIn(value: unknown, underPathKey = false, key = '', out: string[] = []): string[] {
  if (typeof value === 'string') {
    const keyed = underPathKey || ((key === 'command' || key === 'args') && value.includes('/') && !value.startsWith('-'));
    if (keyed || looksLikePath(value)) out.push(normalize(value));
  } else if (Array.isArray(value)) for (const v of value) pathsIn(v, underPathKey, key, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) pathsIn(v, underPathKey || PATH_KEYS.has(k), k, out);
  return out;
}

/** The problems of one manifest: one message per named path that does not exist under root. */
export function checkManifest(manifest: unknown, name: string, root: string = ROOT): string[] {
  const paths = pathsIn(manifest);
  const problems = paths.filter((p) => !fs.existsSync(path.join(root, p))).map((p) => `${name} names a missing path: ${p}`);
  return paths.length ? problems : [`${name} names no path at all`];
}

test('plugin manifest paths exist', () => assert.deepEqual(checkManifest(readJson('.claude-plugin/plugin.json'), 'plugin.json'), []));
test('hooks manifest paths exist', () => assert.deepEqual(checkManifest(readJson('hooks/hooks.json'), 'hooks.json'), []));

test('the MCP entry exists, the documented registration command names it, and .mcp.json paths exist when present', () => {
  assert.ok(exists('mcp/plangraph-mcp.ts'));
  const doc = fs.readFileSync(path.join(ROOT, 'docs/MCP.md'), 'utf8');
  const documented = [...doc.matchAll(/\bclaude mcp add plangraph -- node [^\n]*/g)].map((m) => m[0]);
  assert.ok(documented.length > 0, 'docs/MCP.md documents no `claude mcp add` command');
  for (const line of documented) {
    const m = line.match(/(?:\S*\/)?(mcp\/\S+?\.(?:ts|js|mjs))\b/);
    assert.ok(m, `no mcp/ file in: ${line}`);
    assert.ok(exists(m[1]), `docs/MCP.md registers a missing file: ${m[1]}`);
  }
  if (exists('.mcp.json')) assert.deepEqual(checkManifest(readJson('.mcp.json'), '.mcp.json'), []);
});

// each detection must fail on a mutated manifest (in-memory copies; the real manifests are never edited)
const messages = (m: unknown): string => checkManifest(m, 'mutant').join('|');
test('detects a bare path under a path key that does not exist', () => assert.match(messages({ skills: 'skills-gone/' }), /missing path: skills-gone\//));
test('detects a bare top-level-directory path that does not exist', () => assert.match(messages({ x: 'skills/gone-skill' }), /missing path: skills\/gone-skill/));
test('detects an mcpServers args entry naming a missing file', () => assert.match(messages({ mcpServers: { b: { command: 'node', args: ['mcp/gone.mjs'] } } }), /missing path: mcp\/gone\.mjs/));
test('detects a missing mcpServers command path', () => assert.match(messages({ mcpServers: { b: { command: 'bin/gone' } } }), /missing path: bin\/gone/));
test('detects a wrong extension on the hooks command arg', () => {
  const hooks = readJson('hooks/hooks.json');
  const mutant = JSON.parse(JSON.stringify(hooks).replace('/bin/plangraph"', '/bin/plangraph.mjs"'));
  assert.deepEqual(checkManifest(hooks, 'hooks.json'), []);
  assert.match(messages(mutant), /missing path: bin\/plangraph\.mjs/);
});
test('detects a wrong icon extension', () => assert.match(messages({ icon: './.claude-plugin/icon.jpg' }), /missing path: \.claude-plugin\/icon\.jpg/));
test('an empty manifest is a problem, not a pass', () => assert.match(messages({ name: 'x' }), /names no path/));
