"use client";

/**
 * Live NAV hook for the basket detail / portfolio UI.
 *
 *   const { nav, latencyMs, status } = useNavLive("DCC");
 *
 * Hits /api/nav?basket=X (which composes the warm-cached Pragma
 * prices + the manifest weights + the off-chain NAV math). Polls
 * every 10s while the tab is visible, measures user-perceived
 * latency on the client side so the freshness badge in the UI
 * reflects what the user actually feels — not the upstream
 * Pragma fetch time.
 *
 * Pragma stays the source of truth: the server route's cache is a
 * bounded snapshot (max 15s stale), and a cold-miss falls through
 * to a live `pragma_prices_json` shell-out.
 */
import { useQuery } from "@tanstack/react-query";

import type { BasketSymbol } from "./baskets";
import type { PricesResponse } from "../app/api/prices/route";
import type { NavBreakdown } from "./navOffchain";

export interface NavLiveResponse {
  basket: BasketSymbol;
  navUsd: number;
  breakdown: NavBreakdown[];
  source: PricesResponse["source"];
  pricesAt: number;
  servedMs: number;
}

export interface UseNavLive {
  data: NavLiveResponse | undefined;
  /** Round-trip time measured client-side (fetch+parse). */
  latencyMs: number | null;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
}

export function useNavLive(symbol: BasketSymbol): UseNavLive {
  const q = useQuery<{ res: NavLiveResponse; clientMs: number }>({
    queryKey: ["darwin", "nav", symbol],
    queryFn: async () => {
      const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const r = await fetch(`/api/nav?basket=${symbol}`);
      if (!r.ok) {
        throw new Error(`/api/nav ${r.status}`);
      }
      const res = (await r.json()) as NavLiveResponse;
      const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      return { res, clientMs: Math.round(t1 - t0) };
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return {
    data: q.data?.res,
    latencyMs: q.data?.clientMs ?? null,
    isFetching: q.isFetching,
    error: q.error,
    refetch: () => void q.refetch(),
  };
}
