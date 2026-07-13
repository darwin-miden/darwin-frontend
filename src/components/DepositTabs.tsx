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
import { BASKET_TOKEN_FAUCETS } from "../lib/midenConstants";

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

const MidenBareContextProvider = dynamic(
  () =>
    import("./MidenBareContextProvider").then(
      (m) => m.MidenBareContextProvider,
    ),
  { ssr: false },
);
const TrustlessDepositPanel = dynamic(
  () =>
    import("./TrustlessDepositPanel").then((m) => m.TrustlessDepositPanel),
  { ssr: false },
);
const TrustlessRedeemPanel = dynamic(
  () => import("./TrustlessRedeemPanel").then((m) => m.TrustlessRedeemPanel),
  { ssr: false },
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
 * The self-custody flow mounts NATIVELY in the tab. The trustless
 * panels need the bare Miden provider (internal WASM keystore — the
 * MidenFi signer wrapper rejects derived keys), so the pane nests a
 * MidenBareContextProvider inside the app-level provider tree: React
 * context shadowing gives this subtree its own Miden client while the
 * wagmi/MetaMask connection from the top nav carries over untouched.
 * Only one tab's panel is mounted at a time, so the two Miden clients
 * never prove concurrently.
 */
function SelfCustodyPane({ symbol }: { symbol: string }) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const faucet = BASKET_TOKEN_FAUCETS[symbol as BasketSymbol];
  const basket = faucet
    ? { symbol: faucet.symbol, faucetHex: faucet.id }
    : undefined;
  return (
    <div
      style={{
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
        padding: "12px 16px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "baseline",
          marginBottom: 10,
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
      <MidenBareContextProvider>
        {mode === "deposit" ? (
          <TrustlessDepositPanel basket={basket} compact network />
        ) : (
          <TrustlessRedeemPanel basket={basket} network />
        )}
      </MidenBareContextProvider>
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
