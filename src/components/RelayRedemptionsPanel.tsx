"use client";

/**
 * Portfolio panel for relay-driven redemption lifecycle.
 *
 * Shows the four tx hashes the v2 worker writes as a redemption walks
 * through its on-chain stages:
 *
 *   miden_redeem_tx     — atomic_redeem_note submission (burn-leg)
 *   miden_bridge_out_tx — bridge_out_v1 P2ID note (outbound to 1Click)
 *   sepolia_release_tx  — 1Click solver's Sepolia release tx
 *
 * Each hash links to the relevant explorer (Miden testnet or Sepolia).
 */

import { useAccount } from "wagmi";
import { useEffect, useState } from "react";

import { listRedemptionsForUser, RELAY_V2_URL, type RelayRedemption } from "../lib/relayV2";

const MIDEN_EXPLORER_TX = "https://testnet.midenscan.com/tx/";
const SEPOLIA_EXPLORER_TX = "https://sepolia.etherscan.io/tx/";

export function RelayRedemptionsPanel() {
  const { address, isConnected } = useAccount();
  const [rows, setRows] = useState<RelayRedemption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConnected || !address) {
      setRows(null);
      return;
    }
    let cancel = false;
    async function refresh() {
      try {
        const xs = await listRedemptionsForUser(address!);
        if (!cancel) {
          setRows(xs);
          setLoadError(null);
        }
      } catch (e) {
        if (!cancel) setLoadError(e instanceof Error ? e.message : String(e));
      }
    }
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, [address, isConnected]);

  if (!isConnected) return null;
  if (rows !== null && rows.length === 0) return null;

  return (
    <section style={{ marginTop: 48 }}>
      <h2
        style={{
          fontSize: 14,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          borderBottom: "1px solid var(--ink)",
          paddingBottom: 8,
          marginBottom: 14,
        }}
      >
        Redemption lifecycle
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Each row is a redemption you initiated from the panel above, with the
        on-chain tx hashes the relay worker writes as it walks the burn-leg
        through to Sepolia release.{" "}
        <code style={{ fontSize: 11, color: "var(--ink-3)" }}>
          source: {RELAY_V2_URL}/v0/redemptions
        </code>
      </p>

      {loadError && (
        <pre
          style={{
            padding: 10,
            background: "#fff0f0",
            color: "#a01a1a",
            fontSize: 11,
          }}
        >
          relay-v2: {loadError}
        </pre>
      )}

      {rows && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--rule)",
                color: "var(--ink-3)",
                fontSize: 11,
                fontFamily: "var(--font-mono-stack)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              <th style={{ textAlign: "left", padding: "10px 8px" }}>Basket</th>
              <th style={{ textAlign: "right", padding: "10px 8px" }}>Amount</th>
              <th style={{ textAlign: "left", padding: "10px 8px" }}>Stage</th>
              <th style={{ textAlign: "left", padding: "10px 8px" }}>Miden burn</th>
              <th style={{ textAlign: "left", padding: "10px 8px" }}>Bridge-out</th>
              <th style={{ textAlign: "left", padding: "10px 8px" }}>Sepolia release</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.redemption_id} style={{ borderBottom: "1px solid var(--rule-2)" }}>
                <td style={{ padding: "12px 8px", fontWeight: 500 }}>{r.basket_symbol}</td>
                <td
                  style={{
                    padding: "12px 8px",
                    textAlign: "right",
                    fontFamily: "var(--font-mono-stack)",
                  }}
                >
                  {r.basket_amount}
                </td>
                <td style={{ padding: "12px 8px" }}>
                  <StageBadge stage={r.stage} hasError={!!r.error} />
                </td>
                <Hash cell="miden" tx={r.miden_redeem_tx} />
                <Hash cell="miden" tx={r.miden_bridge_out_tx} />
                <Hash cell="sepolia" tx={r.sepolia_release_tx} />
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows && rows.some((r) => r.error) && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, color: "#a01a1a", cursor: "pointer" }}>
            Errors (click to expand)
          </summary>
          <ul style={{ fontSize: 11, color: "#a01a1a", marginTop: 6 }}>
            {rows
              .filter((r) => r.error)
              .map((r) => (
                <li key={r.redemption_id}>
                  <code>{r.redemption_id.slice(0, 12)}…</code> — {r.error}
                </li>
              ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function StageBadge({ stage, hasError }: { stage: string; hasError: boolean }) {
  const color = hasError
    ? "#a01a1a"
    : stage === "FULLY_SETTLED"
      ? "var(--ink)"
      : "var(--ink-2)";
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono-stack)",
        color,
      }}
    >
      {stage}
    </span>
  );
}

function Hash({ cell, tx }: { cell: "miden" | "sepolia"; tx: string | null }) {
  if (!tx) {
    return <td style={{ padding: "12px 8px", color: "var(--ink-3)", fontSize: 11 }}>—</td>;
  }
  const url = cell === "miden" ? `${MIDEN_EXPLORER_TX}${tx}` : `${SEPOLIA_EXPLORER_TX}${tx}`;
  return (
    <td style={{ padding: "12px 8px", fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
      <a href={url} target="_blank" rel="noreferrer" style={{ borderBottom: "1px dotted var(--rule)" }}>
        {tx.slice(0, 10)}…
      </a>
    </td>
  );
}
