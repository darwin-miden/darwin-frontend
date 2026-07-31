"use client";

/**
 * "Send to your Miden address" deposit method: shows the connected account's
 * Miden address so dUSDC can be sent to it directly (peer-to-peer on Miden),
 * with a copy button. No bridge, no EVM — just the receive address. Signer
 * agnostic (works under Para or native MidenFi): reads `signerAccountId` from
 * the unified `useMiden()`.
 */

import { CSSProperties, useEffect, useState } from "react";
import { useMiden } from "@miden-sdk/react";

import { EPOCH_USDC_SEPOLIA } from "../../lib/epoch";

export function ReceivePanel() {
  const { signerAccountId } = useMiden() as unknown as { signerAccountId: string | null };
  const [address, setAddress] = useState<string>(signerAccountId ?? "");
  const [copied, setCopied] = useState(false);

  // Prefer the shareable bech32 form (mtst1… on testnet); fall back to the raw
  // account id if the SDK doesn't expose the conversion.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!signerAccountId) return;
      try {
        const sdk = (await import("@miden-sdk/miden-sdk")) as unknown as {
          AccountId: { fromHex: (h: string) => { toBech32?: (n?: unknown) => string } };
          NetworkId?: { Testnet?: unknown; testnet?: unknown };
        };
        const id = sdk.AccountId.fromHex(signerAccountId);
        const net = sdk.NetworkId?.Testnet ?? sdk.NetworkId?.testnet;
        const bech = id.toBech32?.(net);
        if (!cancelled && bech && typeof bech === "string") setAddress(bech);
        else if (!cancelled) setAddress(signerAccountId);
      } catch {
        if (!cancelled) setAddress(signerAccountId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signerAccountId]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--ink)" }}>Send to your Miden address</h2>
      <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
        Send dUSDC directly to this Miden account. Only send dUSDC on Miden testnet — anything else will be lost.
      </p>

      <div style={sty.label}>Your Miden address</div>
      <div style={sty.addrBox}>
        <span style={sty.addrText}>{address || "…"}</span>
      </div>
      <button type="button" onClick={copy} disabled={!address} className="nav-cta" style={sty.copyBtn}>
        {copied ? "Copied ✓" : "Copy address"}
      </button>

      <p style={sty.hint}>
        Asset: <span style={{ fontFamily: "var(--font-mono-stack)" }}>dUSDC</span> ({EPOCH_USDC_SEPOLIA.midenDecimals} decimals) · network Miden testnet.
      </p>
    </div>
  );
}

const sty: Record<string, CSSProperties> = {
  label: {
    marginTop: 18,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--ink-3)",
  },
  addrBox: {
    marginTop: 8,
    borderRadius: 10,
    border: "1px solid var(--rule)",
    background: "var(--paper-2)",
    padding: "12px 14px",
    wordBreak: "break-all",
  },
  addrText: { fontFamily: "var(--font-mono-stack)", fontSize: 13, color: "var(--ink)", lineHeight: 1.5 },
  copyBtn: { width: "100%", textAlign: "center", marginTop: 12 },
  hint: { marginTop: 14, fontSize: 12, color: "var(--ink-3)" },
};
