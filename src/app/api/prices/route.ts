/**
 * USD price feed for the four Darwin basket constituents.
 *
 * Pure Edge function: one `fetch` to CoinGecko, no child processes,
 * no background warmer, no filesystem. Vercel ISR caches the result
 * for 30 s, matching the client hook's `refetchInterval`, so N
 * concurrent users cost ~2 upstream CoinGecko calls per minute total
 * regardless of traffic — comfortably inside the public CG tier.
 *
 * Response shape:
 *   { source: "coingecko", fetchedAt, eth, wbtc, usdt, dai, latencyMs }
 *
 * On-chain settlement remains backed by the Pragma oracle inside the
 * v6 controller — this route is the *display* feed, not the settlement
 * feed, and a CoinGecko spot price is within a few bps of Pragma's
 * median for the pairs we care about.
 */

export const runtime = "edge";
export const revalidate = 30;

type PriceSource = "coingecko";

interface PricesResponse {
  source: PriceSource;
  fetchedAt: number;
  eth: number;
  wbtc: number;
  usdt: number;
  dai: number;
  latencyMs: number;
}

const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price" +
  "?ids=ethereum,wrapped-bitcoin,tether,dai&vs_currencies=usd";

export async function GET(): Promise<Response> {
  const start = Date.now();
  try {
    const upstream = await fetch(CG_URL, {
      headers: { accept: "application/json" },
    });
    if (!upstream.ok) {
      return Response.json(
        { error: `coingecko HTTP ${upstream.status}` },
        { status: 502 },
      );
    }
    const data = (await upstream.json()) as Record<string, { usd: number }>;
    const body: PricesResponse = {
      source: "coingecko",
      fetchedAt: Date.now(),
      eth: data.ethereum?.usd ?? 0,
      wbtc: data["wrapped-bitcoin"]?.usd ?? 0,
      usdt: data.tether?.usd ?? 0,
      dai: data.dai?.usd ?? 0,
      latencyMs: Date.now() - start,
    };
    return Response.json(body, {
      headers: {
        "cache-control": "public, max-age=15, stale-while-revalidate=60",
      },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 502 },
    );
  }
}

export type { PricesResponse, PriceSource };
