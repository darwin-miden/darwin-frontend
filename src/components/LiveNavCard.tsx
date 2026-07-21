"use client";

/**
 * Live target-NAV card for a basket. Refreshes every 10s, shows the
 * measured client-side latency next to the figure so the proposal
 * claim ("Private NAV calc using oracle prices <200ms") is visible
 * directly in the UI.
 *
 * The displayed source tag matches the /api/prices route — currently
 * CoinGecko spot via a Vercel Edge function. The figure is the
 * *target* NAV (Σ target_weight × price), not the controller's
 * on-chain compute_nav (which divides actual vault value by supply);
 * they match immediately after a rebalance and drift otherwise. See
 * lib/navOffchain for the precise relationship.
 */
import { useEffect, useState } from "react";

import type { BasketSymbol } from "../lib/baskets";
import { isNavBasket } from "../lib/basketFaucets";
import { useNavLive } from "../lib/useNavLive";

const ASSET_LABEL: Record<string, string> = {
  "darwin-eth":  "ETH",
  "darwin-wbtc": "BTC",
  "darwin-usdt": "USDT",
  "darwin-dai":  "DAI",
};

function latencyColor(ms: number | null): string {
  if (ms == null) return "var(--ink-3)";
  if (ms <= 200) return "#1d7a3a";
  if (ms <= 500) return "#a06a14";
  return "#a01a1a";
}

export function LiveNavCard({ symbol }: { symbol: BasketSymbol }) {
  const { data, latencyMs, isFetching, error } = useNavLive(symbol);

  // For NAV baskets the headline is the price of ONE token (live NAV-per-share
  // ≈ $1), NOT the notional "unit" index level (Σ weight × price ≈ $27k) — the
  // token you hold and see in the portfolio is the per-share one, so showing
  // the index level made "1 DCC" look like it cost $27k. Fetch the per-share
  // NAV so the basket page and the portfolio agree.
  const nav = isNavBasket(symbol);
  const [perShare, setPerShare] = useState<number | null>(null);
  useEffect(() => {
    if (!nav) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/nav-status?basket=${symbol}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d) return;
          const n = Number(d.navPerShareUsd);
          setPerShare(Number.isFinite(n) && n > 0 ? n : 1);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol, nav]);

  return (
    <div
      style={{
        marginTop: 16,
        padding: "16px 20px",
        background: "var(--paper-2)",
        border: "1px solid var(--rule)",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 24,
        alignItems: "center",
      }}
    >
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 11,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          {nav ? `NAV / ${symbol}` : "Target NAV / unit"}
        </div>
        <div
          style={{
            fontSize: 26,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            marginTop: 2,
          }}
          data-testid="live-nav-value"
        >
          {nav
            ? perShare != null
              ? `$${perShare.toFixed(4)}`
              : isFetching
                ? "…"
                : "—"
            : data
              ? `$${data.navUsd.toFixed(2)}`
              : isFetching
                ? "…"
                : "—"}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          fontSize: 12,
          fontFamily: "var(--font-mono-stack)",
          color: "var(--ink-2)",
        }}
      >
        {data?.breakdown.map((b) => (
          <div key={b.faucetAlias}>
            <span style={{ color: "var(--ink-3)" }}>
              {ASSET_LABEL[b.faucetAlias] ?? b.faucetAlias}
            </span>{" "}
            <span style={{ color: "var(--ink)" }}>
              {b.priceUsd >= 100
                ? `$${b.priceUsd.toFixed(0)}`
                : `$${b.priceUsd.toFixed(b.priceUsd >= 1 ? 2 : 4)}`}
            </span>
            <span style={{ color: "var(--ink-3)" }}>
              {" "}
              · {(b.weightBps / 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          color: "var(--ink-3)",
          minWidth: 110,
        }}
      >
        <span
          data-testid="live-nav-latency"
          style={{ color: latencyColor(latencyMs), fontWeight: 600 }}
        >
          {latencyMs == null ? "— ms" : `${latencyMs} ms`}
        </span>
        <span data-testid="live-nav-source">
          via {data?.source ?? "—"}
        </span>
        {/* Auto-refreshes every 10s via the useNavLive hook's
            refetchInterval. We show a passive "refreshing…" hint while
            React Query is fetching but never block on it — no manual
            refresh button is needed and clicking one would just race
            the auto tick. */}
        <span
          aria-live="polite"
          style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}
        >
          {isFetching ? "refreshing…" : "auto · 10s"}
        </span>
      </div>
      {/* Only surface a transient fetch error if we have NO data at
          all. Once a successful tick lands, errors from later 502s
          (e.g. a CoinGecko rate-limit hiccup) shouldn't pollute the
          UI — the next 10s tick will recover on its own. */}
      {error != null && data == null && (
        <div
          style={{
            gridColumn: "1 / -1",
            marginTop: 10,
            padding: 8,
            background: "#fff0f0",
            fontSize: 11,
            color: "#a01a1a",
            fontFamily: "var(--font-mono-stack)",
          }}
        >
          {error instanceof Error ? error.message : String(error)}
        </div>
      )}
    </div>
  );
}
