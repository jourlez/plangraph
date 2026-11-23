// The shipped tsconfig files hold the agreed flags (rulings R23 and R25). A table of expectations drives the check, and `checkConfig`
// is a pure helper with unit cases on in-memory objects showing that each mutated setting fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
type Config = { extends?: string; compilerOptions?: Record<string, unknown>; include?: string[] };
export interface Expect {
  name: string;
  isTrue?: string[]; // compilerOptions that must be exactly true
  notTrue?: string[]; // compilerOptions that must not be true (absent or false)
  extendsPath?: string; // the `extends` value
  includeDirs?: string[]; // each needs an include entry under that directory
  includeFiles?: string[]; // each must be an include entry
}

const FINAL_FLAGS = ['strict', 'noImplicitAny', 'exactOptionalPropertyTypes', 'noImplicitOverride', 'noFallthroughCasesInSwitch', 'verbatimModuleSyntax', 'erasableSyntaxOnly', 'allowImportingTsExtensions'];
export const TABLE: Expect[] = [
  { name: 'tsconfig.json', isTrue: [...FINAL_FLAGS, 'allowJs', 'checkJs'], notTrue: ['noUncheckedIndexedAccess', 'noPropertyAccessFromIndexSignature'], includeFiles: ['src/floor.js'] },
  { name: 'tsconfig.prod.json', isTrue: ['noUncheckedIndexedAccess'], notTrue: ['noPropertyAccessFromIndexSignature'], extendsPath: './tsconfig.json', includeDirs: ['lib', 'src', 'mcp'], includeFiles: ['src/floor.js'] },
];

/** The problems of one config against its expectation; empty when it conforms. */
export function checkConfig(cfg: Config, expect: Expect): string[] {
  const out: string[] = [], opts = cfg.compilerOptions ?? {}, include = cfg.include ?? [];
  for (const k of expect.isTrue ?? []) if (opts[k] !== true) out.push(`${expect.name}: ${k} must be true`);
  for (const k of expect.notTrue ?? []) if (opts[k] === true) out.push(`${expect.name}: ${k} must not be true`);
  if (expect.extendsPath !== undefined && cfg.extends !== expect.extendsPath) out.push(`${expect.name}: must extend ${expect.extendsPath}`);
  for (const d of expect.includeDirs ?? []) if (!include.some((i) => i.startsWith(`${d}/`))) out.push(`${expect.name}: include must cover ${d}`);
  for (const f of expect.includeFiles ?? []) if (!include.includes(f)) out.push(`${expect.name}: include must list ${f}`);
  return out;
}

const globToRegex = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
/** True when an include entry (exact path or glob) selects the file. */
export const included = (include: string[], file: string): boolean => include.some((i) => i === file || globToRegex(i).test(file));
/** The problems of the tracked plain-JavaScript sources: only src/floor.js may be in a tsconfig include. */
export function checkJsSources(tracked: string[], includes: Record<string, string[]>): string[] {
  const out: string[] = [], want = ['src/floor.js', 'workflows/audit.workflow.js'];
  if (tracked.slice().sort().join() !== want.join()) out.push(`tracked .js files must be ${want.join(', ')}; found ${tracked.join(', ')}`);
  for (const [name, inc] of Object.entries(includes)) for (const f of tracked) {
    const should = f === 'src/floor.js';
    if (included(inc, f) !== should) out.push(`${name}: ${f} must ${should ? '' : 'not '}be in the include`);
  }
  return out;
}

const read = (rel: string): Config => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as Config;

for (const e of TABLE) test(`${e.name} holds its expected flags and include`, () => assert.deepEqual(checkConfig(read(e.name), e), []));

test('src/floor.js is the only tracked .js source in a tsconfig include (R25)', () => {
  const tracked = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const includes = Object.fromEntries(TABLE.map((e) => [e.name, read(e.name).include ?? []]));
  assert.deepEqual(checkJsSources(tracked, includes), []);
});

test('checkConfig fails when each setting is mutated', () => {
  const good = (): Config & { compilerOptions: Record<string, unknown> } => ({ extends: './tsconfig.json', compilerOptions: { strict: true, allowJs: true, noUncheckedIndexedAccess: true }, include: ['lib/**/*.ts', 'src/floor.js'] });
  const e: Expect = { name: 'x', isTrue: ['strict', 'allowJs', 'noUncheckedIndexedAccess'], notTrue: ['noPropertyAccessFromIndexSignature'], extendsPath: './tsconfig.json', includeDirs: ['lib'], includeFiles: ['src/floor.js'] };
  assert.deepEqual(checkConfig(good(), e), []);
  for (const k of ['strict', 'allowJs', 'noUncheckedIndexedAccess']) {
    const off = good(); off.compilerOptions[k] = false;
    assert.deepEqual(checkConfig(off, e), [`x: ${k} must be true`]);
    delete off.compilerOptions[k];
    assert.deepEqual(checkConfig(off, e), [`x: ${k} must be true`]);
  }
  const on = good(); on.compilerOptions.noPropertyAccessFromIndexSignature = true;
  assert.deepEqual(checkConfig(on, e), ['x: noPropertyAccessFromIndexSignature must not be true']);
  assert.deepEqual(checkConfig({ ...good(), extends: './other.json' }, e), ['x: must extend ./tsconfig.json']);
  assert.deepEqual(checkConfig({ ...good(), include: ['src/floor.js'] }, e), ['x: include must cover lib']);
  assert.deepEqual(checkConfig({ ...good(), include: ['lib/**/*.ts'] }, e), ['x: include must list src/floor.js']);
});

test('checkJsSources fails on an extra tracked .js, a missing floor.js or a workflow in an include', () => {
  const tracked = ['src/floor.js', 'workflows/audit.workflow.js'];
  assert.deepEqual(checkJsSources(tracked, { a: ['**/*.ts', 'src/floor.js'] }), []);
  assert.equal(checkJsSources([...tracked, 'lib/x.js'], { a: ['src/floor.js'] }).length, 1);
  assert.deepEqual(checkJsSources(tracked, { a: ['**/*.ts'] }), ['a: src/floor.js must be in the include']);
  assert.deepEqual(checkJsSources(tracked, { a: ['src/floor.js', 'workflows/*.js'] }), ['a: workflows/audit.workflow.js must not be in the include']);
  assert.deepEqual(checkJsSources(tracked, { a: ['src/floor.js', '**/*.js'] }), ['a: workflows/audit.workflow.js must not be in the include']);
});
