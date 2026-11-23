// Property (g): lib/forecast.ts refusal gates over EVERY history length 0..25 (full) for several history shapes and both modes (flat
// backlog and plan graph), against the gate as docs/FORECAST.md states it (computed here independently):
//   n = sprints with a numeric `done`, after truncation at the latest regime change (team size or sprint length differs from the previous
//   record with actuals); n < 5 => REFUSED and no probability anywhere in the text; 5..9 => PRIOR-ONLY; 10..19 => PROVISIONAL; >= 20 =>
//   CALIBRATED only when the backtest passed, else PROVISIONAL; one level down when more than 30% of records lack `done` (the mean-shift
//   downgrade is allowed as one further level down on the `shift` shape only); a plan-graph loop or an empty plan refuses.
//   Display: probabilities on the 10-point grid below n=20 (`<10%`/`>90%` tails), the 5-point grid from 20 (`<5%`/`>95%`), PRIOR-ONLY shows
//   ranges on the 10-point grid, P90 only from n=10, P95 only from n=30, never P99; every non-refused text says "model-conditional, not a prediction".
// NOT covered: the Monte Carlo numbers themselves (calibration is measured in docs/FORECAST.md, not provable here), the mean-shift test's
// exact threshold, histories longer than 25, ticket-level noise mode (needs >= 15 actuals).
import assert from 'node:assert/strict';
import { forecast } from '../../lib/forecast.ts';
import { buildModel } from '../../lib/model.ts';
import type { Model } from '../../lib/model.ts';
import type { Level } from './enum.ts';

export interface Sprint { sprint: number; carried: number; planned: number; done: number | null; added: number; team?: number; length?: number }
type ShapeName = 'steady' | 'noisy' | 'lacking' | 'regime' | 'shift' | 'zero';
/** lib forecast result, as far as this file reads it */
interface Forecast { state: string; text: string; probs?: unknown; percentiles: Record<string, unknown>; backtest: { passed: boolean } }
interface Input { history: Sprint[]; runs: number; seed: number; remaining?: number; model?: Model }
interface FBound { lens: number; shapes: string[]; modes: string[]; runs: number; only?: number[] }
const SHAPES: Record<ShapeName, (i: number, n: number) => Omit<Sprint, 'sprint' | 'carried'>> = {
  steady: (i) => ({ planned: 22, done: 20 + (i % 3), added: 1 }),
  noisy: (i) => ({ planned: 25, done: 10 + ((i * 7) % 5) * 5, added: i % 2 }),
  lacking: (i) => ({ planned: 20, done: i % 2 ? null : 18, added: 0 }),
  regime: (i, n) => ({ planned: 20, done: 19, added: 0, team: i >= n - 2 ? 4 : 3 }),
  shift: (i, n) => ({ planned: 20, done: i >= n - 3 ? 40 : 18 + (i % 2), added: 0 }),
  zero: () => ({ planned: 10, done: 0, added: 0 }),
};
const history = (shape: ShapeName, n: number): Sprint[] => Array.from({ length: n }, (_, i) => ({ sprint: i + 1, carried: 0, ...SHAPES[shape](i, n) }));
// a probability as the text shows one: `by S7: ~40%`, a tail, a range, a percentile (a reason such as `50% of sprints lack actuals` is not)
const PROB = /by S\d|\bP\d\d\b|[~<>]\d+%|\d+-\d+%/;
const LEVELS = ['REFUSED', 'PRIOR-ONLY', 'PROVISIONAL', 'CALIBRATED'];

function oracleN(h: Sprint[]): { n: number; lack: boolean } {
  const use = h.filter((r) => typeof r.done === 'number');
  let cut = -Infinity;
  for (let i = 1; i < use.length; i++) if ((use[i].team !== undefined && use[i - 1].team !== undefined && use[i].team !== use[i - 1].team) || (use[i].length !== undefined && use[i - 1].length !== undefined && use[i].length !== use[i - 1].length)) cut = use[i].sprint;
  return { n: use.filter((r) => r.sprint >= cut).length, lack: h.length ? (h.length - use.length) / h.length > 0.3 : false };
}
const fail: (what: string, x: unknown) => never = (what, x) => assert.fail(`forecast: ${what}\n${JSON.stringify(x)}`);

function checkOne(shape: ShapeName, len: number, mode: string, runs: number): void {
  const h = history(shape, len), { n, lack } = oracleN(h);
  const inp: Input = { history: h, runs, seed: 7 };
  if (mode === 'flat') inp.remaining = 40;
  if (mode === 'graph' || mode === 'loop') inp.model = buildModel({ tickets: [{ key: 'T1', sp: 5, jira_status: 'To Do' }, { key: 'T2', sp: 8, jira_status: 'To Do' }], edges: [{ consumer: 'T2', producer: 'T1' }, ...(mode === 'loop' ? [{ consumer: 'T1', producer: 'T2' }] : [])], schedule: [{ key: 'T1', owner: 'Ana', sprint: len + 1 }, { key: 'T2', owner: 'Ana', sprint: len + 2 }], config: { caps: { default: 20 } } });
  const r = forecast(inp) as unknown as Forecast, /* lib/forecast.ts adds text and tokens after building the result and exports no result type yet */ x = () => ({ shape, len, mode, n, lack, state: r.state, text: r.text });
  if (mode === 'loop' || n < 5) {
    if (r.state !== 'REFUSED') fail('must refuse', x());
    if (PROB.test(r.text) || r.probs || r.percentiles) fail('a refusal carries a probability', x());
    if (!/no probability/.test(r.text)) fail('refusal text does not say so', x());
    return;
  }
  let max = n < 10 ? 1 : n < 20 ? 2 : r.backtest.passed ? 3 : 2;
  if (lack) max--;
  const lvl = LEVELS.indexOf(r.state), min = shape === 'shift' ? max - 1 : max;
  if (lvl > max || lvl < min) fail(`state ${r.state} outside the gate (expected level ${min}..${max})`, x());
  if (r.state === 'CALIBRATED' && (n < 20 || !r.backtest.passed)) fail('calibrated without the backtest gate', x());
  if (r.state === 'REFUSED') { if (PROB.test(r.text)) fail('refusal carries a probability', x()); return; }
  if (!r.text.includes('model-conditional, not a prediction')) fail('missing tag', x());
  const step = n < 20 ? 10 : 5;
  const body = r.text.replace(/\(backtest [^)]*\)/, '').replace(/\[[^\]]*\]$/, '');
  for (const m of body.matchAll(/(<|>|~)?(\d+)(?:-(\d+))?%/g)) {
    const [, pre, a, b] = m;
    if (b !== undefined) { if (r.state !== 'PRIOR-ONLY' || +a % 10 || +b % 10) fail(`range ${m[0]} off the 10-point grid or outside PRIOR-ONLY`, x()); continue; }
    if (r.state === 'PRIOR-ONLY') fail(`PRIOR-ONLY shows a point probability ${m[0]}`, x());
    if (pre === '<' && +a !== step) fail(`low tail ${m[0]} is not <${step}%`, x());
    if (pre === '>' && +a !== 100 - step) fail(`high tail ${m[0]} is not >${100 - step}%`, x());
    if (pre === '~' && (+a % step || +a < step || +a > 100 - step)) fail(`probability ${m[0]} is off the ${step}-point grid`, x());
  }
  const pk = Object.keys(r.percentiles);
  if (pk.includes('P90') !== n >= 10 || pk.includes('P95') !== n >= 30 || pk.includes('P99')) fail(`percentiles ${pk} wrong for n=${n}`, x());
}

export const BOUNDS: Record<Level, FBound> = { full: { lens: 26, shapes: Object.keys(SHAPES), modes: ['flat', 'graph', 'loop'], runs: 2000 }, quick: { lens: 26, shapes: ['steady'], modes: ['flat'], runs: 2000 } };

export function assureForecast(lvl: Level): { cases: number } {
  const B = BOUNDS[lvl], counts = { cases: 0 };
  for (const shape of B.shapes) for (const mode of B.modes) for (let len = 0; len < B.lens; len++) {
    if (B.only && !B.only.includes(len)) continue;
    checkOne(shape as ShapeName, len, mode, B.runs); /* BOUNDS.shapes lists keys of SHAPES */ counts.cases++;
  }
  return counts;
}
