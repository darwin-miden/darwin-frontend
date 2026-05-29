/**
 * NAV history endpoint — 30 days of daily NAV points, weighted from
 * the static basket manifest against CoinGecko historical spot prices.
 *
 * Pure Edge function: no database, no sidecar, no persistent backend.
 * Vercel ISR caches the result for 1 hour, so N concurrent users on a
 * basket page cost ~one set of upstream CoinGecko calls per hour total
 * (CG free tier is comfortably ahead of that).
 *
 * Response shape:
 *   { source: "coingecko-30d" | "synthetic", basket: "DCC", points: [{t, nav}] }
 *
 * `source = "synthetic"` is emitted if CoinGecko fails or the requested
 * basket symbol is unknown — the chart still renders something rather
 * than blank-screen the user on a transient upstream blip.
 */

import { BASKETS, type BasketSymbol } from "../../../lib/baskets";

export const runtime = "edge";
export const revalidate = 3600;

interface Point {
  t: number; // unix seconds
  nav: number; // USD
}

interface Resp {
  source: "coingecko-30d" | "synthetic";
  basket: string;
  points: Point[];
}

// faucet alias (per the basket manifests) → CoinGecko coin id.
const CG_ID: Record<string, string> = {
  "darwin-eth": "ethereum",
  "darwin-wbtc": "wrapped-bitcoin",
  "darwin-usdt": "tether",
  "darwin-dai": "dai",
};

async function cgHistory(cgId: string): Promise<Array<[number, number]>> {
  const url =
    `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart` +
    `?vs_currency=usd&days=30&interval=daily`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`coingecko ${cgId} → HTTP ${r.status}`);
  const data = (await r.json()) as { prices?: [number, number][] };
  if (!Array.isArray(data.prices)) {
    throw new Error(`coingecko ${cgId}: malformed response`);
  }
  return data.prices.map(([ms, p]) => [Math.floor(ms / 1000), p]);
}

function synthetic(basket: string): Point[] {
  // Deterministic walk seeded by symbol — keeps the chart populated
  // when the upstream is down or for unknown baskets, instead of
  // blanking the page.
  let nav = 100;
  const out: Point[] = [];
  const now = Math.floor(Date.now() / 1000);
  let seed = 0;
  for (const ch of basket) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  for (let i = 30; i >= 0; i--) {
    const t = now - i * 24 * 3600;
    seed = (seed * 1103515245 + 12345) >>> 0;
    const step = (((seed >> 8) & 0xffff) / 0xffff - 0.5) * 1.5; // ±0.75%
    nav = Math.max(50, nav * (1 + step / 100));
    out.push({ t, nav: Math.round(nav * 100) / 100 });
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("basket") || "DCC").toUpperCase() as BasketSymbol;
  const basket = BASKETS.find((b) => b.symbol === symbol);

  // Unknown basket → graceful synthetic instead of a 404 that would
  // hard-break the chart (a stale picker value during route
  // transitions shouldn't surface as an error).
  if (!basket) {
    const body: Resp = { source: "synthetic", basket: symbol, points: synthetic(symbol) };
    return Response.json(body);
  }

  try {
    // Fan out CoinGecko per constituent — Promise.all fires them in
    // parallel so the route cost is one round-trip total, not N.
    const series = await Promise.all(
      basket.constituents.map(async (c) => {
        const cgId = CG_ID[c.faucetAlias];
        if (!cgId) throw new Error(`no CoinGecko id for ${c.faucetAlias}`);
        const points = await cgHistory(cgId);
        return { weight: c.targetWeightBps / 10_000, points };
      }),
    );

    // CoinGecko `interval=daily` returns one point per day at the
    // same UTC instant for every coin, so the series line up 1-to-1
    // by index. Use the first series' timestamps as the reference.
    const ref = series[0].points;
    const points: Point[] = ref.map(([t], i) => {
      let nav = 0;
      for (const s of series) {
        const sample = s.points[i];
        if (!sample) continue;
        nav += s.weight * sample[1];
      }
      return { t, nav: Math.round(nav * 100) / 100 };
    });

    const body: Resp = { source: "coingecko-30d", basket: symbol, points };
    return Response.json(body);
  } catch (e) {
    // Resilience: a CG hiccup shouldn't blank the chart. Log + fall
    // back to the deterministic synthetic so the page still renders.
    console.error("[/api/nav-history]", e instanceof Error ? e.message : e);
    const body: Resp = { source: "synthetic", basket: symbol, points: synthetic(symbol) };
    return Response.json(body);
  }
}
