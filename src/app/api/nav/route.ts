/**
 * Live TARGET NAV view for one basket.
 *
 *   GET /api/nav?basket=DCC
 *
 * Composes:
 *
 *   1. live spot prices from /api/prices (Vercel Edge function on
 *      CoinGecko, ISR-cached 30s — see that route's docstring)
 *   2. basket target weights from lib/baskets (compiled from the
 *      same TOML manifests the deploy scripts use)
 *   3. off-chain target NAV math from lib/navOffchain
 *      (Σ weight × price; this is the *target* NAV — see
 *      navOffchain's module docstring for how it relates to the
 *      controller's on-chain `compute_nav`, which uses actual vault
 *      holdings divided by supply)
 *
 * The response carries `servedMs` so the UI can show how fresh the
 * figure is.
 */
import { basketBySymbol, type BasketSymbol } from "../../../lib/baskets";
import { navFromPrices } from "../../../lib/navOffchain";
import type { PricesResponse } from "../../../app/api/prices/route";

export const runtime = "edge";

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

  // Same-origin fetch to the cached prices endpoint. Behind a
  // forwarding tunnel/proxy, req.url can carry a forwarded `https` proto
  // while the local server actually speaks `http` on that port, so
  // url.origin becomes https://localhost:3010 and the self-fetch fails
  // the TLS handshake ("wrong version number") → 500. Force http for a
  // loopback host so the in-process round-trip always resolves.
  const selfBase = new URL(url.origin);
  if (
    selfBase.protocol === "https:" &&
    (selfBase.hostname === "localhost" || selfBase.hostname === "127.0.0.1")
  ) {
    selfBase.protocol = "http:";
  }
  const pricesUrl = new URL("/api/prices", selfBase);
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
