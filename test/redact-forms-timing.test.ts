// Timing file (Task 21A rule: perf-helper users are timing files with ratio checks, never an absolute wall-clock limit). With 4 registered
// secrets, the case-insensitive and 16-character-window matching of redact() must stay linear in the text size: redacting 4 MB may take
// at most 6 times as long as redacting 1 MB, both measured in this process (a quadratic scan would take about 16 times as long).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCredentials, redact } from '../lib/jira.ts';
import { scaling } from './helpers/perf.ts';

const TOKENS = ['qZ7mK2pX9vR4tL8nW3jH6cF1bD5gS0yEuA2oIeQx', 'Hn3VbQ8sLp0TzK5wYc7RdM1fJx9GaE4u', 'Rk4pQ9zW2mXa', 'Tf6Ny1Lq8Vd3Ks0P'];
const MB = 1 << 20;

test('cost stays linear', async () => {
  for (const t of TOKENS) await getCredentials({ env: { JIRA_EMAIL: 'someone@example.test', JIRA_API_TOKEN: t } });
  // ordinary text with the tokens' leading characters sprinkled in (so the window prefilter fires), and one case-changed token per 64 KB
  const unit = 'The plan reads qZ7mK2pX9 and Hn3VbQ8sLp0 and Rk4pQ9 and Tf6Ny1Lq8V with ordinary words around them. ';
  let block = '';
  while (block.length < 64 * 1024) block += unit;
  block = `${block.slice(0, 64 * 1024 - 41)} ${TOKENS[0]?.toUpperCase()}`;
  const big = block.repeat(4 * MB / block.length + 1).slice(0, 4 * MB);
  const texts = new Map<number, string>([[MB >> 2, big.slice(0, MB >> 2)], [MB, big.slice(0, MB)], [4 * MB, big]]);
  const sample = redact(texts.get(MB) ?? '');
  assert.ok(sample.includes('[redacted]') && !sample.toLowerCase().includes((TOKENS[0] ?? '').toLowerCase().slice(0, 16)), 'the matching is engaged');
  const r = scaling((n) => redact(texts.get(n) ?? ''), MB, { reps: 2, maxRatio: 6 });
  assert.ok(r.ratio <= r.maxRatio, `4 MB took ${r.ratio.toFixed(2)} times as long as 1 MB (${r.small.toFixed(1)} ms, ${r.large.toFixed(1)} ms)`);
});
