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
  POOL_FUNDING,
} from "../../../lib/testnet-state";
import { basketBySymbolUpper } from "../../../lib/contracts";

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

function midenscanAccount(id: string) {
  return `${MIDENSCAN_BASE}/account/${id}`;
}

function txUrl(id: string) {
  return `${MIDENSCAN_BASE}/tx/${id}`;
}

const ASSET_TO_FAUCET_ALIAS: Record<string, string> = {
  dWBTC: "darwin-wbtc",
  dETH: "darwin-eth",
  dUSDT: "darwin-usdt",
  dDAI: "darwin-dai",
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

  const tokenFaucet = DEPLOYED_ACCOUNTS.find(
    (a) => a.role === "basket-faucet" && a.symbol === basket.symbol,
  );
  const stubController = DEPLOYED_ACCOUNTS.find(
    (a) => a.role === "controller" && a.symbol === basket.symbol,
  );
  const v2Controller = DEPLOYED_ACCOUNTS.find(
    (a) => a.label.includes("v2 controller"),
  );
  const v3Controller = DEPLOYED_ACCOUNTS.find(
    (a) => a.label.includes("v3 controller"),
  );

  const funding = POOL_FUNDING.filter((p) => p.basket === basket.symbol);

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

        <div className="section-tag" style={{ marginTop: 18 }}>
          <span className="tag-num">{basket.symbol}</span>
          {basket.name}
        </div>

        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          {basket.name}{" "}
          <em style={{ color: "var(--ink-3)", fontWeight: 400 }}>
            ({basket.symbol})
          </em>
        </h1>
        <p
          style={{
            color: "var(--ink-2)",
            maxWidth: 720,
            fontSize: 17,
            lineHeight: 1.55,
            margin: "8px 0 0",
          }}
        >
          {basket.description}
        </p>

        {/* Deposit panel (real Sepolia tx via wagmi). Skipped if the
            basket isn't in the Sepolia BasketRegistry (shouldn't
            happen for DCC/DAG/DCO). */}
        {(() => {
          const ethBasket = basketBySymbolUpper(basket.symbol);
          return ethBasket ? <DepositPanel basket={ethBasket} /> : null;
        })()}

        {/* Constituents */}
        <section style={{ marginTop: 56 }}>
          <h2
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              borderBottom: "1px solid var(--ink)",
              paddingBottom: 8,
              marginBottom: 20,
            }}
          >
            Target weights
          </h2>
          <div
            style={{
              display: "flex",
              height: 32,
              border: "1px solid var(--ink)",
              overflow: "hidden",
            }}
          >
            {basket.constituents.map((c, i) => (
              <div
                key={c.faucetAlias}
                title={`${c.faucetAlias} ${formatWeight(c.targetWeightBps)}`}
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
                  letterSpacing: "0.05em",
                }}
              >
                {c.faucetAlias.replace("darwin-", "")} {formatWeight(c.targetWeightBps)}
              </div>
            ))}
          </div>

          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 14,
              marginTop: 20,
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
                <th style={{ textAlign: "left", padding: "10px 12px" }}>
                  Asset
                </th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>
                  Pragma pair
                </th>
                <th style={{ textAlign: "right", padding: "10px 12px" }}>
                  Weight
                </th>
              </tr>
            </thead>
            <tbody>
              {basket.constituents.map((c) => (
                <tr
                  key={c.faucetAlias}
                  style={{ borderBottom: "1px solid var(--rule-2)" }}
                >
                  <td style={{ padding: "12px" }}>
                    <code>{c.faucetAlias}</code>
                  </td>
                  <td style={{ padding: "12px" }}>
                    <code>{c.pragmaPair}</code>
                  </td>
                  <td
                    style={{
                      padding: "12px",
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
        </section>

        {/* Deployed accounts */}
        <section style={{ marginTop: 56 }}>
          <h2
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              borderBottom: "1px solid var(--ink)",
              paddingBottom: 8,
              marginBottom: 20,
            }}
          >
            On-chain backing
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {tokenFaucet && (
              <DeployCard
                title="Basket-token faucet"
                subtitle={tokenFaucet.label}
                id={tokenFaucet.accountId}
              />
            )}
            {stubController && (
              <DeployCard
                title="v1 controller (stub)"
                subtitle="header-only, M1 deliverable #1"
                id={stubController.accountId}
              />
            )}
            {v2Controller && (
              <DeployCard
                title="v2 controller (shared)"
                subtitle="real bodies + receive_asset"
                id={v2Controller.accountId}
              />
            )}
            {v3Controller && (
              <DeployCard
                title="v3 controller (storage-aware)"
                subtitle="M2 read_pool_position"
                id={v3Controller.accountId}
              />
            )}
          </div>
        </section>

        {/* Pool funding for this basket */}
        {funding.length > 0 && (
          <section style={{ marginTop: 56 }}>
            <h2
              style={{
                fontSize: 14,
                fontFamily: "var(--font-mono-stack)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                borderBottom: "1px solid var(--ink)",
                paddingBottom: 8,
                marginBottom: 20,
              }}
            >
              Pool funding — primary mints
            </h2>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13.5,
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
                  <th style={{ textAlign: "left", padding: "10px 12px" }}>
                    Asset
                  </th>
                  <th style={{ textAlign: "right", padding: "10px 12px" }}>
                    Amount
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px" }}>
                    Mint tx
                  </th>
                </tr>
              </thead>
              <tbody>
                {funding.map((p) => {
                  const alias = ASSET_TO_FAUCET_ALIAS[p.asset];
                  return (
                    <tr
                      key={p.mintTx}
                      style={{ borderBottom: "1px solid var(--rule-2)" }}
                    >
                      <td style={{ padding: "10px 12px" }}>
                        {p.asset}
                        {alias && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontFamily: "var(--font-mono-stack)",
                              fontSize: 11,
                              color: "var(--ink-3)",
                            }}
                          >
                            {alias}
                          </span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "10px 12px",
                          textAlign: "right",
                          fontFamily: "var(--font-mono-stack)",
                        }}
                      >
                        {p.amount.toLocaleString()}
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <a
                          href={txUrl(p.mintTx)}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontFamily: "var(--font-mono-stack)",
                            fontSize: 12,
                            borderBottom: "1px dotted var(--rule)",
                          }}
                        >
                          {p.mintTx.slice(0, 18)}…
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
  );
}

function DeployCard({
  title,
  subtitle,
  id,
}: {
  title: string;
  subtitle: string;
  id: string;
}) {
  return (
    <a
      href={midenscanAccount(id)}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "block",
        padding: "16px 18px",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
        textDecoration: "none",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.1em",
          color: "var(--ink-3)",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 14.5,
          fontWeight: 500,
          color: "var(--ink)",
        }}
      >
        {subtitle}
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: "var(--font-mono-stack)",
          fontSize: 12,
          color: "var(--ink-2)",
          wordBreak: "break-all",
        }}
      >
        {id}
      </div>
    </a>
  );
}
