# Forecast (lib/forecast.ts)

Schedule-risk forecaster for small teams. Every output is tagged `REFUSED | PRIOR-ONLY | PROVISIONAL | CALIBRATED` and says
"model-conditional, not a prediction". Tests: `node --test test/forecast.test.ts`.

## Inputs
- `history.jsonl`, one record per completed sprint: `{sprint, planned, done, added, carried}` points; optional `team`, `length`. `done:null` = no actuals. `parseHistory(text)` -> `{records, errors, warnings}`.
- `actuals.jsonl` (optional): `{key, sp, actual, owner, sprint}`. `parseActuals(text)`.
- A plan model (`lib/model.ts`) for plan-graph mode, or `remaining` points for flat mode. Config: `regime_changes: [sprint, ...]`, `caps`.

## Model
- Capacity: resample whole sprints (joint `(done, added, planned)`), circular block bootstrap, block 2 (1 when n>=20 and |lag-1 r| < 1.96/sqrt(n)). Deviation from plain moving blocks: blocks wrap, so each sprint has equal marginal probability. Flat: `R_{t+1} = max(0, R_t - D_t + A_t)`, finish = first t with R=0 (cap 60 sprints = "never").
- Plan graph (`simulatePlan`): the original greedy scheduler (owners, dependencies, strict handoff, per-person capacity). Mode `capacity` (default): delivery ratio `m_t = max(0.1, max(0, D_t - A_t)/P_t)` from a resampled sprint, ticket size `sp/m` in the sprint it lands in. Mode `ticket` (auto when >= 15 actuals): `m_t = max(0.1, 1 - A_t/P_t)` plus noise `exp(mu_c + b_person + g_sprint + e)`. Never both: delivery ratios already contain estimation error (double counting). Not modelled: partial progress/carry-over of a ticket, hiring, holidays.
- Ticket noise `y = ln(actual/sp)`: size classes S (sp<=2), M (<=5), L. Level `class` needs >= 15 pooled pairs and >= 3 per present class; `pooled` needs >= 5; else labelled PRIOR (mu +0.1, sigma 0.4: assumptions, planning fallacy). Partial pooling `mu_c = (n_c ybar_c + 5 mu_pool)/(n_c + 5)`; below 15 pairs `mu_pool = (N ybar + 5*0.1)/(N+5)` and sigma >= 0.25. No `-sigma^2/2` shift: draw `exp(mu_c + noise)`.
- Variance components by pair moments: `s_p^2` = mean `r_a r_b` over pairs sharing person only, `s_s^2` same for sprint only, total = mean `r^2`, `s_e^2` = total - s_p^2 - s_s^2 (floors 0). Weight `G/(G+4)` on data for G persons (or sprints), rest on prior sd 0.1; sd capped 0.5. Centring by the grand mean biases s_p^2, s_s^2 by about `-(s_p^2/G + s_s^2/S)` (measured: does not vanish with N).
- Correlation matters: for N balanced tickets, `Var(sum y) = N sig2 + N(N/P-1) s_p^2 + N(N/S-1) s_s^2`; an independent model with the same marginal variance gives `N sig2` (understates by `1 + [(N/P-1)s_p^2 + (N/S-1)s_s^2]/sig2`; tested).

## Gate (thresholds are recommendations, tuned on the synthetic runs below)
n = completed sprints with actuals after regime truncation. n<5 REFUSED (plan size only, no probability). 5<=n<10 PRIOR-ONLY (ranges from leave-one-sprint-out +-10 points, rounded to 10; P50/P80 only). 10<=n<20 PROVISIONAL. n>=20 CALIBRATED only if the rolling-origin backtest has >= 10 origins, the Clopper-Pearson 95% interval of the 10-90 interval coverage contains 0.8, and the model beats the best baseline (iid bootstrap, last-6 Gaussian, naive planned==done) on mean CRPS or mean pinball; else PROVISIONAL. One level down when > 30% of records lack `done`, or the mean of the last 3 sprints moved > 30% (Welch |t| > 3, needs n>=8). Regime change (team size, sprint length, `regime_changes`): history is truncated at the latest change, so a change in the last 3 sprints usually refuses.
Display: probabilities rounded to 5 points (10 below n=20), `<5%`/`>95%` (`<10%`/`>90%`) instead of tails, P90 only n>=10, P95 only n>=30, no P99. Runs >= 2000 (default 4000); result carries per-probability Monte Carlo SE (<= 0.5/sqrt(runs) = 0.8 points at 4000).

## Evaluation
`backtest(history, {horizon, minTrain=3, runs})`: expanding window, train on sprints before the origin only; target = points done over the next `horizon` sprints; reports CRPS (`E|X-y| - 0.5E|X-X'|`), pinball (tau .1,.5,.8,.9), PIT (mid-rank), 10-90 coverage with exact Clopper-Pearson (`betaQuantile` of the regularized incomplete beta, Lanczos lgamma + Lentz continued fraction, unit tested against closed forms, a binomial-tail identity and the published 7/9 interval 0.400-0.972), and, for horizon 1, Brier of "committed set finished" vs climatology and naive. `conformalQuantile(scores, alpha)`: index `ceil((n+1)(1-alpha))`, infinite when it exceeds n. Only the split-conformal quantile is implemented; it is not applied to results. Small-sample note: the correction is exactly the Beta law (coverage ~ Beta(index, n+1-index)); flag it when it exceeds 25% of interval width instead of widening silently (not wired).

## Measured, synthetic ground truth (300 replicates unless stated)
Coverage of the nominal 80% (q10-q90) next-sprint interval from the iid bootstrap, iid N(40,6), exact conditional coverage averaged over replicates:

| n | 5 | 8 | 10 | 15 | 20 | 30 | 50 |
|---|---|---|---|---|---|---|---|
| coverage | 0.670 | 0.772 | 0.721 | 0.763 | 0.754 | 0.774 | 0.789 |

Jagged by design: for n<=10 the interval is [min,max] and coverage is exactly (n-1)/(n+1). The gap to 0.80 is 13 points at n=5, 8 at n=10, 5 at n=20, 1 at n=50. Backtest as the gate sees it (60 replicates, pooled over origins, includes small-train origins): iid n=40 coverage 0.744, AR(1) phi=.6 n=40 0.710; the CP interval contains 0.8 in 56/60 and 44/60; gate passed 33/60 and 23/60. At n=20 iid: passed 30/60. The gate is therefore weakly discriminating: it mostly screens out gross miscalibration and the "no better than a baseline" case, and a pass is not proof of calibration.
AR(1), n=30, mean CRPS of 4-sprint totals (iid / block 2): phi=0 7.03/7.00, phi=.3 8.75/8.66, phi=.6 10.80/10.54 (block 2 wins by 2%; most of the AR(1) dependence is not captured by block 2).

## Honest limits
- Tail probabilities are unprovable with 10-20 sprints: a 95% claim needs ~hundreds of independent outcomes to check; with 10-20 backtest origins the CP interval for coverage spans about +-25 points.
- Everything is conditional on stationarity of throughput and on the sprint history being representative; a regime the history never saw is invisible.
- Bootstrap intervals under-cover at small n (table above); no inflation is applied (documented gap, not corrected).
- The prior (mu +0.1, sigma 0.4, s_p = s_s = 0.1) is an assumption, not a measurement; thresholds (15, 3, 30%, 25%, 0.25) are recommendations.
