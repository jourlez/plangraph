// Coverage margin for src/commands/openitems.ts: every branch of --findings (file, stdin, each read error), --suggest-from-status and the
// close/reopen/register paths, driven through main() with an injected stdin so the result never depends on the terminal, CI or timing of the runner.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.ts';
import { makeContext } from '../src/context.ts';
import type { Stdin, ContextOptions } from '../src/context.ts';
import { fixture, copy, state, made, tmp, jl } from './helpers/cli-fixture.ts';

const ENV = { PATH: process.env.PATH, HOME: tmp(), PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', LC_ALL: 'C', TZ: 'UTC', PLANGRAPH_STRICT_OUT: '1' };
before(async () => { state.FIX = await fixture(); });
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const pipe = (text: string): Stdin => ({ isTTY: false, read: () => text });
const failing = (code: string | undefined): Stdin => ({ isTTY: false, read: () => { throw Object.assign(new Error('boom'), code === undefined ? {} : { code }); } });
async function oi(d: string, argv: string[], stdin: Stdin = pipe('')): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [], err: string[] = [];
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), raw: (s: string) => out.push(...String(s).split('\n')) };
  const flat = (): string[] => out.flatMap((l) => l.split('\n'));
  const prev = process.cwd();
  process.chdir(d);
  try {
    const code = await main(['open-items', ...argv], { io, env: ENV, cwd: d, makeContext: (o: ContextOptions) => makeContext({ ...o, stdin }) } as never);
    return { code, out: flat(), err };
  } finally { process.chdir(prev); }
}
const wolf = (d: string, text: string | null): void => { fs.mkdirSync(path.join(d, '.wolf'), { recursive: true }); if (text !== null) fs.writeFileSync(path.join(d, '.wolf', 'STATUS.md'), text); };

test('--findings refuses an empty path, a terminal on stdin and every coded stdin read error with its own message', async () => {
  const d = copy();
  assert.match((await oi(d, ['--findings', ''])).err.join('\n'), /--findings needs a file path/);
  const tty = await oi(d, ['--findings', '-'], { isTTY: true, read: () => 'never read' });
  assert.equal(tty.code, 2);
  assert.match(tty.err.join('\n'), /needs piped input, not a terminal/);
  const cases: Array<[string | undefined, RegExp]> = [['TOO_LARGE', /findings input too large \(limit 8 MiB\)/], ['NOT_A_FILE', /findings path is not a regular file/], ['TIMEOUT', /stdin timed out/], ['EIO', /cannot read stdin/], [undefined, /cannot read stdin/]];
  for (const [code, re] of cases) {
    const r = await oi(d, ['--findings', '-'], failing(code));
    assert.equal(r.code, 2, String(code));
    assert.match(r.err.join('\n'), re, String(code));
  }
});

test('--findings FILE names the file in each refusal: missing, a directory, too large', async () => {
  const d = copy();
  const missing = await oi(d, ['--findings', 'nope.jsonl']);
  assert.equal(missing.code, 2);
  assert.match(missing.err.join('\n'), /cannot read nope\.jsonl/);
  fs.mkdirSync(path.join(d, 'adir'));
  assert.match((await oi(d, ['--findings', 'adir'])).err.join('\n'), /findings path is not a regular file/);
  assert.match((await oi(d, ['--findings', 'big.jsonl'])).err.join('\n'), /findings file too large \(limit 8 MiB\)/);
});

test('--findings reads piped stdin and a file, reports a bad line on stderr and still lists the good ones', async () => {
  const d = copy();
  const rows = jl([{ key: 'T-5', kind: 'plan_text', text: 'late finding from stdin' }]) + 'not json\n';
  const r = await oi(d, ['--findings', '-', '--write'], pipe(rows));
  assert.equal(r.code, 0);
  assert.ok(r.err.some((l) => l.startsWith('findings error: stdin')), r.err.join('|'));
  assert.match(r.out.join('\n'), /open-items\.jsonl and OPEN-ITEMS\.md written \(\d+ open\)/);
  assert.match(fs.readFileSync(path.join(d, '.plangraph', 'OPEN-ITEMS.md'), 'utf8'), /late finding from stdin/);
  fs.writeFileSync(path.join(d, 'f.jsonl'), jl([{ key: 'T-6', kind: 'plan_text', text: 'late finding from a file' }]));
  const f = await oi(d, ['--findings', 'f.jsonl', '--write']);
  assert.equal(f.code, 0);
  assert.match(fs.readFileSync(path.join(d, '.plangraph', 'OPEN-ITEMS.md'), 'utf8'), /late finding from a file/);
});

test('close, reopen and register: argument checks, the write, and the refusals of the library', async () => {
  const d = copy();
  assert.match((await oi(d, ['--close', '--reopen', 'T-2', 'risk'])).err.join('\n'), /give only one of --close, --reopen and --register/);
  assert.match((await oi(d, ['--close', 'T-2'])).err.join('\n'), /--close needs KEY KIND/);
  assert.match((await oi(d, ['T-2', 'risk'])).err.join('\n'), /unexpected arguments/);
  const reg = await oi(d, ['--register', 'T-9', 'followup', '--owner', 'Ana', '--due', '3', '--text', 'check the docs']);
  assert.equal(reg.code, 0);
  assert.match(reg.out.join('\n'), /written \(\d+ open\)/);
  assert.match((await oi(d, ['--register', 'T-9', 'followup'])).err.join('\n'), /exists/);
  const bare = await oi(d, ['--register', 'T-8', 'followup']);
  assert.equal(bare.code, 0);
  assert.match(fs.readFileSync(path.join(d, '.plangraph', 'OPEN-ITEMS.md'), 'utf8'), /unassigned/);
  assert.equal((await oi(d, ['--close', 'T-9', 'followup', '--by', 'Ana', '--note', 'done', '--at', '2026-01-02'])).code, 0);
  assert.equal((await oi(d, ['--close', 'T-8', 'followup'])).code, 0);
  assert.match((await oi(d, ['--close', 'T-9', 'followup'])).err.join('\n'), /no open item T-9\|followup/);
  assert.equal((await oi(d, ['--reopen', 'T-9', 'followup'])).code, 0);
  assert.match((await oi(d, ['--reopen', 'T-9', 'followup'])).err.join('\n'), /is not closed/);
});

test('the compact view lists items in one fence, filters by --mine and widens its limit with -v', async () => {
  const d = copy();
  for (let i = 0; i < 7; i++) assert.equal((await oi(d, ['--register', `T-${i + 1}`, 'followup', '--owner', i < 6 ? 'Ana' : 'Ben', '--text', `item ${i}`])).code, 0);
  const short = await oi(d, []);
  assert.equal(short.code, 0);
  assert.ok(short.out.some((l) => /^\s*- /.test(l)), short.out.join('|'));
  assert.ok(short.out.some((l) => /more/.test(l)), short.out.join('|'));
  const all = await oi(d, ['-v']);
  assert.ok(!all.out.some((l) => /more/.test(l)));
  const mine = await oi(d, ['--mine', '--me', 'Ben', '--sprint', '1']);
  assert.equal(mine.code, 0);
  assert.ok(mine.out.join('\n').includes('item 6'));
  assert.ok(!mine.out.join('\n').includes('item 0'));
});

test('--suggest-from-status: refuses a combination, and says why there is nothing to suggest', async () => {
  const d = copy();
  assert.match((await oi(d, ['--suggest-from-status', '--write'])).err.join('\n'), /only prints/);
  assert.match((await oi(d, ['--suggest-from-status', '--close', 'T-1', 'x'])).err.join('\n'), /only prints/);
  assert.deepEqual((await oi(d, ['--suggest-from-status'])).out, ['no suggestions: .wolf/STATUS.md not found']);
  wolf(d, null);
  assert.deepEqual((await oi(d, ['--suggest-from-status'])).out, ['no suggestions: .wolf/STATUS.md not found']);
  fs.mkdirSync(path.join(d, '.wolf', 'STATUS.md'));
  assert.deepEqual((await oi(d, ['--suggest-from-status'])).out, ['warning: .wolf/STATUS.md is not a regular file: refused']);
  fs.rmSync(path.join(d, '.wolf', 'STATUS.md'), { recursive: true });
  wolf(d, '## Done\n- finished T-1\n\n## Next\n- plain text without a key\n');
  assert.deepEqual((await oi(d, ['--suggest-from-status'])).out, ['no suggestions: no open STATUS bullet names a ticket in the plan']);
});

test('--suggest-from-status prints one register line per ticket and kind, skips known open pairs, counts unknown keys, and caps at 20 unless -v', async () => {
  const d = copy();
  wolf(d, ['## Next', '- do T-1 soon', '- do T-1 soon', '- see T-2 and ZZ-9', '', '## Open decisions', '- pick for T-3', '', '## Blockers', '- stuck on T-4', '- gone ZZ-1 and QQ-2', '', '## Done', '- shipped T-5', ''].join('\n'));
  assert.equal((await oi(d, ['--register', 'T-2', 'followup'])).code, 0);
  const r = await oi(d, ['--suggest-from-status']);
  assert.equal(r.code, 0);
  const text = r.out.join('\n');
  assert.match(text, /suggested open items from \.wolf\/STATUS\.md/);
  assert.match(text, /--register T-1 followup /);
  assert.match(text, /--register T-3 decision /);
  assert.match(text, /--register T-4 blocker /);
  assert.ok(!/--register T-2 followup/.test(text), 'an open pair is not suggested again');
  assert.ok(!/T-5/.test(text), 'a done bullet is skipped');
  assert.equal((text.match(/--register T-1 followup/g) ?? []).length, 1, 'duplicate lines collapse');
  assert.ok(r.out.includes('skipped 3 keys not in the plan'), text);
  const one = copy();
  wolf(one, '## Next\n- T-1 and ZZ-9\n');
  assert.ok((await oi(one, ['--suggest-from-status'])).out.includes('skipped 1 key not in the plan'));
  const many = copy();
  const keys = Array.from({ length: 14 }, (_, i) => `T-${i + 1}`);
  wolf(many, `## Next\n${keys.map((k) => `- first ${k}`).join('\n')}\n\n## Blockers\n${keys.map((k) => `- then ${k}`).join('\n')}\n`);
  const capped = await oi(many, ['--suggest-from-status']);
  assert.ok(capped.out.includes('... 8 more (-v for all)'), capped.out.join('|'));
  const full = await oi(many, ['--suggest-from-status', '-v']);
  assert.ok(!full.out.some((l) => /more \(-v/.test(l)));
  assert.equal(full.out.join('\n').match(/--register /g)?.length, 28);
});

test('suggested lines quote a long, multibyte or quote-carrying text safely and keep it to 80 characters', async () => {
  const d = copy();
  const long = `T-1 it's ${'x'.repeat(90)}`;
  const astral = `T-2 ${'a'.repeat(74)}\u{1F600}${'b'.repeat(20)}`;
  wolf(d, `## Next\n- ${long}\n- ${astral}\n`);
  const r = await oi(d, ['--suggest-from-status']);
  const lines = r.out.filter((l) => l.includes('--register'));
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.includes(`'\\''`), lines[0]);
  for (const l of lines) assert.ok(l.endsWith('…\''), l);
  assert.ok(!/[\uD800-\uDBFF]'?$/.test(lines[1] as string), 'no lone surrogate before the ellipsis');
});
