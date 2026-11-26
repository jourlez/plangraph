// `identity propose|list` (read-only) and `identity-map REF PERSON` (writer) called through their `commands` export with a minimal fake ctx.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands as readCmds } from '../src/commands/identity.ts';
import { commands as writeCmds } from '../src/commands/identity-map.ts';
import { readIdentityMap } from '../lib/identity.ts';
import { PlangraphError } from '../src/errors.ts';

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const obs = (sys: string, assignee: string) => ({ sys, fields: JSON.stringify({ assignee }) });
function fixture(rows: object[] = [obs('jira:acme', 'Ana Lopez'), obs('jira:acme', 'ben'), obs('gh', 'Ana Lopez')]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-idcmd-'))); tmps.push(root);
  const dir = path.join(root, '.plangraph'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'people.jsonl'), '{"id":"ana"}\n{"id":"ben"}\n');
  const out: string[] = [], err: string[] = [];
  const ctx = { root, dir, flags: {}, env: {}, now: () => new Date('2026-11-26T00:00:00Z'),
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(s), outBlock: (l: string[]) => out.push(...l) },
    db: () => ({ older: false, all: (sql: string) => { assert.match(sql, /FROM obs/); return rows; } }) } as never;
  return { ctx, dir, out };
}
const call = (cmds: typeof readCmds, name: string, ctx: never, positionals: string[], values: object = {}) => (cmds[name] as { run: (c: never, a: never) => unknown }).run(ctx, { values, positionals } as never);

test('commands are declared: identity read-only, identity-map a writer', () => {
  assert.equal(readCmds.identity?.writes, 'none');
  assert.notEqual(writeCmds['identity-map']?.writes, 'none');
});
test('identity propose prints proposals and writes nothing; --sys filters', async () => {
  const f = fixture();
  assert.equal(await call(readCmds, 'identity', f.ctx, ['propose']), 0);
  const text = f.out.join('\n');
  assert.match(text, /jira:acme:Ana Lopez .*ana .*fuzzy .*first name/);
  assert.match(text, /jira:acme:ben .*ben .*exact/);
  assert.equal(fs.existsSync(path.join(f.dir, 'cache')), false);
  const g = fixture();
  await call(readCmds, 'identity', g.ctx, ['propose'], { sys: 'gh' });
  assert.doesNotMatch(g.out.join('\n'), /jira:acme/);
});
test('identity-map writes the map (0600); identity list shows it', async () => {
  const f = fixture();
  assert.equal(await call(writeCmds, 'identity-map', f.ctx, ['jira:acme:Ana Lopez', 'ana']), 0);
  assert.equal(fs.statSync(path.join(f.dir, 'cache/identities.json')).mode & 0o777, 0o600);
  assert.deepEqual(readIdentityMap(f.dir).byRef, { 'jira:acme:Ana Lopez': 'ana' });
  await call(readCmds, 'identity', f.ctx, ['list']);
  assert.match(f.out.join('\n'), /jira:acme:Ana Lopez .*ana/);
});
test('identity-map of an unknown person exits 2 and writes nothing', async () => {
  const f = fixture();
  await assert.rejects(async () => call(writeCmds, 'identity-map', f.ctx, ['r1', 'nobody']), (e: unknown) => e instanceof PlangraphError && e.exitCode === 2);
  assert.equal(fs.existsSync(path.join(f.dir, 'cache/identities.json')), false);
});
test('identity with no or an unknown subcommand is a usage error', async () => {
  const f = fixture();
  await assert.rejects(async () => call(readCmds, 'identity', f.ctx, []), (e: unknown) => e instanceof PlangraphError && e.exitCode === 2);
  await assert.rejects(async () => call(readCmds, 'identity', f.ctx, ['nope']), (e: unknown) => e instanceof PlangraphError && e.exitCode === 2);
});
