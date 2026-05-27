/**
 * USD price feed for the four Darwin basket constituents.
 *
 * Data sources, picked at request time:
 *
 *   1. **pragma-miden** (preferred): shells out to the
 *      `pragma_prices_json` binary built from darwin-protocol with
 *      the `pragma-live` feature. That binary opens a fresh
 *      miden-client store, syncs against testnet, registers the
 *      Pragma oracle + publisher as foreign accounts, and runs a
 *      `call.<get_median_root>` tx script against the oracle for
 *      each pair. Returns the median price ×1e8 from the on-chain
 *      Pragma adapter. Total wall time ~1.5–2s per refresh.
 *
 *   2. **coingecko** (fallback): public REST endpoint, used when
 *      `DARWIN_PRAGMA_BIN` is unset, the binary fails, or the
 *      shell-out times out.
 *
 *   3. **pragma-miden+fallback** (mixed): when Pragma returns
 *      clearly-broken values for known stablecoin pairs (USDT/USD
 *      testnet publisher currently posts at 1e6 scale, ~100×
 *      below dollar peg), the route keeps the healthy pragma
 *      readings and substitutes CoinGecko spot for the broken
 *      pair(s) only. The `source` field tags this as mixed so the
 *      UI shows the provenance honestly — we don't silently
 *      rescale broken feeds.
 *
 * Node runtime (not edge) because we need `child_process` to
 * invoke the Rust binary.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const revalidate = 30;

const execP = promisify(exec);

type PriceSource = "coingecko" | "pragma-miden" | "pragma-miden+fallback";

interface PricesResponse {
  source: PriceSource;
  fetchedAt: number;
  eth: number;
  wbtc: number;
  usdt: number;
  dai: number;
  latencyMs?: number;
  /** Pairs whose pragma value was replaced by CoinGecko. Empty unless source=mixed. */
  fallbackPairs?: ReadonlyArray<"eth" | "wbtc" | "usdt" | "dai">;
}

const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,wrapped-bitcoin,tether,dai&vs_currencies=usd";

const PRAGMA_BIN = process.env.DARWIN_PRAGMA_BIN;
const PRAGMA_TIMEOUT_MS = 8_000;

// Per-pair sanity ranges (USD). A reading outside [min, max] is
// treated as a broken upstream feed and triggers the CoinGecko
// fallback for that pair only.
//
// Stablecoin bounds are tight ([0.5, 2.0]) because any pegged-dollar
// asset breaking those bounds is by definition off-peg — even a
// genuine $0.50 de-peg is news, but our M3 demo wants a usable
// figure for the NAV display. The crypto bounds are wide enough to
// accommodate any realistic price move; we're only catching
// scale-of-magnitude bugs (e.g. publisher posts wei instead of
// 1e8-scaled USD).
const SANITY: Record<"eth" | "wbtc" | "usdt" | "dai", { min: number; max: number }> = {
  eth:  { min: 100, max: 100_000 },
  wbtc: { min: 1_000, max: 1_000_000 },
  usdt: { min: 0.5, max: 2 },
  dai:  { min: 0.5, max: 2 },
};

function isSane(key: keyof typeof SANITY, v: number): boolean {
  if (!Number.isFinite(v) || v <= 0) return false;
  const r = SANITY[key];
  return v >= r.min && v <= r.max;
}

let cache: { at: number; body: PricesResponse } | null = null;
const CACHE_TTL_MS = 30_000;

// Background warm-up: re-poll Pragma every WARM_INTERVAL_MS so the
// cache is always fresh, and a user request never pays the cold
// shell-out cost. Pragma stays the source of truth — this is just a
// memoised snapshot of its last reading, not a publisher relay.
const WARM_INTERVAL_MS = 15_000;
declare global {
  // eslint-disable-next-line no-var
  var __DARWIN_PRICES_WARMER__: NodeJS.Timeout | undefined;
}
if (
  PRAGMA_BIN
  && process.env.NEXT_PHASE !== "phase-production-build"
  && !globalThis.__DARWIN_PRICES_WARMER__
) {
  const tick = async () => {
    const body = await fetchPragmaWithFallback();
    if (body) cache = { at: Date.now(), body };
  };
  void tick();
  globalThis.__DARWIN_PRICES_WARMER__ = setInterval(tick, WARM_INTERVAL_MS);
  globalThis.__DARWIN_PRICES_WARMER__.unref?.();
}

async function fetchPragma(): Promise<PricesResponse | null> {
  if (!PRAGMA_BIN) return null;
  const start = Date.now();
  try {
    const { stdout } = await execP(PRAGMA_BIN, { timeout: PRAGMA_TIMEOUT_MS });
    const trimmed = stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(trimmed) as Omit<PricesResponse, "latencyMs">;
    return { ...parsed, latencyMs: Date.now() - start };
  } catch {
    return null;
  }
}

async function fetchCoinGecko(): Promise<PricesResponse> {
  const start = Date.now();
  // cache:"no-store" — Next.js's `next: { revalidate: 30 }` cache
  // serves stale FAILED responses for 30 s, which we saw burn us
  // when CG was momentarily rate-limited: the cache then keeps
  // returning the error long after CG recovered, so the per-pair
  // fallback in fetchPragmaWithFallback never gets a chance to
  // substitute. Our own module-level cache (cache.body) already
  // does the warm-cache job; skip Next's. Same pattern would have
  // hit us on USDT specifically — which it did.
  const upstream = await fetch(CG_URL, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!upstream.ok) {
    throw new Error(`upstream ${upstream.status}`);
  }
  const data = (await upstream.json()) as Record<string, { usd: number }>;
  return {
    source: "coingecko",
    fetchedAt: Date.now(),
    eth: data.ethereum?.usd ?? 0,
    wbtc: data["wrapped-bitcoin"]?.usd ?? 0,
    usdt: data.tether?.usd ?? 0,
    dai: data.dai?.usd ?? 0,
    latencyMs: Date.now() - start,
  };
}

/**
 * Pull from Pragma first; per-pair sanity-check; backfill any
 * unhealthy pair from CoinGecko. Returns null only if BOTH sources
 * fail completely. The `source` tag is:
 *
 *   - "pragma-miden"           — all 4 pairs healthy from Pragma
 *   - "pragma-miden+fallback"  — ≥1 pair backfilled from CoinGecko
 *   - "coingecko"              — Pragma totally unreachable, all CG
 */
async function fetchPragmaWithFallback(): Promise<PricesResponse | null> {
  const pragma = await fetchPragma();
  if (!pragma) return null;

  const bad: Array<keyof typeof SANITY> = [];
  for (const k of ["eth", "wbtc", "usdt", "dai"] as const) {
    if (!isSane(k, pragma[k])) bad.push(k);
  }
  if (bad.length === 0) return pragma;

  // Pragma is partially broken — fetch CG once and substitute the
  // bad pairs.
  let cg: PricesResponse | null = null;
  try {
    cg = await fetchCoinGecko();
  } catch (e) {
    // Surface the reason — silently swallowing burned us during
    // a verification round when this fallback path was meant to
    // substitute USDT but kept the broken Pragma value because
    // CG was unreachable from the dev server but reachable
    // elsewhere on the box.
    console.error("[/api/prices] CoinGecko fallback failed:", e instanceof Error ? e.message : e);
    cg = null;
  }
  if (!cg) {
    // Pragma broken on some pairs + CG unreachable: keep pragma's
    // (broken) numbers, but flag the source so the UI shows it.
    return { ...pragma, source: "pragma-miden+fallback", fallbackPairs: bad };
  }

  const merged: PricesResponse = {
    ...pragma,
    source: "pragma-miden+fallback",
    fallbackPairs: bad,
  };
  for (const k of bad) merged[k] = cg[k];
  return merged;
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Response.json(cache.body, {
      headers: {
        "cache-control": "public, max-age=15, stale-while-revalidate=60",
      },
    });
  }

  let body: PricesResponse | null = await fetchPragmaWithFallback();
  if (!body) {
    try {
      body = await fetchCoinGecko();
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "unknown" },
        { status: 502 },
      );
    }
  }

  cache = { at: Date.now(), body };
  return Response.json(body, {
    headers: {
      "cache-control": "public, max-age=15, stale-while-revalidate=60",
    },
  });
}

export type { PricesResponse, PriceSource };
