"use client";

/**
 * Testnet faucet panel — POST to `/api/faucet/mint` for each asset; the
 * backend invokes the miden-client CLI to mint a small P2ID note from
 * the faucet operator account (which the server-side process owns)
 * to the connected wallet's address.
 *
 * Per-asset drip amounts are intentionally small — the on-chain
 * faucets ship with tight `max_supply` budgets for this testnet
 * generation (e.g. dWBTC max ≈ 0.01 base units total).
 */

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { useState } from "react";

interface AssetSpec {
  symbol: string;
  faucetId: string;
  decimals: number;
  dripBase: bigint;     // amount per request, in base units
  dripHuman: string;    // pre-formatted "X.Y" for the button label
}

const ASSETS: AssetSpec[] = [
  {
    symbol: "dETH",
    faucetId: "0xa095d9b3831e96206ff70c2218a6a9",
    decimals: 18,
    dripBase: 1_000_000n,
    dripHuman: "1e-12",
  },
  {
    symbol: "dWBTC",
    faucetId: "0x7a45cb24ada22120246bcf54196e12",
    decimals: 8,
    dripBase: 100_000n,
    dripHuman: "0.001",
  },
  {
    symbol: "dUSDT",
    faucetId: "0xd3789f451ddd4720602ba9eb1a268d",
    decimals: 6,
    dripBase: 100_000_000n,
    dripHuman: "100",
  },
  {
    symbol: "dDAI",
    faucetId: "0xb526deb0408a29207e4f27ed57bf1a",
    decimals: 18,
    dripBase: 1_000_000n,
    dripHuman: "1e-12",
  },
];

type Status =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "ok"; txId: string; noteId: string }
  | { kind: "err"; message: string };

export function FaucetPanel() {
  const { connected, address } = useMidenFiWallet();
  const [status, setStatus] = useState<Record<string, Status>>({});

  if (!connected || !address) {
    return (
      <div
        style={{
          padding: "1.2rem 1.4rem",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
          maxWidth: 720,
        }}
      >
        <strong>Connect a Miden wallet</strong>
        <p style={{ color: "var(--ink-2)", fontSize: 14, marginTop: 8, marginBottom: 0 }}>
          Click <em>Connect Miden</em> in the top nav (MidenFi extension, Para,
          or Turnkey).
        </p>
      </div>
    );
  }

  async function mint(asset: AssetSpec) {
    setStatus((s) => ({ ...s, [asset.symbol]: { kind: "minting" } }));
    try {
      const resp = await fetch("/api/faucet/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: address,
          faucetId: asset.faucetId,
          amount: asset.dripBase.toString(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setStatus((s) => ({
          ...s,
          [asset.symbol]: { kind: "err", message: data.error ?? `HTTP ${resp.status}` },
        }));
        return;
      }
      setStatus((s) => ({
        ...s,
        [asset.symbol]: { kind: "ok", txId: data.txId, noteId: data.noteId },
      }));
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [asset.symbol]: { kind: "err", message: String((e as Error).message ?? e) },
      }));
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          color: "var(--ink-3)",
          marginBottom: 16,
        }}
      >
        target: {address.slice(0, 16)}…{address.slice(-6)}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {ASSETS.map((a) => {
          const s = status[a.symbol] ?? { kind: "idle" };
          return (
            <div
              key={a.symbol}
              style={{
                padding: "14px 16px",
                background: "var(--paper-2)",
                borderLeft: "3px solid var(--rule)",
                display: "grid",
                gridTemplateColumns: "80px 1fr auto",
                gap: 16,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.symbol}</div>
                <div style={{ color: "var(--ink-3)", fontSize: 11, fontFamily: "var(--font-mono-stack)" }}>
                  {a.decimals} dec
                </div>
              </div>

              <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                {s.kind === "idle" && <em>drip: {a.dripHuman} {a.symbol}</em>}
                {s.kind === "minting" && <em>minting…</em>}
                {s.kind === "ok" && (
                  <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
                    ✓ tx <code>{s.txId.slice(0, 14)}…</code> · note{" "}
                    <code>{s.noteId.slice(0, 14)}…</code>
                  </span>
                )}
                {s.kind === "err" && (
                  <span style={{ color: "#a01a1a", fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
                    ✗ {s.message.slice(0, 200)}
                  </span>
                )}
              </div>

              <button
                onClick={() => mint(a)}
                disabled={s.kind === "minting" || s.kind === "ok"}
                style={{
                  padding: "8px 16px",
                  background: s.kind === "ok" ? "var(--ink-3)" : "var(--ink)",
                  color: "var(--paper)",
                  border: 0,
                  cursor: s.kind === "minting" || s.kind === "ok" ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                {s.kind === "ok" ? "minted ✓" : s.kind === "minting" ? "…" : `Drip ${a.symbol}`}
              </button>
            </div>
          );
        })}
      </div>

      <p
        style={{
          marginTop: 20,
          fontSize: 11,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
          lineHeight: 1.6,
        }}
      >
        Notes are emitted public P2ID and indexed against your wallet address.
        Your MidenFi extension consumes them on the next sync — give it ~10–30s.
      </p>
    </div>
  );
}
