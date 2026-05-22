"use client";

/**
 * Two deposit paths, converging on the same private basket position
 * on Miden:
 *
 *   1. **ETH user** -> NEAR Intents 1Click bridge (Sepolia ETH ->
 *      Miden P2ID note) -> a custodial relay wallet on Miden submits
 *      the atomic_deposit_note to the controller on the user's behalf.
 *      This is the grant proposal's "ETH user via Near Intent + relay
 *      wallet" path; we use Brian Seong's mock 1Click bridge as the
 *      NEAR-Intent-shaped front-end.
 *
 *   2. **Miden-native user** -> direct atomic_deposit_note via the
 *      Miden Web SDK in this tab. No bridge, no relay -- the user's
 *      own Miden wallet sends straight to the controller.
 *
 * The earlier Sepolia ESCROW + wDCC ERC20 path (darwin-relay v1) is
 * deprecated. It was a workaround built during M2 when NEAR Intent
 * didn't support Miden. With Brian's mock now live, the proposal's
 * native architecture is reachable, and we no longer need a Sepolia-
 * side wrapped basket token.
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

const OneClickDepositPanel = dynamic(
  () => import("./OneClickDepositPanel").then((m) => m.OneClickDepositPanel),
  { ssr: false },
);

type Tab = "oneclick" | "miden";

export function DepositTabs({ basket }: { basket: BasketDef }) {
  // ETH user path is the default — most casual visitors have an ETH wallet
  // and no Miden wallet, so 1Click is the entry point.
  const [tab, setTab] = useState<Tab>("oneclick");
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
          active={tab === "oneclick"}
          onClick={() => setTab("oneclick")}
          label="ETH wallet"
          subtitle="Sepolia → Miden via NEAR Intents 1Click"
        />
        <TabButton
          active={tab === "miden"}
          onClick={() => setTab("miden")}
          label="Miden wallet"
          subtitle="Atomic deposit note, browser-proven"
        />
      </div>

      {tab === "oneclick" && <OneClickDepositPanel basket={basket} />}
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
