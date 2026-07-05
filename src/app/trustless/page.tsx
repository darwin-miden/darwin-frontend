"use client";

/**
 * Trustless deposit — dedicated route.
 *
 * Nothing else mounts on this page. Every other Miden-touching panel
 * (SelfCustodyWalletPanel with its useAccounts poll, UserPositionPanel,
 * MidenNativePositionsPanel, etc.) shares the WASM client's RefCell
 * with the create-wallet + execute-transaction futures on the trustless
 * flow and races them into a `RefCell already borrowed` panic. Keeping
 * this route bare eliminates the contention.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { ConnectKitButton } from "connectkit";

const TrustlessDepositPanel = dynamic(
  () =>
    import("../../components/TrustlessDepositPanel").then(
      (m) => m.TrustlessDepositPanel,
    ),
  { ssr: false },
);

export default function TrustlessPage() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "40px auto",
        padding: "0 24px",
        fontFamily: "var(--font-body-stack)",
      }}
    >
      <nav
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 32,
          paddingBottom: 12,
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <Link
          href="/"
          style={{
            fontSize: 14,
            fontFamily: "var(--font-mono-stack)",
            letterSpacing: "0.08em",
            textDecoration: "none",
            color: "var(--ink)",
          }}
        >
          ← Darwin
        </Link>
        <ConnectKitButton />
      </nav>

      <h1
        style={{
          fontSize: 28,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "-0.01em",
          marginBottom: 8,
        }}
      >
        Trustless deposit
      </h1>
      <p style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 32 }}>
        Fully browser-side flow — Miden signing key derived from a
        MetaMask signature, Sepolia → Miden bridge via Epoch, position
        credit written against a <code>NoAuth</code> Darwin controller.
        Zero Darwin backend involved after the initial page load.
      </p>

      <TrustlessDepositPanel />
    </main>
  );
}
