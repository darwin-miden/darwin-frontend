"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ConnectKitButton } from "connectkit";
import { useAccount, useReadContracts } from "wagmi";
import { formatUnits } from "viem";

import { NavBar } from "../../components/NavBar";
import { basketBySymbol, type BasketSymbol } from "../../lib/baskets";
import { basketNav, usePrices } from "../../lib/prices";

// Client-only — pulls in the Miden WASM bundle on hydration.
const MidenPortfolioSection = dynamic(
  () =>
    import("../../components/MidenPortfolioSection").then(
      (m) => m.MidenPortfolioSection,
    ),
  { ssr: false },
);
const SelfCustodyWalletPanel = dynamic(
  () =>
    import("../../components/SelfCustodyWalletPanel").then(
      (m) => m.SelfCustodyWalletPanel,
    ),
  { ssr: false },
);
const RelayPositionsPanel = dynamic(
  () =>
    import("../../components/RelayPositionsPanel").then(
      (m) => m.RelayPositionsPanel,
    ),
  { ssr: false },
);
const RelayRedemptionsPanel = dynamic(
  () =>
    import("../../components/RelayRedemptionsPanel").then(
      (m) => m.RelayRedemptionsPanel,
    ),
  { ssr: false },
);
const BaliDepositPanel = dynamic(
  () =>
    import("../../components/BaliDepositPanel").then(
      (m) => m.BaliDepositPanel,
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

  const pricesQuery = usePrices();
  const navBySymbol: Record<string, number | null> = {};
  for (const { basket } of basketBalances) {
    navBySymbol[basket.symbol] = basketNav(
      basketBySymbol(basket.symbol as BasketSymbol),
      pricesQuery.data,
    );
  }

  // Sum in micro-USD to avoid floating drift; basket tokens are
  // 6-decimal on Sepolia (ERC20 mints from the relay).
  const totalUsdMicro = basketBalances.reduce((acc, { basket, balance }) => {
    const nav = navBySymbol[basket.symbol];
    if (nav == null) return acc;
    const priceMicro = BigInt(Math.round(nav * 1_000_000));
    return acc + (balance * priceMicro) / 1_000_000n;
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
                value={formatUsdc(totalUsdMicro)}
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
                    const nav = navBySymbol[basket.symbol];
                    const priceMicro =
                      nav == null
                        ? 0n
                        : BigInt(Math.round(nav * 1_000_000));
                    const usd = (balance * priceMicro) / 1_000_000n;
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
                {pricesQuery.data ? (
                  <>
                    NAV from{" "}
                    <strong>{pricesQuery.data.source}</strong>
                    {pricesQuery.data.source === "pragma-miden" && (
                      <>
                        {" "}(<code>get_median</code> on{" "}
                        <code>0xd0e1384e21a6350029d80128eb5c44</code>)
                      </>
                    )}
                    {typeof pricesQuery.data.latencyMs === "number" && (
                      <> · {pricesQuery.data.latencyMs}ms</>
                    )}{" "}
                    @ ETH ${pricesQuery.data.eth.toFixed(2)} · BTC $
                    {pricesQuery.data.wbtc.toFixed(0)} · USDT $
                    {pricesQuery.data.usdt.toFixed(4)} · DAI $
                    {pricesQuery.data.dai.toFixed(4)}.{" "}
                    {pricesQuery.data.source === "coingecko" && (
                      <>
                        Set <code>DARWIN_PRAGMA_BIN</code> on the server to
                        switch this to a live on-chain Pragma read.
                      </>
                    )}
                  </>
                ) : (
                  <>Fetching live prices…</>
                )}
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

        <RelayPositionsPanel />
        <RelayRedemptionsPanel />
        <BaliDepositPanel />
        <SelfCustodyWalletPanel />
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
