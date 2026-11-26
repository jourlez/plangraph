// Timing file (Task 21A): the superpowers plan and ledger parsers stay linear on hostile lines. Each family is parsed at n and 4n characters
// in this process (min of 3); linear gives about 4x, a backtracking or quadratic regex 16x or worse. A ratio, never an absolute limit.
// The results on 1-2 MiB lines are checked in test/superpowers-ingest.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, parseLedger } from '../lib/integrations/superpowers.ts';
import { scaling } from './helpers/perf.ts';

const T1 = '\n### Task 1: x\n';
const FAMILIES: Record<string, (n: number) => unknown> = {
  h1Spaces: (n) => parsePlan(`# a${' '.repeat(n)}b${T1}`, 'p.md'),
  h1Hashes: (n) => parsePlan(`# a ${'#'.repeat(n)} x${T1}`, 'p.md'),
  h1Tabs: (n) => parsePlan(`# Widget${'\t'.repeat(n)}Implementation Plan${T1}`, 'p.md'),
  headingSpaces: (n) => parsePlan(`# P\n###${' '.repeat(n)}Task 1: x\n`, 'p.md'),
  consumes: (n) => parsePlan(`# P\n### Task 2: x\n**Interfaces:**\n- Consumes: Task${' '.repeat(n)}x\n`, 'p.md'),
  points: (n) => parsePlan(`# P\n### Task 1: x\n- Points: 1${' '.repeat(n)}x\n`, 'p.md'),
  comment: (n) => parsePlan(`# P\n<!--${'-'.repeat(n)}-->\n### Task 1: x\n`, 'p.md'),
  ledgerDots: (n) => parseLedger(`Task ${'1.'.repeat(n / 2)}`, 'l'),
  ledgerTabs: (n) => parseLedger(`Task${'\t'.repeat(n)}1: complete`, 'l'),
  ledgerId: (n) => parseLedger(`# SDD ledger \u2014 plan: a${' '.repeat(n)}b\n`, 'l'),
  ledgerParked: (n) => parseLedger(`Task 1: parked \u2014 a${' '.repeat(n)}x`, 'l'),
};

for (const [name, fn] of Object.entries(FAMILIES)) {
  test(`hostile ${name} lines parse in linear time (n vs 4n characters)`, () => {
    const s = scaling(fn, 1 << 17);
    assert.ok(s.ratio < s.maxRatio, `${name} scaling ratio ${s.ratio.toFixed(1)} (${s.small.toFixed(1)} ms at n, ${s.large.toFixed(1)} ms at 4n; linear ~4, quadratic ~16)`);
  });
}
