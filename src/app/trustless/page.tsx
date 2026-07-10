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
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import {
  BASKET_TOKEN_FAUCETS,
  type BasketSymbol,
} from "../../lib/midenConstants";

const TrustlessDepositPanel = dynamic(
  () =>
    import("../../components/TrustlessDepositPanel").then(
      (m) => m.TrustlessDepositPanel,
    ),
  { ssr: false },
);


function TrustlessPageInner() {
  // ?basket=DCC → credit the per-(user, basket) slot instead of the
  // legacy flat demo slot. Set by the Self-custody tab on the basket
  // pages.
  const params = useSearchParams();
  const rawSymbol = params.get("basket");
  // Network rail is the default; ?network=0 opts back into the legacy
  // NoAuth flow (needed to manage positions written under that rail).
  const network = params.get("network") !== "0";
  // ?embed=1: rendered inside the basket page's Self-custody tab via a
  // same-origin iframe (the flow needs the bare Miden provider, which is
  // routed by pathname — an iframe gives it its own provider + WASM
  // context without navigating away). Chrome is stripped; the wagmi
  // connection is shared through same-origin storage.
  const embed = params.get("embed") === "1";
  const faucet =
    rawSymbol && rawSymbol in BASKET_TOKEN_FAUCETS
      ? BASKET_TOKEN_FAUCETS[rawSymbol as BasketSymbol]
      : null;
  const basket = faucet
    ? { symbol: faucet.symbol, faucetHex: faucet.id }
    : undefined;
  if (embed) {
    return (
      <main style={{ padding: "8px 4px", fontFamily: "var(--font-body-stack)" }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <ConnectKitButton />
        </div>
        <TrustlessDepositPanel basket={basket} compact network={network} />
      </main>
    );
  }

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
        {basket ? `Self-custody deposit · ${basket.symbol}` : "Trustless deposit"}
      </h1>
      <p style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 32 }}>
            {network
              ? "Fully browser-side flow — Miden signing key derived from a MetaMask signature, Sepolia → Miden bridge via Epoch, then your browser emits a deposit note that the Miden network itself executes against the Darwin controller (vault + position). Zero Darwin backend after the initial page load."
              : "Fully browser-side flow — Miden signing key derived from a MetaMask signature, Sepolia → Miden bridge via Epoch, position credit written against a NoAuth Darwin controller. Zero Darwin backend involved after the initial page load."}
          </p>
      <p style={{ fontSize: 13, marginBottom: 32 }}>
        Need to redeem?{" "}
        <Link
          href={basket ? `/trustless/redeem?basket=${basket.symbol}` : "/trustless/redeem"}
          style={{
            fontFamily: "var(--font-mono-stack)",
            textDecoration: "underline",
            color: "var(--ink)",
          }}
        >
          Miden → Sepolia via Epoch →
        </Link>
      </p>

      <TrustlessDepositPanel basket={basket} compact={!!basket} network={network} />
    </main>
  );
}


export default function TrustlessPage() {
  return (
    <Suspense fallback={null}>
      <TrustlessPageInner />
    </Suspense>
  );
}
