/**
 * Off-chain NAV evaluator — mirrors the on-chain `compute_nav` math
 * from the v6 controller (`darwin::nav` proc) so the answer the UI
 * shows is the same number the controller will write into slot 0
 * when `compute_nav` runs inside a tx.
 *
 * Source of truth for prices is still Pragma (the values come from
 * `/api/prices` which calls `pragma_prices_json` against testnet);
 * we just don't burn an on-chain tx + foreign-account-read for a
 * read-only view. Prices flow:
 *
 *   Pragma testnet ──► pragma_prices_json (Rust, get_median)
 *                    ──► /api/prices (server-side warm cache, 15s)
 *                      ──► navFromPrices() (pure TS, this file)
 *
 * The on-chain math is `Σ (weight_bps * price_1e8) / 10000`, with
 * all intermediate values as u64 felts. We replicate it with
 * `bigint` so we never lose a single felt in rounding — the test
 * suite asserts byte-for-byte parity with the controller's NAV.
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
  navUsd: number;
  breakdown: NavBreakdown[];
  /** Snapshot of where the price data came from + when. */
  source: PricesResponse["source"];
  pricesAt: number;
}

/**
 * Compute NAV in USD for one basket given a price snapshot.
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
