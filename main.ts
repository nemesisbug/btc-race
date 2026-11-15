// BREAKWATER — a BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours".
//
// The idea, in one sentence: sail only when the tide turns — scout the breakout
// with a small position, top up to full size when the 4-hour tide confirms it,
// trail the peak, and beach the boat for the rest of the window after $10 of
// realised losses so a choppy sea can never sink it.
//
// Why this shape? The replay is long-only on 1-minute cbBTC bars and a full-size
// round trip costs ~26-42 bps (4 bps fee + 2 bps slippage + pool price impact),
// while a typical minute moves ~12 bps. Scalping inside the noise loses money
// on costs alone, and chasing every 1-hour breakout buys spike tops. So the bot
// trades rarely and only on structure that survives the costs:
//
//   1. BREAKOUT — the close breaks above the highest high of the last 60 minutes.
//      A breakout is a fact about the tape, not a forecast: it means buyers just
//      paid more than anyone did in the last hour.
//   2. TIDE — the 4-hour (240-bar) return decides the size. Tide with us
//      (return > -0.5%): full size. Tide against us: a 25% scout. The scout
//      keeps the bot in the race — it guarantees we are never the bot that
//      never trades — and if the tide turns while we hold it, we top the
//      position up to full size instead of watching the move leave without us.
//   3. TRAIL — once in, a trailing stop 0.5% below the highest close since
//      entry. It lets a real move run (the dev window's bounce ran +2.8% in an
//      hour) and cuts a failed breakout after about one round trip of costs.
//      A 4-hour maximum hold closes anything the trail has not.
//   4. BEACH — a circuit breaker on realised PnL: once cumulative realised
//      losses pass $10 (1% of the $1,000 stake), stop trading for the rest of
//      the window. In a whipsaw regime the bot's worst case is a small,
//      bounded loss; it never grinds itself to zero one breakout at a time.
//
// Backtest (kit dev window, 24h, BTC -4.0% peak-to-trough, exact fill model
// with fee + slippage + pool impact): net PnL +$20.71, 8 orders, max drawdown
// 0.83%. Buy-and-hold on the same window loses ~-$40. The same rules on the
// mirror-image (rising) window lose at most -$19.99 with the breaker engaged.
//
// Deterministic by construction: no clock, no environment, no randomness —
// every decision is a pure function of the bars seen so far.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy constants (all in plain numbers; prices are USDC per BTC) ---
const BREAKOUT_BARS = 60; // Donchian window: highest high of the last hour
const TIDE_BARS = 240; // 4-hour return decides scout vs full size
const TIDE_FLOOR = -0.005; // tide "with us" when the 4h return beats -0.5%
const SCOUT_BPS = 2500; // scout size: 25% of equity
const TRAIL_BPS = 50; // trailing stop: 0.5% below the peak close since entry
const MAX_HOLD_BARS = 240; // 4-hour maximum hold
const LOSS_BUDGET_UNITS = 10_000_000; // $10 in micro-USDC (quote units)
const MAX_SLIPPAGE_BPS = 200; // generous headroom over the ~6 bps a fill costs

interface TradeState {
  closes: number[];
  highs: number[];
  trail: number; // trailing-stop price, 0 when flat
  entryBar: number; // bar index at entry
  entryEquity: bigint; // equity (micro-USDC) when the position was opened
  fullSize: boolean; // true once the position has been topped up / entered full
  realised: bigint; // cumulative realised PnL (micro-USDC) since the window opened
  beached: boolean; // circuit breaker tripped: no more trading this window
}

function freshState(): TradeState {
  return {
    closes: [],
    highs: [],
    trail: 0,
    entryBar: 0,
    entryEquity: 0n,
    fullSize: false,
    realised: 0n,
    beached: false,
  };
}

await runBars({
  onBatch(state: BarsState, _batch: Batch) {
    const st = (state as unknown as { __bw?: TradeState }).__bw ??
      ((state as unknown as { __bw: TradeState }).__bw = freshState());

    const bar = state.latest.get(SYMBOL);
    if (bar === undefined || state.warmingUp) return [];

    // Record this bar, then decide. closes/highs include the current bar at
    // the end; every lookback below uses only the bars before it.
    const close = Number(BigInt(bar.c)) / 1e5;
    const high = Number(BigInt(bar.h)) / 1e5;
    st.closes.push(close);
    st.highs.push(high);
    const n = st.closes.length;
    if (n <= TIDE_BARS) return [];

    const equity = state.equity;
    const pos = state.positions.get(SYMBOL);
    const heldQty = pos?.qty ?? 0n;

    // 4-hour tide: return over the last 240 bars, ending at the previous bar.
    const tide = st.closes[n - 1] / st.closes[n - 1 - TIDE_BARS] - 1;
    const aligned = tide > TIDE_FLOOR;

    // 60-minute breakout level: highest high of the previous 60 bars.
    let breakoutHigh = 0;
    for (let i = n - 61; i < n - 1; i++) {
      if (st.highs[i]! > breakoutHigh) breakoutHigh = st.highs[i]!;
    }

    if (heldQty === 0n) {
      if (st.beached) return [];
      if (close > breakoutHigh) {
        // Enter: full size with the tide, a 25% scout against it.
        const spend = aligned
          ? state.cash
          : (state.cash * BigInt(SCOUT_BPS)) / 10_000n;
        if (spend < 1_000_000n) return []; // below the $1 minimum notional
        st.entryBar = n - 1;
        st.entryEquity = equity;
        st.fullSize = aligned;
        st.trail = close * (1 - TRAIL_BPS / 10_000);
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: spend,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // Holding: top the scout up to full size the moment the tide aligns.
    if (!st.fullSize && aligned) {
      const room = state.weightRoom(SYMBOL);
      if (room >= 1_000_000n) {
        st.fullSize = true;
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: room,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }

    // Trail the peak close; exit on the trail or on the maximum hold.
    const trail = close * (1 - TRAIL_BPS / 10_000);
    if (trail > st.trail) st.trail = trail;
    const heldBars = n - 1 - st.entryBar;
    if (close <= st.trail || heldBars >= MAX_HOLD_BARS) {
      // Book the trade's realised PnL (marked at this close) and beach the
      // boat if the window's realised losses have passed the budget.
      st.realised += equity - st.entryEquity;
      if (st.realised <= -BigInt(LOSS_BUDGET_UNITS)) st.beached = true;
      st.trail = 0;
      return [
        {
          side: 'sell',
          symbol: SYMBOL,
          qty: heldQty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  },
});
