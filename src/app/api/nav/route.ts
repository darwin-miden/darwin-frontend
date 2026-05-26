/**
 * Live NAV view for one basket.
 *
 *   GET /api/nav?basket=DCC
 *
 * Composes:
 *
 *   1. live Pragma prices from /api/prices (server-side warm cache,
 *      refreshed every 15s; falls back to CoinGecko if Pragma is
 *      unreachable)
 *   2. on-chain basket weights from lib/baskets (compiled from the
 *      same TOML manifests the deploy scripts use)
 *   3. off-chain NAV math from lib/navOffchain (byte-parity with the
 *      v6 controller's `compute_nav` proc)
 *
 * The user-perceived latency is dominated by the warm-cache hit on
 * /api/prices — typically <10ms once the warmer has done its first
 * tick. The response carries `latencyMs` so the UI can show how
 * fresh the NAV figure is.
 */
import { basketBySymbol, type BasketSymbol } from "../../../lib/baskets";
import { navFromPrices } from "../../../lib/navOffchain";
import type { PricesResponse } from "../../../app/api/prices/route";

export const runtime = "nodejs";

const VALID: ReadonlySet<BasketSymbol> = new Set(["DCC", "DAG", "DCO"]);

export async function GET(req: Request) {
  const start = Date.now();
  const url = new URL(req.url);
  const sym = (url.searchParams.get("basket") ?? "").toUpperCase() as BasketSymbol;
  if (!VALID.has(sym)) {
    return Response.json(
      { error: "basket must be one of DCC, DAG, DCO" },
      { status: 400 },
    );
  }
  const basket = basketBySymbol(sym);

  // Same-origin fetch to the cached prices endpoint. The cache is
  // shared across both routes via the module-level singleton in
  // /api/prices, so this round-trip is in-process.
  const pricesUrl = new URL("/api/prices", url.origin);
  const r = await fetch(pricesUrl, { cache: "no-store" });
  if (!r.ok) {
    return Response.json(
      { error: `upstream prices ${r.status}` },
      { status: 502 },
    );
  }
  const prices = (await r.json()) as PricesResponse;
  const nav = navFromPrices(basket, prices);
  if (!nav) {
    return Response.json(
      { error: "incomplete price snapshot" },
      { status: 502 },
    );
  }

  return Response.json(
    {
      ...nav,
      servedMs: Date.now() - start,
    },
    {
      headers: {
        "cache-control": "public, max-age=5, stale-while-revalidate=30",
      },
    },
  );
}
