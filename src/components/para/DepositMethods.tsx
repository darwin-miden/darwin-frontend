"use client";

/**
 * Deposit method chooser (Polymarket-style): the Deposit modal opens on a list
 * of ways to add funds, then drills into the selected one with a back link.
 *   - "bridge"  → ParaFundingPanel (bridge Sepolia USDC from MetaMask/Rabby via
 *                 Epoch; also hosts Withdraw once the account holds dUSDC)
 *   - "receive" → ReceivePanel (show the Miden address, send dUSDC to it directly)
 *   - "card"    → disabled, not available yet
 * Signer-agnostic — the sub-panels read the unified useMiden(), so this works
 * under Para or native MidenFi alike. Inline styles + app CSS vars (no Tailwind).
 */

import { CSSProperties, useState } from "react";

import { ParaFundingPanel } from "./ParaFundingPanel";
import { ReceivePanel } from "./ReceivePanel";

type Method = "bridge" | "receive" | "card";

const METHODS: Array<{ id: Method; title: string; desc: string; soon?: boolean }> = [
  {
    id: "bridge",
    title: "Bridge from Ethereum",
    desc: "Move Sepolia USDC from your MetaMask or Rabby into your Miden account.",
  },
  {
    id: "receive",
    title: "Send to your Miden address",
    desc: "Already hold dUSDC on Miden? Send it straight to your account address.",
  },
  {
    id: "card",
    title: "Buy with your card",
    desc: "Fund your account with a debit or credit card.",
    soon: true,
  },
];

export function DepositMethods() {
  const [sel, setSel] = useState<Method | null>(null);

  if (sel === "bridge" || sel === "receive") {
    return (
      <div>
        <button type="button" onClick={() => setSel(null)} style={sty.back}>
          ← All deposit methods
        </button>
        {sel === "bridge" ? <ParaFundingPanel /> : <ReceivePanel />}
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--ink)" }}>Deposit</h2>
      <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
        Choose how to add funds to your Miden account.
      </p>

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={m.soon}
            aria-disabled={m.soon}
            onClick={() => !m.soon && setSel(m.id)}
            style={{ ...sty.card, ...(m.soon ? sty.cardDisabled : null) }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontWeight: 600, color: m.soon ? "var(--ink-3)" : "var(--ink)" }}>{m.title}</span>
              {m.soon ? <span style={sty.soonBadge}>Soon</span> : <span style={sty.chevron}>→</span>}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--ink-3)" }}>{m.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

const sty: Record<string, CSSProperties> = {
  back: {
    background: "none",
    border: "none",
    padding: 0,
    marginBottom: 12,
    fontSize: 13,
    color: "var(--ink-3)",
    cursor: "pointer",
  },
  card: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "var(--paper-2)",
    border: "1px solid var(--rule)",
    borderRadius: 12,
    padding: "14px 16px",
    cursor: "pointer",
    color: "var(--ink)",
  },
  cardDisabled: { cursor: "not-allowed", opacity: 0.55, background: "transparent" },
  chevron: { color: "var(--ink-3)", fontSize: 15 },
  soonBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--ink-3)",
    border: "1px solid var(--rule)",
    borderRadius: 999,
    padding: "2px 8px",
  },
};
