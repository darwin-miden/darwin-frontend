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
 * The self-custody rail runs on its own route rather than inline: the
 * trustless panel needs the bare Miden provider (internal keystore, no
 * MidenFi signer wrapper) and exclusive WASM-client access — mounting
 * it next to MidenDepositPanel would re-create the RefCell contention
 * the /trustless route exists to avoid. The tab sells the rail and
 * hands off with the basket preselected.
 */
function SelfCustodyPane({ symbol }: { symbol: string }) {
  return (
    <div
      style={{
        padding: "1.2rem 1.4rem",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
      }}
    >
      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6, marginBottom: 6 }}>
        Deposit into <strong>{symbol}</strong> without trusting any Darwin
        server: your browser derives a Miden key from one MetaMask
        signature, bridges Sepolia USDC via Epoch, then emits a deposit
        note that <strong>the Miden network itself executes</strong>
        against the controller — vault and position, proofs included.
      </p>
      <ul style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.7, margin: "0 0 14px 18px", padding: 0 }}>
        <li>One signature — same wallet on any device, nothing to back up</li>
        <li>No browser extension, no Darwin backend in the loop</li>
        <li>Redeem back to Sepolia USDC the same way, anytime</li>
      </ul>
      <a
        href={`/trustless?basket=${encodeURIComponent(symbol)}`}
        className="nav-cta"
        style={{ display: "inline-block", textDecoration: "none" }}
      >
        Open self-custody deposit →
      </a>
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
