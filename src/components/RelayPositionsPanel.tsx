"use client";

/**
 * Portfolio panel for relay-held basket positions.
 *
 * Reads GET /v0/positions/:user_evm_addr from darwin-relay v2 and lets
 * the user fire a /v0/redeem against a held basket. These positions are
 * the natural counterpart to the 1Click deposit path: when an ETH user
 * deposits through the relay, the relay holds the basket-token position
 * on Miden for them and reports it here keyed by their EVM address.
 *
 * Miden self-custody positions show up in MidenPortfolioSection — this
 * panel is strictly about positions the relay holds on the user's behalf.
 */

import { useAccount } from "wagmi";
import { useEffect, useState } from "react";

import {
  getPositions,
  RELAY_V2_URL,
  redeem,
  type RelayPosition,
} from "../lib/relayV2";

interface RowState {
  redeeming: boolean;
  error: string | null;
  redeemed: { id: string; amount: string } | null;
  partialInput: string;
}

export function RelayPositionsPanel() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<RelayPosition[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  async function refresh() {
    if (!address) return;
    try {
      const ps = await getPositions(address);
      setPositions(ps);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!isConnected || !address) {
      setPositions(null);
      return;
    }
    void refresh();
    const t = setInterval(refresh, 8_000);
    return () => clearInterval(t);
  }, [address, isConnected]);

  async function handleRedeem(p: RelayPosition, amount: string) {
    setRowState((s) => ({
      ...s,
      [p.basket_symbol]: {
        redeeming: true,
        error: null,
        redeemed: null,
        partialInput: amount,
      },
    }));
    try {
      const r = await redeem({
        user_evm_addr: p.user_evm_addr,
        basket_symbol: p.basket_symbol,
        basket_amount: amount,
      });
      setRowState((s) => ({
        ...s,
        [p.basket_symbol]: {
          redeeming: false,
          error: null,
          redeemed: { id: r.redemption_id, amount: r.basket_amount },
          partialInput: "",
        },
      }));
      void refresh();
    } catch (e) {
      setRowState((s) => ({
        ...s,
        [p.basket_symbol]: {
          redeeming: false,
          error: e instanceof Error ? e.message : String(e),
          redeemed: null,
          partialInput: amount,
        },
      }));
    }
  }

  if (!isConnected) return null;

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
        Relay-held positions
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Basket-token positions darwin-relay holds for your EVM address on
        Miden. Deposits coming in through the 1Click rail land here.
        Redeeming debits the relay’s position and (on the next worker
        cycle) ships the underlying back to your wallet via the outbound
        1Click leg.{" "}
        <code style={{ fontSize: 11, color: "var(--ink-3)" }}>
          source: {RELAY_V2_URL}/v0/positions
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

      {positions !== null && positions.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          No relay-held positions yet. Use the 1Click deposit on a basket
          page to open one.
        </p>
      )}

      {positions && positions.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
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
              <th style={{ textAlign: "left", padding: "10px 12px" }}>Basket</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>Held by relay (wei)</th>
              <th style={{ textAlign: "left", padding: "10px 12px" }}>Redeem</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const rs = rowState[p.basket_symbol] ?? {
                redeeming: false,
                error: null,
                redeemed: null,
                partialInput: "",
              };
              return (
                <tr
                  key={p.basket_symbol}
                  style={{ borderBottom: "1px solid var(--rule-2)" }}
                >
                  <td style={{ padding: "14px 12px", fontWeight: 500 }}>
                    {p.basket_symbol}
                  </td>
                  <td
                    style={{
                      padding: "14px 12px",
                      textAlign: "right",
                      fontFamily: "var(--font-mono-stack)",
                    }}
                  >
                    {p.basket_amount}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="number"
                        placeholder="amount"
                        value={rs.partialInput}
                        onChange={(e) =>
                          setRowState((s) => ({
                            ...s,
                            [p.basket_symbol]: { ...rs, partialInput: e.target.value },
                          }))
                        }
                        disabled={rs.redeeming}
                        style={{
                          width: 130,
                          padding: "6px 8px",
                          fontFamily: "var(--font-mono-stack)",
                          fontSize: 12,
                          border: "1px solid var(--rule)",
                        }}
                      />
                      <button
                        onClick={() =>
                          handleRedeem(p, rs.partialInput || p.basket_amount)
                        }
                        disabled={rs.redeeming}
                        style={{
                          padding: "6px 12px",
                          background: rs.redeeming ? "var(--ink-3)" : "var(--ink)",
                          color: "var(--paper)",
                          border: 0,
                          fontSize: 12,
                          cursor: rs.redeeming ? "not-allowed" : "pointer",
                        }}
                      >
                        {rs.redeeming ? "…" : "Redeem"}
                      </button>
                      <button
                        onClick={() => handleRedeem(p, p.basket_amount)}
                        disabled={rs.redeeming}
                        style={{
                          padding: "6px 10px",
                          background: "var(--paper-2)",
                          color: "var(--ink)",
                          border: "1px solid var(--rule)",
                          fontSize: 11,
                          cursor: rs.redeeming ? "not-allowed" : "pointer",
                        }}
                        title="Redeem the full position"
                      >
                        max
                      </button>
                    </div>
                    {rs.redeemed && (
                      <p style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 4 }}>
                        redeemed {rs.redeemed.amount} ·{" "}
                        <code>{rs.redeemed.id.slice(0, 12)}…</code>
                      </p>
                    )}
                    {rs.error && (
                      <p style={{ fontSize: 11, color: "#a01a1a", marginTop: 4 }}>
                        {rs.error}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
