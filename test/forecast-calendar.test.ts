// Tests for the forecast calendar (lib/forecast.ts `sprints` input). Run: node --test test/forecast-calendar.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../lib/forecast.ts';

const hist = [30, 35, 38, 33, 36, 31, 34, 37, 32, 35, 36, 34].map((d, i) => ({ sprint: i + 1, planned: 40, done: d, added: 0, carried: Math.max(0, 40 - d) }));
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + 14 * n)).toISOString().slice(0, 10);
const dated = Array.from({ length: 80 }, (_, i) => ({ n: i + 1, end: day(i + 1) }));
const base = { history: hist, remaining: 120, seed: 3 };

test('every sprint dated: the text gains the end date of each percentile sprint', () => {
  const plain = forecast(base), r = forecast({ ...base, sprints: dated });
  assert.ok(r.text.startsWith(plain.text), 'the undated text is the prefix');
  const m = / \| dates (.*)$/.exec(r.text);
  assert.ok(m, r.text);
  const p50 = /P50 S(\d+)/.exec(plain.text);
  assert.ok(p50, plain.text);
  assert.ok((m[1] as string).includes(`P50 ${day(Number(p50[1]))}`), m[1]);
});

test('one undated sprint: byte-identical to the forecast without sprints', () => {
  const plain = forecast(base);
  assert.equal(forecast({ ...base, sprints: dated.map((x, i) => (i === 5 ? { n: x.n } : x)) }).text, plain.text);
  assert.equal(forecast({ ...base, sprints: dated.map((x, i) => (i === 5 ? { n: x.n, end: '2026-02-30' } : x)) }).text, plain.text);
});

test('no sprints: byte-identical, and a refused forecast gets no calendar', () => {
  const plain = forecast(base);
  assert.equal(forecast({ ...base, sprints: [] }).text, plain.text);
  assert.equal(forecast({ ...base, sprints: undefined }).text, plain.text);
  const short = { history: hist.slice(0, 3), remaining: 120 };
  assert.equal(forecast({ ...short, sprints: dated }).text, forecast(short).text);
});

test('state and n are the same with or without dates (the report tag reads only these)', () => {
  const a = forecast(base), b = forecast({ ...base, sprints: dated });
  assert.equal(b.state, a.state); assert.equal(b.n, a.n);
});
