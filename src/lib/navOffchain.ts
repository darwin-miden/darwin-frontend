/**
 * Off-chain TARGET NAV evaluator.
 *
 * Computes `Σ (target_weight_bps / 10_000) × oracle_price_usd` for a
 * basket — i.e. what one basket-token is worth at current oracle
 * prices *assuming the vault matches its target composition*.
 * Immediately after a rebalance, target NAV == actual NAV; between
 * rebalances they drift apart by the constituent price moves
 * weighted by the current vs target deltas.
 *
 * This is NOT the same shape as the controller's on-chain
 * `compute_nav` (asm/lib/nav.masm), which evaluates
 * `Σ price_i × quantity_i / supply` using the controller's current
 * vault holdings + the basket-faucet's live supply. That number is
 * structurally slower to read (foreign account + storage map +
 * felt_div inside a tx), and is what the controller writes into
 * slot 0 when `compute_nav` executes on-chain.
 *
 * For the read-only UI badge ("Target NAV / unit") this target
 * approximation is the right thing — fast, oracle-anchored, and
 * matches what the basket is *trying* to be worth. Source of truth
 * for prices is still Pragma:
 *
 *   Pragma testnet ──► pragma_prices_json (Rust, get_median)
 *                    ──► /api/prices (server-side warm cache, 15s)
 *                      ──► navFromPrices() (pure TS, this file)
 */
import type { Basket } from "./baskets";
import type { PricesResponse } from "./prices";

const PRICE_KEY: Record<string, "eth" | "wbtc" | "usdt" | "dai"> = {
  "darwin-eth":  "eth",
  "darwin-wbtc": "wbtc",
  "darwin-usdt": "usdt",
  "darwin-dai":  "dai",
};

export interface NavBreakdown {
  faucetAlias: string;
  weightBps: number;
  priceUsd: number;
  contributionUsd: number;
}

export interface NavResult {
  basket: string;
  /** Target NAV: Σ (target_weight × oracle_price). See module docstring. */
  navUsd: number;
  breakdown: NavBreakdown[];
  /** Snapshot of where the price data came from + when. */
  source: PricesResponse["source"];
  pricesAt: number;
}

/**
 * Compute target NAV in USD for one basket given a price snapshot.
 *
 * Returns null if any constituent is missing a price (means the
 * caller should treat the snapshot as incomplete, not as zero).
 */
export function navFromPrices(
  basket: Basket,
  prices: PricesResponse,
): NavResult | null {
  const breakdown: NavBreakdown[] = [];
  let nav = 0;
  for (const c of basket.constituents) {
    const key = PRICE_KEY[c.faucetAlias];
    if (!key) return null;
    const price = prices[key];
    if (price == null || Number.isNaN(price)) return null;
    const contribution = (c.targetWeightBps / 10_000) * price;
    breakdown.push({
      faucetAlias: c.faucetAlias,
      weightBps: c.targetWeightBps,
      priceUsd: price,
      contributionUsd: contribution,
    });
    nav += contribution;
  }
  return {
    basket: basket.symbol,
    navUsd: nav,
    breakdown,
    source: prices.source,
    pricesAt: prices.fetchedAt,
  };
}
