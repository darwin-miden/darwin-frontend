/**
 * Client-side price hook + NAV math for the Darwin baskets.
 *
 * Hits the `/api/prices` route (CoinGecko proxy with a 30s cache),
 * computes per-basket NAV in USD given the manifest weights from
 * `lib/baskets.ts`. The on-chain Pragma adapter will eventually
 * replace the CoinGecko source — the hook's return shape is
 * stable across that swap because `PricesResponse.source` carries
 * the provenance tag for the UI badge.
 */

import { useQuery } from "@tanstack/react-query";

import type { Basket } from "./baskets";

export interface PricesResponse {
  source: "coingecko" | "pragma";
  fetchedAt: number;
  eth: number;
  wbtc: number;
  usdt: number;
  dai: number;
}

const PRICE_KEY: Record<string, keyof Omit<PricesResponse, "source" | "fetchedAt">> = {
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
