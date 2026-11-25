# pumpfun-sharpe-sprint-entry

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Mardanyxyz/pumpfun-sharpe-sprint-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Mardanyxyz/pumpfun-sharpe-sprint-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A clean paper-trading bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty ($2 in USDC). Places go by hourly Sharpe ratio, so the bot optimises for many small, diversified, quick round trips — steady, controlled gains, not one lucky moonshot.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (hello, batch, done) and is graded by the kit's `grade-local`. No dependencies, no network, no clock, no unseeded randomness — fully deterministic, so two runs produce byte-identical action logs.

## Strategy

- **Entry — seasoned momentum on a pullback.** A curve becomes a buy only once it is at least ~24 minutes old (3600 slots), with strong broad buying behind it: net SOL inflow ≥ 1.0 SOL over the last 40 trades, ≥ 5 buy trades from ≥ 6 distinct buyers, price up 12–60% over the window, still rising on the most recent trades — but bought 3–10% below the window high, never at the top. Real SOL reserves must sit between 3 and 45 SOL. First buy 0.05 SOL, capped at 1% of the curve's real SOL reserve; at most 4 momentum positions open at once (the 5th slot is kept for probes).
- **Exits — tight and fast.** Stop loss −8% of cost, take profit +30%, trailing stop (arms at +5%, sells at 90% of peak value), max hold ~6 minutes (900 slots).
- **Guardrail pacing.** A pace guard tracks round trips of ≥ 0.01 SOL across distinct mints against the pace a 6-hour window needs for the 20-mint bar; if the bot falls behind, it opens tiny 0.02 SOL probe round trips on the most liquid curves and sells them as soon as they land.

## Dev-window results (kit `grade-local`, process driver)

| version | net PnL | Sharpe (hourly) | max drawdown | win rate | round trips | coins |
|---|---|---|---|---|---|---|
| v1 momentum | −2.551 SOL | — | 25.6% | 13.9% | 638 | 172 |
| v2 pullback + tight exits | −0.794 SOL | −0.551 | 8.1% | 14.6% | 370 | 119 |
| v3 trailing-stop only | −1.367 SOL | −0.814 | 15.8% | 30.6% | 229 | 118 |
| v4 seasoned curves (age ≥ 3600) | −0.175 SOL | −0.524 | 1.8% | 20.1% | 174 | 47 |
| v5 stricter inflow | −0.142 SOL | −0.445 | 1.5% | 20.8% | 159 | 45 |
| v6 exit tuning | −0.148 SOL | −0.459 | 1.6% | 20.9% | 158 | 45 |
| v7 (final) no fade exit | −0.137 SOL | −0.445 | 1.5% | 26.4% | 144 | 45 |
| v8 fresh rewrite (submitted) | −0.109 SOL | −0.432 | 1.3% | 11.6% | 155 | 38 |

Final (v8, the submitted entry): a fresh rewrite of the same strategy from the spec, graded in its own session — net PnL −0.109 SOL on the dev window, Sharpe −0.432/hr, max drawdown 1.3%, 155 round trips across 38 coins. Guardrails met with margin (38 distinct mints with ≥ 0.01 SOL round trips vs 20 required; max drawdown 1.3% vs 50% allowed). The dev window is a hard fee-grinder for every strategy the kit ships (its own pilot bots score −0.50 to −9.44 SOL there); this entry is the least-bad active strategy measured, with the lowest drawdown.

## Layout

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-identical from `sdk/ts/makefun-bot.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mardanyxyz&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
