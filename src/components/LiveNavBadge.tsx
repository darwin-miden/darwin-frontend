"use client";

import { basketBySymbol, type BasketSymbol } from "../lib/baskets";
import { basketNav, usePrices } from "../lib/prices";

/**
 * Compact live-NAV pill for the /baskets card grid. Falls back to
 * an em-dash while the price query is in flight.
 */
export function LiveNavBadge({ symbol }: { symbol: BasketSymbol }) {
  const { data } = usePrices();
  const nav = basketNav(basketBySymbol(symbol), data);

  return (
    <span
      style={{
        fontFamily: "var(--font-mono-stack)",
        fontSize: 11,
        letterSpacing: "0.05em",
        color: "var(--ink-3)",
      }}
      title={data ? `live ${data.source}` : "loading…"}
    >
      NAV{" "}
      <span style={{ color: "var(--ink)" }}>
        {nav == null ? "—" : `$${nav.toFixed(2)}`}
      </span>
    </span>
  );
}
