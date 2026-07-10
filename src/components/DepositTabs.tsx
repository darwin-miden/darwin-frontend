"use client";

/**
 * Two deposit paths, converging on the same basket position on Miden:
 *
 *   1. **Self-custody (default)** -> the user's browser derives a Miden
 *      wallet from one MetaMask signature, bridges Sepolia USDC via
 *      Epoch, then emits a deposit note the Miden network itself
 *      executes against the controller. Runs on its own route.
 *
 *   2. **Miden-native user** -> direct atomic_deposit_note via the
 *      Miden Web SDK in this tab. No bridge — the user's own Miden
 *      wallet sends straight to the controller.
 *
 * The earlier custodial relay rail (ETH wallet -> Epoch -> relay wallet
 * -> controller) is retired along with the 1Click-mock, Sepolia ESCROW
 * and wDCC ERC20 paths — commit history has them if a rollback is ever
 * needed. The network rail made the relay's job (executing deposits on
 * the user's behalf) a protocol feature.
 */

import dynamic from "next/dynamic";
import { useState } from "react";

import type { BasketDef } from "../lib/contracts";
import {
  basketBySymbol,
  type BasketSymbol,
} from "../lib/baskets";

const MidenDepositPanel = dynamic(
  () => import("./MidenDepositPanel").then((m) => m.MidenDepositPanel),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          padding: "1.2rem 1.4rem",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
          fontSize: 13,
          color: "var(--ink-3)",
        }}
      >
        loading Miden SDK…
      </div>
    ),
  },
);

type Tab = "miden" | "selfcustody";

export function DepositTabs({ basket }: { basket: BasketDef }) {
  const [tab, setTab] = useState<Tab>("selfcustody");
  const manifest = basketBySymbol(basket.symbol as BasketSymbol);

  return (
    <div>
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--rule)",
          marginBottom: 16,
        }}
      >
        <TabButton
          active={tab === "selfcustody"}
          onClick={() => setTab("selfcustody")}
          label="Self-custody"
          subtitle="Network-executed — no server, no extension"
        />
        <TabButton
          active={tab === "miden"}
          onClick={() => setTab("miden")}
          label="Miden wallet"
          subtitle="Atomic deposit note, browser-proven"
        />
      </div>

      {tab === "miden" && <MidenDepositPanel basket={manifest} />}
      {tab === "selfcustody" && <SelfCustodyPane symbol={basket.symbol} />}
    </div>
  );
}

/**
 * The self-custody flow runs INLINE via a same-origin iframe: the
 * trustless panels need the bare Miden provider (internal keystore, no
 * MidenFi signer wrapper), which Providers.tsx routes by pathname — an
 * iframe on /trustless?embed=1 gives them their own provider and WASM
 * context without navigating away, and the wagmi/MetaMask connection is
 * shared through same-origin storage. Deposit/withdraw toggle swaps the
 * iframe src.
 */
function SelfCustodyPane({ symbol }: { symbol: string }) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const src =
    mode === "deposit"
      ? `/trustless?basket=${encodeURIComponent(symbol)}&embed=1`
      : `/trustless/redeem?basket=${encodeURIComponent(symbol)}&embed=1`;
  return (
    <div
      style={{
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "baseline",
          padding: "10px 16px 0",
        }}
      >
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              background: "transparent",
              border: 0,
              padding: "2px 0",
              cursor: "pointer",
              fontSize: 13,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: mode === m ? "var(--ink)" : "var(--ink-3)",
              borderBottom:
                mode === m
                  ? "2px solid var(--orange)"
                  : "2px solid transparent",
            }}
          >
            {m}
          </button>
        ))}
        <span style={{ fontSize: 11.5, color: "var(--ink-3)", marginLeft: "auto" }}>
          network-executed · no server, no extension
        </span>
      </div>
      <iframe
        key={src}
        src={src}
        title={`Self-custody ${mode} · ${symbol}`}
        style={{
          width: "100%",
          height: 760,
          border: 0,
          display: "block",
        }}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  subtitle: string;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        padding: "10px 12px",
        background: "transparent",
        border: 0,
        borderBottom: active
          ? "2px solid var(--orange)"
          : "2px solid transparent",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: active ? 500 : 400,
          color: active ? "var(--ink)" : "var(--ink-2)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
          marginTop: 2,
        }}
      >
        {subtitle}
      </div>
    </button>
  );
}
