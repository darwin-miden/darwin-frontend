"use client";

/**
 * Trustless redeem — dedicated route.
 *
 * Kept isolated from `/trustless` for the same RefCell-contention
 * reason: the redeem flow's send() + useNotes subscription + useConsume
 * all share the WASM client, and mounting the deposit panel alongside
 * multiplies the number of periodic-store readers into races that
 * panic mid-P2IDE-prove. One panel per route.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { ConnectKitButton } from "connectkit";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import {
  BASKET_TOKEN_FAUCETS,
  type BasketSymbol,
} from "../../../lib/midenConstants";

const TrustlessRedeemPanel = dynamic(
  () =>
    import("../../../components/TrustlessRedeemPanel").then(
      (m) => m.TrustlessRedeemPanel,
    ),
  { ssr: false },
);

function TrustlessRedeemPageInner() {
  const params = useSearchParams();
  const rawSymbol = params.get("basket");
  const faucet =
    rawSymbol && rawSymbol in BASKET_TOKEN_FAUCETS
      ? BASKET_TOKEN_FAUCETS[rawSymbol as BasketSymbol]
      : null;
  const basket = faucet
    ? { symbol: faucet.symbol, faucetHex: faucet.id }
    : undefined;
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
          href="/trustless"
          style={{
            fontSize: 14,
            fontFamily: "var(--font-mono-stack)",
            letterSpacing: "0.08em",
            textDecoration: "none",
            color: "var(--ink)",
          }}
        >
          ← Deposit
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
        {basket ? `Self-custody withdraw · ${basket.symbol}` : "Trustless redeem"}
      </h1>
      <p style={{ fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 32 }}>
        Miden → Sepolia via Epoch. Your derived wallet spends dUSDC into
        a P2IDE note; Epoch&apos;s solver consumes it and delivers USDC
        to your Sepolia address. No user tx on Sepolia, no Darwin backend.
      </p>

      <TrustlessRedeemPanel basket={basket} />
    </main>
  );
}


export default function TrustlessRedeemPage() {
  return (
    <Suspense fallback={null}>
      <TrustlessRedeemPageInner />
    </Suspense>
  );
}
