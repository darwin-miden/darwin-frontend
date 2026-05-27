"use client";

/**
 * Trigger a basket redemption from the UI.
 *
 * POSTs to relay v2 `/v0/redeem` with `(user_evm_addr, basket_symbol,
 * basket_amount)`. The relay worker then walks the redemption
 * through its stages:
 *
 *   SETTLED → BURN_QUEUED → BURN_SUBMITTED → BURN_CONFIRMED →
 *   BRIDGE_OUT_QUEUED → BRIDGE_OUT_SUBMITTED → SEPOLIA_RELEASE_*
 *
 * The visible lifecycle (tx hashes per stage) is rendered by the
 * existing RelayRedemptionsPanel below this one — this panel just
 * creates new redemptions; it doesn't duplicate the history table.
 *
 * Hidden unless an ETH wallet is connected — redemptions are keyed
 * by user EVM addr in the relay's sqlite.
 */

import { useAccount } from "wagmi";
import { useState } from "react";

import { redeem, type RelayRedeemResponse } from "../lib/relayV2";
import { BASKETS, type BasketSymbol } from "../lib/baskets";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; res: RelayRedeemResponse }
  | { kind: "err"; msg: string };

export function RedeemPanel() {
  const { address, isConnected } = useAccount();
  const [symbol, setSymbol] = useState<BasketSymbol>("DCC");
  const [amount, setAmount] = useState("1");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const submit = async () => {
    if (!address) return;
    setStatus({ kind: "submitting" });
    try {
      // basket_amount is a string in 8-decimal base units. The user
      // types a human-friendly figure ("1" = one basket token), we
      // pad with 1e8. Anything fractional in the input is rounded
      // down to keep the math felt-clean (integers all the way down).
      const baseUnits = BigInt(Math.floor(parseFloat(amount) * 1e8)).toString();
      const res = await redeem({
        user_evm_addr: address.toLowerCase(),
        basket_symbol: symbol,
        basket_amount: baseUnits,
      });
      setStatus({ kind: "ok", res });
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    }
  };

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
        Redeem basket position
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Burn basket tokens held on your behalf by the relay
        (keyed by <code>{address}</code>) and release the pro-rata
        constituent value back to Sepolia. The relay worker emits the
        atomic_redeem_note on Miden, then the outbound leg via the
        Bali bridge. The lifecycle table below this panel tracks the
        three resulting tx hashes per redemption.
      </p>

      <div
        style={{
          padding: "12px 14px",
          background: "var(--paper-2)",
          fontFamily: "var(--font-mono-stack)",
          fontSize: 13,
          display: "grid",
          gridTemplateColumns: "auto auto auto 1fr",
          gap: 12,
          alignItems: "center",
        }}
      >
        <label>
          basket{" "}
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value as BasketSymbol)}
            style={{ fontFamily: "inherit", padding: "4px 6px" }}
          >
            {BASKETS.map((b) => (
              <option key={b.symbol} value={b.symbol}>
                {b.symbol}
              </option>
            ))}
          </select>
        </label>

        <label>
          amount{" "}
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            step="0.01"
            min="0"
            style={{
              width: 120,
              fontFamily: "inherit",
              padding: "4px 6px",
              textAlign: "right",
            }}
          />
        </label>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={status.kind === "submitting" || !parseFloat(amount)}
          style={{
            padding: "6px 14px",
            background: "var(--ink)",
            color: "var(--paper)",
            border: 0,
            cursor: status.kind === "submitting" ? "wait" : "pointer",
          }}
        >
          {status.kind === "submitting" ? "submitting…" : "Redeem"}
        </button>

        <div style={{ textAlign: "right", color: "var(--ink-3)", fontSize: 11 }}>
          atomic_redeem_note → bridge_out → claimAsset
        </div>
      </div>

      {status.kind === "ok" && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: "var(--paper-2)",
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            borderLeft: "3px solid #1d7a3a",
          }}
        >
          <div>✓ redemption submitted</div>
          <div style={{ marginTop: 4, color: "var(--ink-2)" }}>
            id <code>{status.res.redemption_id}</code> · basket{" "}
            <code>{status.res.basket_symbol}</code> · amount{" "}
            <code>{status.res.basket_amount}</code> · stage{" "}
            <code>{status.res.stage}</code>
          </div>
        </div>
      )}

      {status.kind === "err" && (
        <pre
          style={{
            marginTop: 10,
            padding: 8,
            background: "#fff0f0",
            fontSize: 11,
            color: "#a01a1a",
            fontFamily: "var(--font-mono-stack)",
          }}
        >
          {status.msg}
        </pre>
      )}
    </section>
  );
}
