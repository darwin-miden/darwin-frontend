"use client";

/**
 * Live target NAV strip + per-constituent prices for a basket.
 * Rendered on /baskets/[symbol] above the deposit panel.
 *
 * Computes the *target* NAV (sum of weight × live price). The
 * controller's actual vault composition only matches the target
 * after a rebalance, so this is indicative; the on-chain figure
 * lands when the controller's NAV procedure is wired (M4).
 */

import { basketBySymbol, type BasketSymbol } from "../lib/baskets";
import { basketNav, usePrices } from "../lib/prices";

const PRICE_KEY: Record<string, "eth" | "wbtc" | "usdt" | "dai"> = {
  "darwin-eth":  "eth",
  "darwin-wbtc": "wbtc",
  "darwin-usdt": "usdt",
  "darwin-dai":  "dai",
};

const ASSET_LABEL: Record<string, string> = {
  "darwin-eth":  "ETH",
  "darwin-wbtc": "BTC",
  "darwin-usdt": "USDT",
  "darwin-dai":  "DAI",
};

export function LiveBasketStats({ symbol }: { symbol: BasketSymbol }) {
  const basket = basketBySymbol(symbol);
  const { data, isLoading, error } = usePrices();
  const nav = basketNav(basket, data);

  return (
    <div
      style={{
        marginTop: 24,
        padding: "16px 20px",
        background: "var(--paper-2)",
        borderTop: "1px solid var(--rule)",
        borderBottom: "1px solid var(--rule)",
        display: "grid",
        gridTemplateColumns: "auto 1fr",
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
        >
          {nav != null
            ? `$${nav.toFixed(2)}`
            : isLoading
              ? "…"
              : error
                ? "—"
                : "$—"}
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
        {basket.constituents.map((c) => {
          const key = PRICE_KEY[c.faucetAlias];
          const price = data?.[key];
          return (
            <div key={c.faucetAlias}>
              <span style={{ color: "var(--ink-3)" }}>
                {ASSET_LABEL[c.faucetAlias] ?? c.faucetAlias}
              </span>{" "}
              <span style={{ color: "var(--ink)" }}>
                {price == null
                  ? "—"
                  : price >= 100
                    ? `$${price.toFixed(0)}`
                    : `$${price.toFixed(price >= 1 ? 2 : 4)}`}
              </span>
              <span style={{ color: "var(--ink-3)" }}>
                {" "}
                · {(c.targetWeightBps / 100).toFixed(0)}%
              </span>
            </div>
          );
        })}
        {data && (
          <div style={{ marginLeft: "auto", color: "var(--ink-3)" }}>
            via {data.source}
          </div>
        )}
      </div>
    </div>
  );
}
