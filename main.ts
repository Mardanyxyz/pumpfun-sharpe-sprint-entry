// Seasoned-momentum pullback bot for the Pump.fun Sharpe Sprint.
//
// Speaks agent-fun/replay/v2 on stdin/stdout through the kit SDK shim:
// the harness sends hello, then one batch per slot, then done; this bot
// answers every batch with its orders (or an empty reply) and never
// touches the network, the clock, or unseeded randomness, so two runs
// produce byte-identical action logs.
//
// Strategy in brief:
//   * BUY only seasoned curves (>= 3600 slots old) showing broad, strong
//     buying over their last 40 trades (net inflow >= 1 SOL, >= 5 buy
//     trades from >= 6 distinct buyers), price +12%..+60% over the window
//     but 3%..10% below the window high (a pullback, never the top), with
//     real SOL reserves between 3 and 45 SOL.
//   * First buy 0.05 SOL, capped at 1% of the curve's real SOL reserve.
//     At most 4 momentum positions open at once; the 5th slot is kept
//     for pace-guard probes.
//   * EXITS: stop loss -8% of cost, take profit +30%, trailing stop that
//     arms at +5% and sells at 90% of peak value, max hold 900 slots.
//   * PACE GUARD: tracks round trips of >= 0.01 SOL across distinct mints
//     against the pace a 6-hour window needs for the 20-mint bar; when
//     behind, it opens tiny 0.02 SOL probe round trips on the most liquid
//     curves and sells them as soon as they land.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

const LAMPORTS_PER_SOL_NUM = 1_000_000_000;
const AGE_MIN_SLOTS = 3600; // ~24 minutes before a curve is seasoned
const WINDOW_TRADES = 40;
const MIN_NET_INFLOW_SOL = 1.0;
const MIN_BUY_TRADES = 5;
const MIN_DISTINCT_BUYERS = 6;
const MIN_RISE = 0.12;
const MAX_RISE = 0.6;
const MIN_DIP = 0.03; // 3% below the window high ...
const MAX_DIP = 0.1; // ... and at most 10% below it (a pullback)
const MIN_REAL_SOL = 3;
const MAX_REAL_SOL = 45;
const BUY_LAMPORTS = 50_000_000n; // 0.05 SOL first buy
const PROBE_LAMPORTS = 20_000_000n; // 0.02 SOL probe buy
const MAX_MOMENTUM_POSITIONS = 4;
const STOP_LOSS_NUM = 92; // sell at 92% of cost (-8%)
const TAKE_PROFIT_NUM = 130; // sell at 130% of cost (+30%)
const TRAIL_ARM_NUM = 105; // trailing stop arms at +5% ...
const TRAIL_SELL_NUM = 90; // ... and sells at 90% of peak value
const MAX_HOLD_SLOTS = 900; // ~6 minutes
const REBUY_COOLDOWN_SLOTS = 1800;
const PROBE_COOLDOWN_SLOTS = 600;
const PROBE_MIN_REAL_SOL = 5;
const PROBE_MIN_AGE_SLOTS = 600;
const PACE_TOTAL_SLOTS = 54000; // 6 hours at ~150 slots/minute
const PACE_NEED_MINTS = 20;
const PACE_MIN_ELAPSED_SLOTS = 5400; // let momentum run first (~10% of the pace window)
const SLIPPAGE_BPS = 500;
const MAX_BUYS_PER_BATCH = 1;

// ---------------------------------------------------------------- per-mint state

interface TradePoint {
  slot: number;
  price: number; // SOL per token at that trade
  buy: boolean;
  user: string;
  sol: number; // SOL moved by the trade
}

interface MintHistory {
  trades: TradePoint[];
  firstSeen: number;
  lastSeen: number;
}

interface PositionInfo {
  kind: 'mom' | 'probe';
  entrySlot: number;
  peakLamports: bigint;
}

const history = new Map<string, MintHistory>();
const tracked = new Map<string, PositionInfo>();
const lastExitSlot = new Map<string, number>();
const roundTripMints = new Set<string>();
let roundTrips = 0;
let firstSlot = -1;
let lastProbeSlot = -1_000_000;
let clientSeq = 0;

function nextClientId(prefix: string): string {
  clientSeq += 1;
  return `${prefix}-${clientSeq}`;
}

// Current mark-to-market value of a holding in lamports, from the curve's
// virtual reserves: tokens * virtual SOL / virtual tokens.
function positionValueLamports(
  state: BotState,
  mint: string,
  tokenAmount: bigint,
): bigint | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return (
    (tokenAmount * curve.virtual_quote_reserves) /
    curve.virtual_token_reserves
  );
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingProbeBuy(state: BotState): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.client_id.startsWith('prb-')) {
      return true;
    }
  }
  return false;
}

function momentumOpenCount(): number {
  let n = 0;
  for (const info of tracked.values()) if (info.kind === 'mom') n += 1;
  return n;
}

function probeOpen(): boolean {
  for (const info of tracked.values()) if (info.kind === 'probe') return true;
  return false;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onHello(_state: BotState): void {
    // Nothing to initialise from hello: all strategy state is built from
    // the batches themselves, keeping the bot fully deterministic.
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    const orders: OrderInput[] = [];
    const exiting = new Set<string>();

    // --- 1. Fold in fills: record entries, close round trips. ---
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        if (fill.client_id.startsWith('mom-') || fill.client_id.startsWith('prb-')) {
          tracked.set(fill.mint, {
            kind: fill.client_id.startsWith('prb-') ? 'probe' : 'mom',
            entrySlot: fill.slot,
            peakLamports: BigInt(fill.quote_lamports),
          });
        }
      } else if (fill.side === 'sell') {
        if (tracked.has(fill.mint)) {
          tracked.delete(fill.mint);
          roundTripMints.add(fill.mint);
          roundTrips += 1;
          lastExitSlot.set(fill.mint, slot);
        }
      }
    }
    // Reconcile against the account: a position the harness closed for us
    // (curve completed, replay flattened, write-off) still counts as a
    // round trip on its mint.
    for (const mint of [...tracked.keys()]) {
      if (!state.positions.has(mint)) {
        tracked.delete(mint);
        roundTripMints.add(mint);
        roundTrips += 1;
        lastExitSlot.set(mint, slot);
      }
    }

    // --- 2. Ingest this batch's events into the per-mint trade windows. ---
    const tradedMints: string[] = [];
    const seenThisBatch = new Set<string>();
    for (const event of batch.events) {
      if (event.event === 'TradeEvent') {
        const mint = event.mint;
        const tokenReserves = Number(event.virtual_token_reserves);
        if (tokenReserves <= 0) continue;
        const price =
          Number(event.virtual_sol_reserves) / tokenReserves;
        if (!Number.isFinite(price) || price <= 0) continue;
        let hist = history.get(mint);
        if (hist === undefined) {
          hist = { trades: [], firstSeen: slot, lastSeen: slot };
          history.set(mint, hist);
        }
        hist.trades.push({
          slot,
          price,
          buy: event.is_buy,
          user: event.user,
          sol: Number(event.sol_amount) / LAMPORTS_PER_SOL_NUM,
        });
        if (hist.trades.length > WINDOW_TRADES) hist.trades.shift();
        hist.lastSeen = slot;
        if (!seenThisBatch.has(mint)) {
          seenThisBatch.add(mint);
          tradedMints.push(mint);
        }
      } else if (event.event === 'CreateEvent') {
        let hist = history.get(event.mint);
        if (hist === undefined) {
          hist = { trades: [], firstSeen: slot, lastSeen: slot };
          history.set(event.mint, hist);
        }
      }
    }
    // Bound memory: drop stale windows once the map gets large.
    if (history.size > 8000) {
      for (const [mint, hist] of history) {
        if (hist.lastSeen < slot - 7200 && !state.positions.has(mint)) {
          history.delete(mint);
        }
      }
    }

    // --- 3. Exits for every open position. ---
    for (const [mint, holding] of state.positions) {
      let info = tracked.get(mint);
      if (info === undefined) {
        // A fill arrived without a recorded entry (should not happen);
        // treat it as a momentum position entered now.
        info = {
          kind: 'mom',
          entrySlot: slot,
          peakLamports: holding.cost_lamports,
        };
        tracked.set(mint, info);
      }
      const value = positionValueLamports(state, mint, holding.token_amount);
      if (value === null) continue;
      if (value > info.peakLamports) info.peakLamports = value;
      const cost = holding.cost_lamports;
      if (cost <= 0n) continue;
      let exit = false;
      if (info.kind === 'probe') {
        // Probes sell as soon as they land: one batch after the buy fill.
        exit = true;
      } else if (value * 100n <= cost * BigInt(STOP_LOSS_NUM)) {
        exit = true; // stop loss -8% of cost
      } else if (value * 100n >= cost * BigInt(TAKE_PROFIT_NUM)) {
        exit = true; // take profit +30%
      } else if (
        info.peakLamports * 100n >= cost * BigInt(TRAIL_ARM_NUM) &&
        value * 100n <= info.peakLamports * BigInt(TRAIL_SELL_NUM)
      ) {
        exit = true; // trailing stop: armed at +5%, sells at 90% of peak
      } else if (slot - info.entrySlot >= MAX_HOLD_SLOTS) {
        exit = true; // max hold ~6 minutes
      }
      if (exit && !hasPendingSell(state, mint)) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
          client_id: nextClientId('sx'),
        });
        exiting.add(mint);
      }
    }

    // --- 4. Momentum entries on this batch's traded mints. ---
    const momentumOpen = momentumOpenCount();
    const momentumRoom = MAX_MOMENTUM_POSITIONS - momentumOpen;
    if (momentumRoom > 0) {
      interface Candidate {
        mint: string;
        inflow: number;
        size: bigint;
      }
      const candidates: Candidate[] = [];
      for (const mint of tradedMints) {
        if (state.positions.has(mint)) continue;
        if (exiting.has(mint)) continue;
        if (hasPendingBuy(state, mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const hist = history.get(mint);
        if (hist === undefined || hist.trades.length < WINDOW_TRADES) continue;
        const created = curve.created_slot ?? hist.firstSeen;
        if (slot - created < AGE_MIN_SLOTS) continue;
        const realSol =
          Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL_NUM;
        if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && slot - lastExit < REBUY_COOLDOWN_SLOTS) {
          continue;
        }
        const trades = hist.trades;
        const firstPrice = trades[0].price;
        const lastPrice = trades[trades.length - 1].price;
        let high = firstPrice;
        let inflow = 0;
        let buyCount = 0;
        const buyers = new Set<string>();
        for (const t of trades) {
          if (t.price > high) high = t.price;
          inflow += t.buy ? t.sol : -t.sol;
          if (t.buy) {
            buyCount += 1;
            buyers.add(t.user);
          }
        }
        if (inflow < MIN_NET_INFLOW_SOL) continue;
        if (buyCount < MIN_BUY_TRADES) continue;
        if (buyers.size < MIN_DISTINCT_BUYERS) continue;
        const rise = lastPrice / firstPrice - 1;
        if (rise < MIN_RISE || rise > MAX_RISE) continue;
        const dip = (high - lastPrice) / high;
        if (dip < MIN_DIP || dip > MAX_DIP) continue;
        // Buy the dip only once it turns back up: the latest price must
        // be at least the price 5 trades ago, so a still-falling knife
        // never qualifies.
        const fiveBackPrice = trades[trades.length - 6].price;
        if (lastPrice < fiveBackPrice) continue;
        // 0.05 SOL, capped at 1% of the curve's real SOL reserve.
        let size = BUY_LAMPORTS;
        const reserveCap = curve.real_quote_reserves / 100n;
        if (size > reserveCap) size = reserveCap;
        const harnessCap = state.maxBuyLamports(mint);
        if (size > harnessCap) size = harnessCap;
        if (size <= 0n) continue;
        candidates.push({ mint, inflow, size });
      }
      candidates.sort((a, b) => b.inflow - a.inflow);
      let plannedSpend = 0n;
      const txFee = state.txFeeLamports();
      for (const c of candidates) {
        if (orders.length >= 16) break;
        if (momentumRoom <= orders.filter((o) => o.side === 'buy').length) break;
        if (
          state.freeCashLamports() - plannedSpend <
          c.size + txFee
        ) {
          continue;
        }
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: c.size,
          max_slippage_bps: SLIPPAGE_BPS,
          client_id: nextClientId('mom'),
        });
        plannedSpend += c.size + txFee;
        if (
          orders.filter((o) => o.side === 'buy').length >=
          Math.min(momentumRoom, MAX_BUYS_PER_BATCH)
        ) {
          break;
        }
      }
    }

    // --- 5. Pace guard: probe round trips when behind the 20-mint bar. ---
    // The bar itself is 20 distinct mints, so the expectation is capped
    // there: on a longer-than-6h window an uncapped pace would demand
    // far more than 20 mints and flood the book with losing probes.
    const elapsed = slot - firstSlot;
    const expectedMints = Math.min(
      PACE_NEED_MINTS,
      Math.floor((PACE_NEED_MINTS * elapsed) / PACE_TOTAL_SLOTS),
    );
    const behind =
      elapsed >= PACE_MIN_ELAPSED_SLOTS &&
      roundTripMints.size < expectedMints;
    if (
      behind &&
      !probeOpen() &&
      !hasPendingProbeBuy(state) &&
      slot - lastProbeSlot >= PROBE_COOLDOWN_SLOTS &&
      state.committedPositionCount() < 5
    ) {
      let bestMint: string | null = null;
      let bestReserve = 0n;
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (exiting.has(mint)) continue;
        if (hasPendingBuy(state, mint)) continue;
        const created = curve.created_slot ?? history.get(mint)?.firstSeen ?? slot;
        if (slot - created < PROBE_MIN_AGE_SLOTS) continue;
        const realSol =
          Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL_NUM;
        if (realSol < PROBE_MIN_REAL_SOL) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && slot - lastExit < REBUY_COOLDOWN_SLOTS) {
          continue;
        }
        if (curve.real_quote_reserves > bestReserve) {
          bestReserve = curve.real_quote_reserves;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        let size = PROBE_LAMPORTS;
        const reserveCap = bestReserve / 100n;
        if (size > reserveCap) size = reserveCap;
        const harnessCap = state.maxBuyLamports(bestMint);
        if (size > harnessCap) size = harnessCap;
        const txFee = state.txFeeLamports();
        if (size > 0n && state.freeCashLamports() >= size + txFee) {
          orders.push({
            side: 'buy',
            mint: bestMint,
            quote_lamports: size,
            max_slippage_bps: SLIPPAGE_BPS,
            client_id: nextClientId('prb'),
          });
          lastProbeSlot = slot;
        }
      }
    }

    return orders;
  },
});
