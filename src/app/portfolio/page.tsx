"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useAccount } from "wagmi";

import { NavBar } from "../../components/NavBar";

// Client-only — pulls in the Miden WASM bundle on hydration.
const PortfolioConnectionBanner = dynamic(
  () =>
    import("../../components/PortfolioConnectionBanner").then(
      (m) => m.PortfolioConnectionBanner,
    ),
  { ssr: false },
);
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
const SelfCustodyPositionsSection = dynamic(
  () =>
    import("../../components/SelfCustodyPositionsSection").then(
      (m) => m.SelfCustodyPositionsSection,
    ),
  { ssr: false },
);

export default function PortfolioPage() {
  const { isConnected } = useAccount();

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
          Your Darwin positions.
        </h1>
        <p style={{ color: "var(--ink-2)", maxWidth: 720, fontSize: 16, lineHeight: 1.55 }}>
          Self-custody positions held directly on the Darwin controller —
          written by your own browser or executed by the Miden network
          itself. Open a position from the{" "}
          <Link href="/baskets" style={{ borderBottom: "1px dotted var(--rule)" }}>
            baskets page
          </Link>
          .
        </p>

        <PortfolioConnectionBanner />

        {isConnected && <SelfCustodyPositionsSection />}

        {/* Miden-side positions — always rendered; the component itself
            handles the 'connect a Miden wallet' fallback. */}
        <MidenPortfolioSection />

        <SelfCustodyWalletPanel />
      </main>
    </>
  );
}
