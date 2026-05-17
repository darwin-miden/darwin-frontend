import type { Metadata } from "next";
import Link from "next/link";

import { NavBar } from "../../components/NavBar";
import { BASKETS, type Basket, formatWeight } from "../../lib/baskets";

export const metadata: Metadata = {
  title: "Baskets — Darwin",
  description:
    "Three Darwin baskets you can deposit USDC into. Each basket is a private STARK-proven position on Miden, exposed as an ERC20 on Ethereum.",
};

// Plain-English names for the on-chain faucet aliases.
const ASSET_DISPLAY: Record<string, { label: string; emoji: string }> = {
  "darwin-eth": { label: "Ethereum", emoji: "Ξ" },
  "darwin-wbtc": { label: "Bitcoin", emoji: "₿" },
  "darwin-usdt": { label: "USDT", emoji: "$" },
  "darwin-dai": { label: "DAI", emoji: "$" },
};

// Risk pill copy per basket.
const BASKET_FLAVOUR: Record<
  Basket["symbol"],
  { tagline: string; risk: string; riskColor: string }
> = {
  DCC: {
    tagline: "BTC + ETH with a stable buffer",
    risk: "balanced",
    riskColor: "#3aa05a",
  },
  DAG: {
    tagline: "Pure BTC + ETH exposure",
    risk: "aggressive",
    riskColor: "#d23f3f",
  },
  DCO: {
    tagline: "Mostly stables, light crypto",
    risk: "conservative",
    riskColor: "#3a6aa0",
  },
};

export default function BasketsPage() {
  return (
    <>
      <NavBar active="baskets" />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <div className="section-tag">
          <span className="tag-num">01</span>Baskets
        </div>
        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          Pick a basket. Deposit USDC. Done.
        </h1>
        <p
          style={{
            color: "var(--ink-2)",
            maxWidth: 680,
            fontSize: 17,
            lineHeight: 1.55,
            margin: "8px 0 0",
          }}
        >
          Three pre-built crypto baskets, live on Sepolia. You deposit USDC,
          the Darwin relay mints the basket ERC20 to your wallet in about
          a minute. No Miden account, no proof generation, no friction.
        </p>

        <div
          style={{
            marginTop: 48,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 24,
          }}
        >
          {BASKETS.map((basket) => (
            <BasketCard key={basket.symbol} basket={basket} />
          ))}
        </div>

        <section style={{ marginTop: 64 }}>
          <p
            style={{
              fontSize: 13,
              color: "var(--ink-3)",
              lineHeight: 1.55,
              maxWidth: 720,
            }}
          >
            Behind the scenes: each basket is a private, STARK-proven position
            in a Darwin controller on Miden testnet. Pragma supplies prices
            live (ETH ≈ $2,194, BTC ≈ $78k at last refresh). For the operator
            view with drift + rebalance plan, see{" "}
            <Link
              href="/admin/drift"
              style={{ borderBottom: "1px dotted var(--rule)" }}
            >
              /admin/drift
            </Link>
            .
          </p>
        </section>
      </main>
    </>
  );
}

function BasketCard({ basket }: { basket: Basket }) {
  const flavour = BASKET_FLAVOUR[basket.symbol];

  return (
    <Link
      href={`/baskets/${basket.symbol.toLowerCase()}`}
      style={{
        display: "block",
        background: "var(--paper-2)",
        borderLeft: "4px solid var(--orange)",
        padding: "24px 26px",
        textDecoration: "none",
        color: "inherit",
        transition: "transform 120ms ease",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          {basket.symbol}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: flavour.riskColor,
            border: `1px solid ${flavour.riskColor}`,
            padding: "2px 8px",
            borderRadius: 2,
          }}
        >
          {flavour.risk}
        </span>
      </div>

      <h2
        style={{
          margin: "4px 0 6px",
          fontSize: 26,
          letterSpacing: "-0.015em",
          fontWeight: 500,
        }}
      >
        {basket.name}
      </h2>
      <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>
        {flavour.tagline}.
      </p>

      <div style={{ marginTop: 20 }}>
        <div
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 11,
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          What&apos;s inside
        </div>
        <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
          {basket.constituents.map((c) => {
            const meta = ASSET_DISPLAY[c.faucetAlias] ?? {
              label: c.faucetAlias,
              emoji: "•",
            };
            return (
              <li
                key={c.faucetAlias}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "6px 0",
                  borderBottom: "1px solid var(--rule-2)",
                  fontSize: 14,
                }}
              >
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 18,
                      color: "var(--orange)",
                      fontFamily: "var(--font-mono-stack)",
                    }}
                  >
                    {meta.emoji}
                  </span>
                  {meta.label}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    color: "var(--ink-2)",
                  }}
                >
                  {formatWeight(c.targetWeightBps)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div
        style={{
          marginTop: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: 14,
            color: "var(--ink-3)",
          }}
        >
          Mint &amp; manage
        </span>
        <span
          style={{
            padding: "10px 16px",
            background: "var(--ink)",
            color: "var(--paper)",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Deposit USDC →
        </span>
      </div>
    </Link>
  );
}
