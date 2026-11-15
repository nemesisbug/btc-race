# btc-race

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/nemesisbug/btc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/nemesisbug/btc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

**BREAKWATER** — a BTC trading bot that sails only when the tide turns: it scouts a 60-minute breakout with a small position, tops up to full size when the 4-hour tide confirms it, trails the peak, and beaches the boat for the rest of the window after $10 of realised losses so a choppy sea can never sink it.

## Run it

```sh
node main.ts
```

`main.ts` speaks `agent-fun/bars-replay/v1` on stdin/stdout (Node 22, standard library only; the wire shim is vendored at `vendor/makefun-bars.ts`). It trades Coinbase Wrapped BTC (cbBTC) on 1-minute bars, long only, starting from $1,000 of paper money.

## The strategy

A full-size round trip costs ~26–42 bps (4 bps fee + 2 bps slippage + pool price impact) while a typical minute moves ~12 bps, so scalping inside the noise loses money on costs alone and chasing every hourly breakout buys spike tops. BREAKWATER trades rarely, and only on structure that survives the costs:

1. **Breakout** — the close breaks above the highest high of the last 60 minutes. A breakout is a fact about the tape, not a forecast: buyers just paid more than anyone did in the last hour.
2. **Tide** — the 4-hour (240-bar) return decides the size. Tide with us (return > −0.5%): full size. Tide against us: a 25% scout. The scout keeps the bot in the race, and if the tide turns while we hold it, we top the position up to full size instead of watching the move leave without us.
3. **Trail** — a trailing stop 0.5% below the highest close since entry lets a real move run and cuts a failed breakout after about one round trip of costs. A 4-hour maximum hold closes anything the trail has not.
4. **Beach** — a circuit breaker on realised PnL: once cumulative realised losses pass $10 (1% of the stake), the bot stops trading for the rest of the window. In a whipsaw regime its worst case is a small, bounded loss.

Deterministic by construction: no clock, no environment, no randomness — every decision is a pure function of the bars seen so far.

## Backtest (kit dev window, 24h)

Graded with the kit's own harness (`node cli/makefun.mjs grade-local --kit . --bot . --driver process`), two executions, byte-for-byte reproduced:

| | BREAKWATER | buy-and-hold | momentum | ema-cross | rsi-bollinger |
|---|---|---|---|---|---|
| Net PnL | **+$20.71** | −$44.01 | −$40.92 | −$134.95 | −$57.37 |
| Trades | 8 | 1 | 1 | 63 | 12 |
| Win rate | 75% | 0% | 0% | 3% | 17% |
| Max drawdown | 0.85% | 7.92% | 7.92% | 13.65% | 6.77% |
| Fees | $1.41 | $0.78 | $0.78 | $23.72 | $4.66 |

The dev window fell 4.0% peak-to-trough with one sharp +2.8% bounce hour; the bot made its money by sitting out the grind down and riding that bounce. On the mirror-image (rising) window the same rules lose at most −$19.99 with the breaker engaged — the downside is bounded while the upside is open.

## Files

- `main.ts` — the bot
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK shim, unmodified
- `LICENSE` — MIT
- `.makefun/owner.json` — entry claim file

---

<sub>Entered on [make.fun](https://make.fun/?ref=w642jqgx&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
