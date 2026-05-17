/**
 * USD price feed for the four Darwin basket constituents.
 *
 * The eventual data source is the on-chain Pragma adapter on Miden
 * (account address resolved dynamically at boot — see
 * `darwin_tech_decisions.md`). Reading it from the browser requires
 * a heavy `useExecuteProgram` round-trip per pair, so the M3 launch
 * proxies CoinGecko's public REST endpoint server-side and tags the
 * response with the source so the UI can label the placeholder.
 *
 * Edge runtime + a 30s revalidate window keeps the route cheap on
 * CoinGecko's free tier (~30 calls/min/IP).
 */

export const runtime = "edge";
export const revalidate = 30;

interface PricesResponse {
  source: "coingecko" | "pragma";
  fetchedAt: number;
  eth: number;
  wbtc: number;
  usdt: number;
  dai: number;
}

const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,wrapped-bitcoin,tether,dai&vs_currencies=usd";

export async function GET() {
  try {
    const upstream = await fetch(CG_URL, {
      next: { revalidate: 30 },
      headers: { accept: "application/json" },
    });
    if (!upstream.ok) {
      return Response.json(
        { error: `upstream ${upstream.status}` },
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

export type { PricesResponse };
