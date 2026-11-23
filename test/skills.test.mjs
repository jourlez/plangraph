// Skill hygiene (Task 19): descriptions, read-only tools, no write flags, untrusted sentence, no overlap with superpowers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNTRUSTED_NOTICE } from '../lib/sanitize.mjs';

const root = path.resolve(import.meta.dirname, '..');
const names = fs.readdirSync(path.join(root, 'skills')).sort();
const load = (n) => {
  const t = fs.readFileSync(path.join(root, 'skills', n, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(t); assert.ok(m, `${n}: front matter`);
  const fm = {}; for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { fm, body: m[2], text: t };
};
const S = Object.fromEntries(names.map((n) => [n, load(n)]));

test('whatif and brain-report exist, and no review, planning or agent files overlap superpowers', () => {
  for (const n of ['whatif', 'brain-report']) assert.ok(names.includes(n), n);
  assert.ok(!fs.existsSync(path.join(root, 'agents', 'plan-reviewer.md')));
  for (const n of names) assert.ok(!/review|tdd|debug|writing-plans/i.test(n), `${n}: name overlaps superpowers`);
});

test('every skill has a name matching its directory and a description of at most 1024 characters', () => {
  for (const n of names) { assert.equal(S[n].fm.name, n); const d = S[n].fm.description || ''; assert.ok(d.length > 20 && d.length <= 1024, `${n}: ${d.length}`); }
});

test('descriptions begin with a capitalised verb and contain a Use when clause', () => {
  for (const n of names) {
    const d = S[n].fm.description; const w = d.split(' ')[0];
    assert.match(w, /^[A-Z][a-z]+$/, `${n}: first word "${w}"`);
    assert.ok(!/^(The|This|A|An|Use|Skill)$/.test(w), `${n}: not a verb phrase`);
    assert.match(d, /\bUse when\b/, `${n}: Use when`);
  }
});

test('allowed-tools are read-only brain patterns, never whatif, never a write flag', () => {
  for (const n of names) {
    const at = S[n].fm['allowed-tools']; assert.ok(at, n);
    for (const it of at.split(/\s*,\s*/).filter((x) => x.startsWith('Bash'))) {
      assert.match(it, /^Bash\(brain [a-z-]+(?::\*| --line|)\)$/, `${n}: ${it}`);
      assert.ok(!/whatif|write|apply|migrate|init|build|export|schedule-load|refs-update|learn|jira-pull/.test(it), `${n}: ${it} can write`);
    }
  }
});

test('no skill passes --run-checks, and no skill runs a --write command itself', () => {
  for (const n of names) {
    assert.ok(!S[n].text.includes('--run-checks'), n);
    if (n === 'whatif') {
      assert.match(S[n].body, /WITHOUT `--write`/); assert.match(S[n].body, /tell the owner the exact command/i); assert.match(S[n].body, /never run a command with `--write` yourself/i);
    }
  }
});

test('every skill carries the untrusted-data sentence', () => {
  for (const n of names) assert.ok(S[n].body.includes(UNTRUSTED_NOTICE), n);
});

test('brain-report proposes publishing and sends nothing; it names only commands that exist', () => {
  const b = S['brain-report'].body.replace(/\s+/g, ' ');
  assert.match(b, /never automatic/i); assert.match(b, /this skill never sends/i); assert.match(b, /`brain report` generates the report files/);
  assert.match(b, /propose the command to the owner/i); assert.match(b, /only after a yes/i);
  assert.ok(!/report/.test(S['brain-report'].fm['allowed-tools']), 'brain report writes files: never in allowed-tools');
  assert.ok(!/Task 22/.test(b), 'the placeholder about Task 22 is gone');
});

test('connector duplication is gone: only the router lists connector globs; allowed-tools of the other skills are untouched by the pointer', () => {
  for (const n of names) {
    const hasGlobList = (S[n].body.match(/`mcp__\*[A-Za-z_]+\*__\w+`/g) || []).length;
    if (n === 'brain') assert.ok(hasGlobList >= 6, 'router keeps the full block'); else assert.ok(hasGlobList <= 1, `${n}: connector glob list duplicated`);
    assert.ok(!/--write/.test(S[n].fm['allowed-tools']), `${n}: --write in allowed-tools`);
    assert.ok(!/\.wolf/.test(S[n].fm['allowed-tools']), `${n}: .wolf in allowed-tools`);
  }
});
