"use client";

/**
 * Two deposit paths, converging on the same private basket position
 * on Miden:
 *
 *   1. **ETH user** -> Epoch protocol's hosted intent bridge (Sepolia
 *      USDC -> Miden P2ID note). The custodial relay wallet on Miden
 *      receives the bridged dUSDC and submits the atomic_deposit_note
 *      to the controller on the user's behalf. No local bridge mock,
 *      no laptop dependency — Epoch hosts the allocator + solver.
 *
 *   2. **Miden-native user** -> direct atomic_deposit_note via the
 *      Miden Web SDK in this tab. No bridge, no relay -- the user's
 *      own Miden wallet sends straight to the controller.
 *
 * The earlier 1Click-mock + Sepolia ESCROW + wDCC ERC20 paths are
 * retired (commit history has them if a rollback is ever needed).
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

const EpochDepositPanel = dynamic(
  () => import("./EpochDepositPanel").then((m) => m.EpochDepositPanel),
  { ssr: false },
);

type Tab = "epoch" | "miden";

export function DepositTabs({ basket }: { basket: BasketDef }) {
  const [tab, setTab] = useState<Tab>("epoch");
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
          active={tab === "epoch"}
          onClick={() => setTab("epoch")}
          label="ETH wallet"
          subtitle="Sepolia USDC → Miden via Epoch"
        />
        <TabButton
          active={tab === "miden"}
          onClick={() => setTab("miden")}
          label="Miden wallet"
          subtitle="Atomic deposit note, browser-proven"
        />
      </div>

      {tab === "epoch" && <EpochDepositPanel basket={basket} />}
      {tab === "miden" && <MidenDepositPanel basket={manifest} />}
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
