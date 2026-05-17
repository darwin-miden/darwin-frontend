"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ConnectKitButton } from "connectkit";
import { useAccount, useReadContracts } from "wagmi";
import { formatUnits } from "viem";

import { NavBar } from "../../components/NavBar";

// Client-only — pulls in the Miden WASM bundle on hydration.
const MidenPortfolioSection = dynamic(
  () =>
    import("../../components/MidenPortfolioSection").then(
      (m) => m.MidenPortfolioSection,
    ),
  { ssr: false },
);
import {
  BASKET_TOKENS,
  DARWIN_RELAY_ADDRESS,
  ERC20_ABI,
  MOCK_USDC_ADDRESS,
  sepoliaAddressUrl,
} from "../../lib/contracts";

// Indicative mock prices in USD per basket-token unit. Production
// reads these from the on-chain Pragma adapter once the controller's
// NAV computation is wired into the basket-token. For the M3 preview
// we anchor on the bot's last live Pragma snapshot.
const BASKET_USD_PRICE_X1E6: Record<string, bigint> = {
  DCC: 1_000_000n, // 1 USDC ≈ 1 DCC at the demo's mint rate
  DAG: 1_000_000n,
  DCO: 1_000_000n,
};

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();

  const contracts = [
    {
      address: MOCK_USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: address ? [address] : undefined,
    },
    ...BASKET_TOKENS.map((b) => ({
      address: b.tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: address ? [address] : undefined,
    })),
  ];

  const { data, dataUpdatedAt } = useReadContracts({
    contracts,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  const usdcBalance = data?.[0]?.result as bigint | undefined;
  const basketBalances = BASKET_TOKENS.map((b, i) => ({
    basket: b,
    balance: (data?.[i + 1]?.result as bigint | undefined) ?? 0n,
  }));

  const totalUsdCents = basketBalances.reduce((acc, { basket, balance }) => {
    const price = BASKET_USD_PRICE_X1E6[basket.symbol] ?? 1_000_000n;
    return acc + (balance * price) / 1_000_000n;
  }, 0n);

  return (
    <>
      <NavBar active="portfolio" />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <div className="section-tag">
          <span className="tag-num">$$</span>Portfolio
        </div>
        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          Your Darwin baskets on Sepolia.
        </h1>
        <p style={{ color: "var(--ink-2)", maxWidth: 720, fontSize: 16, lineHeight: 1.55 }}>
          Balances of every Darwin basket ERC20 minted to your wallet by the
          relay. Refreshes every 8 s. Mint a fresh position on the{" "}
          <Link href="/baskets" style={{ borderBottom: "1px dotted var(--rule)" }}>
            baskets page
          </Link>
          .
        </p>

        {!isConnected && (
          <div
            style={{
              marginTop: 32,
              padding: "20px 24px",
              background: "var(--paper-2)",
              borderLeft: "3px solid var(--orange)",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16 }}>Connect a Sepolia wallet</h3>
            <p
              style={{
                color: "var(--ink-2)",
                fontSize: 14,
                lineHeight: 1.55,
                margin: "8px 0 16px",
              }}
            >
              Switch your wallet to the Sepolia network. MockUSDC is
              permissionless — you can self-mint on the baskets page.
            </p>
            <ConnectKitButton.Custom>
              {({ show }) => (
                <button
                  onClick={show}
                  style={{
                    padding: "10px 18px",
                    background: "var(--ink)",
                    color: "var(--paper)",
                    border: 0,
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  Connect wallet
                </button>
              )}
            </ConnectKitButton.Custom>
          </div>
        )}
        {isConnected && (
          <>
            <div
              style={{
                marginTop: 32,
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 0,
                borderTop: "1px solid var(--ink)",
                borderBottom: "1px solid var(--ink)",
              }}
            >
              <Stat
                label="Total basket value"
                value={formatUsdc(totalUsdCents)}
                unit="USD"
              />
              <Stat
                label="USDC available to deposit"
                value={formatUsdc(usdcBalance ?? 0n)}
                unit="USDC"
              />
            </div>

            <section style={{ marginTop: 48 }}>
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
                Your basket positions
              </h2>

              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
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
                    <th style={{ textAlign: "left", padding: "10px 12px" }}>Basket</th>
                    <th style={{ textAlign: "right", padding: "10px 12px" }}>Balance</th>
                    <th style={{ textAlign: "right", padding: "10px 12px" }}>USD value</th>
                    <th style={{ textAlign: "left", padding: "10px 12px" }}>Token contract</th>
                  </tr>
                </thead>
                <tbody>
                  {basketBalances.map(({ basket, balance }) => {
                    const price =
                      BASKET_USD_PRICE_X1E6[basket.symbol] ?? 1_000_000n;
                    const usd = (balance * price) / 1_000_000n;
                    return (
                      <tr
                        key={basket.symbol}
                        style={{ borderBottom: "1px solid var(--rule-2)" }}
                      >
                        <td style={{ padding: "14px 12px" }}>
                          <Link
                            href={`/baskets/${basket.symbol.toLowerCase()}`}
                            style={{
                              fontWeight: 500,
                              borderBottom: "1px dotted var(--rule)",
                            }}
                          >
                            {basket.symbol}
                          </Link>
                          <span style={{ marginLeft: 8, color: "var(--ink-3)" }}>
                            {basket.name}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            textAlign: "right",
                            fontFamily: "var(--font-mono-stack)",
                          }}
                        >
                          {format6(balance)}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            textAlign: "right",
                            fontFamily: "var(--font-mono-stack)",
                            color: balance > 0n ? "var(--ink)" : "var(--ink-3)",
                          }}
                        >
                          ${formatUsdc(usd)}
                        </td>
                        <td style={{ padding: "14px 12px" }}>
                          <a
                            href={sepoliaAddressUrl(basket.tokenAddress)}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              fontFamily: "var(--font-mono-stack)",
                              fontSize: 12,
                              borderBottom: "1px dotted var(--rule)",
                            }}
                          >
                            {basket.tokenAddress.slice(0, 8)}…{basket.tokenAddress.slice(-6)}
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <p
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: "var(--ink-3)",
                  lineHeight: 1.55,
                }}
              >
                Prices are placeholder until the controller's NAV computation
                is wired to the on-chain Pragma adapter. Last live Pragma
                snapshot: ETH $2,194 / BTC $78,121 / USDT $0.999 / DAI $0.999.
              </p>
            </section>

            <section style={{ marginTop: 48 }}>
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
                Relay contracts
              </h2>
              <p style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55 }}>
                Every deposit flows through{" "}
                <a
                  href={sepoliaAddressUrl(DARWIN_RELAY_ADDRESS)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderBottom: "1px dotted var(--rule)" }}
                >
                  DarwinRelayDeposit
                </a>{" "}
                ({DARWIN_RELAY_ADDRESS.slice(0, 10)}…). MockUSDC at{" "}
                <a
                  href={sepoliaAddressUrl(MOCK_USDC_ADDRESS)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderBottom: "1px dotted var(--rule)" }}
                >
                  {MOCK_USDC_ADDRESS.slice(0, 10)}…
                </a>{" "}
                is permissionless (anyone can call .mint(to, amount)).
              </p>
            </section>

            <p
              style={{
                marginTop: 24,
                fontSize: 11,
                color: "var(--ink-3)",
                fontFamily: "var(--font-mono-stack)",
              }}
            >
              Auto-refreshing every 8s ·{" "}
              {dataUpdatedAt
                ? `last update ${new Date(dataUpdatedAt).toLocaleTimeString()}`
                : "loading…"}
            </p>
          </>
        )}

        <MidenPortfolioSection />
      </main>
    </>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ padding: "24px 16px", borderRight: "1px solid var(--rule)" }}>
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 32,
          fontWeight: 500,
          letterSpacing: "-0.02em",
        }}
      >
        ${value}{" "}
        <span style={{ color: "var(--ink-3)", fontSize: 14 }}>{unit}</span>
      </div>
    </div>
  );
}

function format6(value: bigint): string {
  return formatUnits(value, 6);
}

function formatUsdc(value: bigint): string {
  const integer = value / 1_000_000n;
  const frac = value % 1_000_000n;
  if (frac === 0n) return integer.toString();
  return `${integer.toString()}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}
