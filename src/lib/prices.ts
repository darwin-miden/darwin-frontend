/**
 * Client-side price hook + NAV math for the Darwin baskets.
 *
 * Hits the `/api/prices` route (Vercel Edge function on CoinGecko,
 * ISR-cached 30s) and computes per-basket NAV in USD against the
 * manifest weights from `lib/baskets.ts`. On-chain settlement uses
 * Pragma medians directly from the v6 controller; this hook is the
 * *display* feed only.
 */

import { useQuery } from "@tanstack/react-query";

import type { Basket } from "./baskets";

// PricesResponse + PriceSource are owned by the /api/prices route.
// Re-exporting here keeps the historic import path stable for callers
// that imported the types from `lib/prices`.
export type { PricesResponse, PriceSource } from "../app/api/prices/route";
import type { PricesResponse } from "../app/api/prices/route";

const PRICE_KEY: Record<string, "eth" | "wbtc" | "usdt" | "dai"> = {
  "darwin-eth":  "eth",
  "darwin-wbtc": "wbtc",
  "darwin-usdt": "usdt",
  "darwin-dai":  "dai",
};

export function usePrices() {
  return useQuery<PricesResponse>({
    queryKey: ["darwin", "prices"],
    queryFn: async () => {
      const r = await fetch("/api/prices");
      if (!r.ok) throw new Error(`prices ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * Indicative NAV of one basket token, in USD. Sums the target
 * constituent weights against live prices. This is the *target*
 * NAV — the actual on-chain NAV depends on the controller's
 * current vault composition, which only matches the target after
 * a rebalance.
 */
export function basketNav(basket: Basket, prices: PricesResponse | undefined): number | null {
  if (!prices) return null;
  let nav = 0;
  for (const c of basket.constituents) {
    const key = PRICE_KEY[c.faucetAlias];
    if (!key) return null;
    const price = prices[key];
    nav += (c.targetWeightBps / 10_000) * price;
  }
  return nav;
}
