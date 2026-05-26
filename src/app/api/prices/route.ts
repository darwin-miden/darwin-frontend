/**
 * USD price feed for the four Darwin basket constituents.
 *
 * Two data sources, picked at request time:
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
 * The response's `source` field tags which path produced the
 * numbers so the UI badge can update without a code change.
 *
 * Node runtime (not edge) because we need `child_process` to
 * invoke the Rust binary.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const revalidate = 30;

const execP = promisify(exec);

interface PricesResponse {
  source: "coingecko" | "pragma-miden";
  fetchedAt: number;
  eth: number;
  wbtc: number;
  usdt: number;
  dai: number;
  latencyMs?: number;
}

const CG_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,wrapped-bitcoin,tether,dai&vs_currencies=usd";

const PRAGMA_BIN = process.env.DARWIN_PRAGMA_BIN;
const PRAGMA_TIMEOUT_MS = 8_000;

let cache: { at: number; body: PricesResponse } | null = null;
const CACHE_TTL_MS = 30_000;

// Background warm-up: re-poll Pragma every WARM_INTERVAL_MS so the
// cache is always fresh, and a user request never pays the cold
// shell-out cost. Pragma stays the source of truth — this is just a
// memoised snapshot of its last reading, not a publisher relay.
//
// Disabled when DARWIN_PRAGMA_BIN is unset (no oracle path to warm)
// or when running in the build/edge phase (`globalThis.window` is
// undefined but `process.env.NEXT_PHASE` flags non-runtime invocations).
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
    const body = await fetchPragma();
    if (body) cache = { at: Date.now(), body };
  };
  // Fire-and-forget initial warm + recurring interval. `unref()` so
  // the timer doesn't keep Node alive during graceful shutdown.
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
  const upstream = await fetch(CG_URL, {
    next: { revalidate: 30 },
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

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Response.json(cache.body, {
      headers: {
        "cache-control": "public, max-age=15, stale-while-revalidate=60",
      },
    });
  }

  let body: PricesResponse | null = await fetchPragma();
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

export type { PricesResponse };
