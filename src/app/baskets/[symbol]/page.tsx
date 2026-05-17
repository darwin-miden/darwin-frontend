import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { NavBar } from "../../../components/NavBar";
import { DepositPanel } from "../../../components/DepositPanel";
import {
  BASKETS,
  basketBySymbol,
  formatWeight,
  type BasketSymbol,
} from "../../../lib/baskets";
import {
  DEPLOYED_ACCOUNTS,
  MIDENSCAN_BASE,
} from "../../../lib/testnet-state";
import {
  basketBySymbolUpper,
  sepoliaAddressUrl,
} from "../../../lib/contracts";

export function generateStaticParams() {
  return BASKETS.map((b) => ({ symbol: b.symbol.toLowerCase() }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  const sym = symbol.toUpperCase() as BasketSymbol;
  try {
    const b = basketBySymbol(sym);
    return {
      title: `${b.symbol} · ${b.name} — Darwin basket`,
      description: b.description,
    };
  } catch {
    return { title: "Basket not found — Darwin" };
  }
}

const ASSET_DISPLAY: Record<string, { label: string; emoji: string }> = {
  "darwin-eth": { label: "Ethereum", emoji: "Ξ" },
  "darwin-wbtc": { label: "Bitcoin", emoji: "₿" },
  "darwin-usdt": { label: "USDT", emoji: "$" },
  "darwin-dai": { label: "DAI", emoji: "$" },
};

const FLAVOUR: Record<
  BasketSymbol,
  { tagline: string; risk: string; riskColor: string }
> = {
  DCC: {
    tagline: "Blue-chip BTC + ETH with a stable buffer",
    risk: "balanced",
    riskColor: "#3aa05a",
  },
  DAG: {
    tagline: "Pure BTC + ETH, full crypto exposure",
    risk: "aggressive",
    riskColor: "#d23f3f",
  },
  DCO: {
    tagline: "Mostly stables, light crypto. Capital preservation.",
    risk: "conservative",
    riskColor: "#3a6aa0",
  },
};

export default async function BasketDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  const symU = symbol.toUpperCase();
  if (symU !== "DCC" && symU !== "DAG" && symU !== "DCO") {
    notFound();
  }
  const basket = basketBySymbol(symU as BasketSymbol);
  const flavour = FLAVOUR[basket.symbol];
  const ethBasket = basketBySymbolUpper(basket.symbol);

  const v2Controller = DEPLOYED_ACCOUNTS.find((a) =>
    a.label.includes("v2 controller"),
  );
  const v4Controller = DEPLOYED_ACCOUNTS.find((a) =>
    a.label.includes("v4 controller"),
  );

  return (
    <>
      <NavBar active="baskets" />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <Link
          href="/baskets"
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 12,
            color: "var(--ink-3)",
            borderBottom: "1px dotted var(--rule)",
          }}
        >
          ← all baskets
        </Link>

        {/* Header */}
        <div style={{ marginTop: 22 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 14,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            <h1
              style={{
                fontSize: "clamp(2rem, 4vw, 3rem)",
                margin: 0,
                letterSpacing: "-0.015em",
                lineHeight: 1.05,
              }}
            >
              {basket.name}
            </h1>
            <span
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: 14,
                color: "var(--ink-3)",
              }}
            >
              {basket.symbol}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono-stack)",
                fontSize: 11,
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
          <p
            style={{
              color: "var(--ink-2)",
              maxWidth: 720,
              fontSize: 17,
              lineHeight: 1.55,
              margin: "8px 0 0",
            }}
          >
            {flavour.tagline}.
          </p>
        </div>

        {/* Two-column layout: deposit panel + what's inside */}
        <div
          style={{
            marginTop: 40,
            display: "grid",
            gridTemplateColumns: "1.3fr 1fr",
            gap: 32,
          }}
        >
          <div>
            {ethBasket ? (
              <DepositPanel basket={ethBasket} />
            ) : (
              <p style={{ color: "var(--ink-3)" }}>Deposit not yet wired for this basket.</p>
            )}
          </div>

          <aside>
            <h2
              style={{
                fontSize: 14,
                fontFamily: "var(--font-mono-stack)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderBottom: "1px solid var(--ink)",
                paddingBottom: 8,
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              What&apos;s inside
            </h2>

            {/* Weight bar */}
            <div
              style={{
                display: "flex",
                height: 28,
                border: "1px solid var(--ink)",
                overflow: "hidden",
                marginBottom: 12,
              }}
            >
              {basket.constituents.map((c, i) => (
                <div
                  key={c.faucetAlias}
                  title={`${ASSET_DISPLAY[c.faucetAlias]?.label ?? c.faucetAlias} ${formatWeight(c.targetWeightBps)}`}
                  style={{
                    flexGrow: c.targetWeightBps,
                    flexBasis: 0,
                    background:
                      i % 2 === 0
                        ? "var(--ink)"
                        : "color-mix(in srgb, var(--orange) 80%, var(--ink) 20%)",
                    color: "var(--paper)",
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: 11,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    letterSpacing: "0.04em",
                  }}
                >
                  {formatWeight(c.targetWeightBps)}
                </div>
              ))}
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
                      padding: "8px 0",
                      borderBottom: "1px solid var(--rule-2)",
                      fontSize: 15,
                    }}
                  >
                    <span>
                      <span
                        style={{
                          display: "inline-block",
                          width: 22,
                          color: "var(--orange)",
                          fontFamily: "var(--font-mono-stack)",
                          fontSize: 16,
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
          </aside>
        </div>

        {/* Collapsible technical details */}
        <details style={{ marginTop: 56 }}>
          <summary
            style={{
              cursor: "pointer",
              fontFamily: "var(--font-mono-stack)",
              fontSize: 12,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              paddingBottom: 12,
              borderBottom: "1px solid var(--rule)",
            }}
          >
            ▸ Technical details (for grant reviewers + developers)
          </summary>

          <div style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 14, margin: "0 0 12px" }}>On-chain contracts</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                gap: 16,
              }}
            >
              {ethBasket && (
                <ContractCard
                  title="Sepolia ERC20"
                  subtitle={`${basket.symbol} (the token your wallet sees)`}
                  address={ethBasket.tokenAddress}
                  href={sepoliaAddressUrl(ethBasket.tokenAddress)}
                />
              )}
              {v2Controller && (
                <ContractCard
                  title="Miden v2 controller"
                  subtitle="Real-bodies controller (Flow A receive_asset)"
                  address={v2Controller.accountId}
                  href={`${MIDENSCAN_BASE}/account/${v2Controller.accountId}`}
                />
              )}
              {v4Controller && (
                <ContractCard
                  title="Miden v4 controller"
                  subtitle="Rebalance-aware (Flow B execute_rebalance_step)"
                  address={v4Controller.accountId}
                  href={`${MIDENSCAN_BASE}/account/${v4Controller.accountId}`}
                />
              )}
            </div>

            <h3 style={{ fontSize: 14, margin: "32px 0 12px" }}>Pragma pair mapping</h3>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--rule)",
                    color: "var(--ink-3)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono-stack)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  <th style={{ textAlign: "left", padding: "8px 12px" }}>Asset</th>
                  <th style={{ textAlign: "left", padding: "8px 12px" }}>Pragma pair</th>
                  <th style={{ textAlign: "right", padding: "8px 12px" }}>Target weight</th>
                </tr>
              </thead>
              <tbody>
                {basket.constituents.map((c) => (
                  <tr
                    key={c.faucetAlias}
                    style={{ borderBottom: "1px solid var(--rule-2)" }}
                  >
                    <td style={{ padding: "10px 12px" }}>
                      <code>{c.faucetAlias}</code>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <code>{c.pragmaPair}</code>
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        textAlign: "right",
                        fontFamily: "var(--font-mono-stack)",
                      }}
                    >
                      {formatWeight(c.targetWeightBps)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p
              style={{
                marginTop: 16,
                fontSize: 12,
                color: "var(--ink-3)",
                lineHeight: 1.55,
              }}
            >
              Operator drift dashboard + rebalance trigger live at{" "}
              <Link
                href="/admin/drift"
                style={{ borderBottom: "1px dotted var(--rule)" }}
              >
                /admin/drift
              </Link>
              . Every Sepolia + Miden account at{" "}
              <Link href="/accounts" style={{ borderBottom: "1px dotted var(--rule)" }}>
                /accounts
              </Link>
              .
            </p>
          </div>
        </details>
      </main>
    </>
  );
}

function ContractCard({
  title,
  subtitle,
  address,
  href,
}: {
  title: string;
  subtitle: string;
  address: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "block",
        padding: "14px 16px",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {title}
      </div>
      <div style={{ marginTop: 2, fontSize: 13, color: "var(--ink)" }}>
        {subtitle}
      </div>
      <div
        style={{
          marginTop: 6,
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11.5,
          color: "var(--ink-2)",
          wordBreak: "break-all",
        }}
      >
        {address}
      </div>
    </a>
  );
}
