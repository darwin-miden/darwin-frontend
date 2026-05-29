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
import type { BasketSymbol } from "../lib/baskets";
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
  const { data, latencyMs, isFetching, refetch, error } = useNavLive(symbol);

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
          Target NAV / unit
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
          {data ? `$${data.navUsd.toFixed(2)}` : isFetching ? "…" : "—"}
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
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          style={{
            marginTop: 4,
            padding: "2px 8px",
            fontSize: 10,
            background: "var(--ink)",
            color: "var(--paper)",
            border: 0,
            cursor: isFetching ? "wait" : "pointer",
          }}
        >
          {isFetching ? "…" : "refresh"}
        </button>
      </div>
      {error != null && (
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
