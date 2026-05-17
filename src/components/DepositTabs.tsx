"use client";

/**
 * Tabbed deposit interface: ETH (via the relay) on the left,
 * Miden-native (browser-proving via the Miden Web SDK) on the right.
 *
 * Both paths land in the same v2 controller on Miden — the ETH path
 * via the relay's bridged stable, the Miden path via a direct
 * P2ID note carrying one of the basket constituents.
 */

import dynamic from "next/dynamic";
import { useState } from "react";

import { DepositPanel } from "./DepositPanel";
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

type Tab = "eth" | "miden";

export function DepositTabs({ basket }: { basket: BasketDef }) {
  const [tab, setTab] = useState<Tab>("eth");

  // Resolve the underlying basket manifest so MidenDepositPanel can
  // see the constituent list (faucet aliases).
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
          active={tab === "eth"}
          onClick={() => setTab("eth")}
          label="Ethereum (Sepolia)"
          subtitle="USDC → wDCC via the relay"
        />
        <TabButton
          active={tab === "miden"}
          onClick={() => setTab("miden")}
          label="Miden native"
          subtitle="P2ID note, browser-proven"
        />
      </div>

      {tab === "eth" ? (
        <DepositPanel basket={basket} />
      ) : (
        <MidenDepositPanel basket={manifest} />
      )}
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
