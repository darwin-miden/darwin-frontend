"use client";

/**
 * Testnet faucet panel.
 *
 * Flow per asset:
 *   1. POST /api/faucet/mint  — backend invokes miden-client CLI to mint
 *      a public P2ID note from the operator faucet to the user wallet.
 *      Server responds with { txId, noteId }. No wallet interaction.
 *   2. UI captures the noteId, surfaces a "Claim" button next to the
 *      asset row.
 *   3. Click Claim → wallet.requestConsume({faucetId, noteId, noteType,
 *      amount}) → ONE MidenFi popup, user confirms → asset lands in
 *      the wallet vault.
 *
 * IMPORTANT: we never call wallet.requestConsumableNotes() — that
 * triggers a "Request Consumable Notes" popup in MidenFi on every
 * invocation. A previous version of this panel polled it every 5s,
 * which flooded the user with permission popups. Since the server-
 * side mint hands us the exact noteId, we can consume it directly
 * without ever asking the wallet to enumerate.
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
  | { kind: "minted"; txId: string; noteId: string }
  | { kind: "claiming"; noteId: string }
  | { kind: "claimed"; noteId: string }
  | { kind: "err"; message: string };

export function FaucetPanel() {
  const wallet = useMidenFiWallet();
  const { connected, address } = wallet;
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

  async function drip(asset: AssetSpec) {
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
      if (!resp.ok || !data.noteId) {
        setStatus((s) => ({
          ...s,
          [asset.symbol]: { kind: "err", message: data.error ?? `HTTP ${resp.status}` },
        }));
        return;
      }
      setStatus((s) => ({
        ...s,
        [asset.symbol]: { kind: "minted", txId: data.txId, noteId: data.noteId },
      }));
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [asset.symbol]: { kind: "err", message: String((e as Error).message ?? e) },
      }));
    }
  }

  async function claim(asset: AssetSpec, noteId: string) {
    if (!wallet.requestConsume) {
      setStatus((s) => ({
        ...s,
        [asset.symbol]: { kind: "err", message: "wallet.requestConsume not available" },
      }));
      return;
    }
    setStatus((s) => ({ ...s, [asset.symbol]: { kind: "claiming", noteId } }));
    try {
      await wallet.requestConsume({
        faucetId: asset.faucetId,
        noteId,
        noteType: "public",
        amount: Number(asset.dripBase),
      });
      setStatus((s) => ({ ...s, [asset.symbol]: { kind: "claimed", noteId } }));
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
          const isMinted = s.kind === "minted" || s.kind === "claiming";
          const isClaimed = s.kind === "claimed";
          const isWorking = s.kind === "minting" || s.kind === "claiming";
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
                <div
                  style={{
                    color: "var(--ink-3)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono-stack)",
                  }}
                >
                  {a.decimals} dec
                </div>
              </div>

              <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                {s.kind === "idle" && <em>drip: {a.dripHuman} {a.symbol}</em>}
                {s.kind === "minting" && <em>minting on server…</em>}
                {s.kind === "minted" && (
                  <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
                    ✓ minted tx <code>{s.txId.slice(0, 14)}…</code> — click Claim
                    to consume into your wallet
                  </span>
                )}
                {s.kind === "claiming" && (
                  <em>waiting for MidenFi popup confirmation…</em>
                )}
                {s.kind === "claimed" && (
                  <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
                    ✓ claimed — {a.dripHuman} {a.symbol} now in your vault
                  </span>
                )}
                {s.kind === "err" && (
                  <span
                    style={{
                      color: "#a01a1a",
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: 11,
                    }}
                  >
                    ✗ {s.message.slice(0, 200)}
                  </span>
                )}
              </div>

              {isMinted ? (
                <button
                  onClick={() =>
                    claim(a, s.kind === "minted" ? s.noteId : (s as { noteId: string }).noteId)
                  }
                  disabled={isWorking}
                  style={{
                    padding: "8px 16px",
                    background: isWorking ? "var(--ink-3)" : "var(--orange)",
                    color: "var(--paper)",
                    border: 0,
                    cursor: isWorking ? "not-allowed" : "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.kind === "claiming" ? "claiming…" : `Claim ${a.symbol}`}
                </button>
              ) : (
                <button
                  onClick={() => drip(a)}
                  disabled={isWorking || isClaimed}
                  style={{
                    padding: "8px 16px",
                    background:
                      isWorking || isClaimed ? "var(--ink-3)" : "var(--ink)",
                    color: "var(--paper)",
                    border: 0,
                    cursor:
                      isWorking || isClaimed ? "not-allowed" : "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {isClaimed ? "done ✓" : isWorking ? "…" : `Drip ${a.symbol}`}
                </button>
              )}
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
        Drip = server-side mint (no wallet popup). Claim = single MidenFi
        confirmation popup that consumes the freshly-minted note into your
        wallet vault. Two clicks, two distinct flows.
      </p>
    </div>
  );
}
