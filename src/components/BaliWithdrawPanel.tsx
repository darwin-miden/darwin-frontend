"use client";

/**
 * Direct canonical Bali outbound: burn Bali ETH faucet tokens from
 * the relay wallet and emit a B2AggNote toward a user-specified
 * Sepolia destination. The agglayer cert settles ~30-90 min later
 * and the user (or anyone) calls `claimAsset` via the
 * BaliClaimPanel above.
 *
 * Hidden behind a connected ETH wallet so we have a destination
 * default. The user can override the destination before submitting.
 *
 * The action itself is custodial — it signs from the relay wallet's
 * MidenFi key, so it can only run where that key lives. The panel
 * POSTs straight at the relay REST (`${RELAY_V2_URL}/v0/bridge-out`);
 * when the relay isn't reachable (typical Vercel deploy without a
 * backend) the panel surfaces a clean "feature unavailable" message
 * instead of breaking the rest of the page.
 *
 * True self-custody Miden→Sepolia withdraws (signing from a user's
 * own MidenFi wallet) would need the full B2AGG MASM dependency tree
 * to compile in-browser, which pins against consensus-changing
 * agglayer modules and is brittle — out of scope today.
 */

import { useAccount } from "wagmi";
import { useState } from "react";
import { RELAY_V2_URL } from "../lib/relayV2";

const MIDEN_EXPLORER_TX = "https://testnet.midenscan.com/tx/";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; txId: string }
  | { kind: "err"; msg: string };

export function BaliWithdrawPanel() {
  const { address, isConnected } = useAccount();
  const [dest, setDest] = useState<string>(address ?? "");
  const [amount, setAmount] = useState<string>("100");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Keep dest in sync with the connected wallet if the user hasn't
  // typed an explicit override.
  if (address && dest === "" && status.kind === "idle") {
    setDest(address);
  }

  const submit = async () => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) {
      setStatus({ kind: "err", msg: "destAddress must be a 20-byte hex" });
      return;
    }
    if (!/^\d+$/.test(amount) || amount === "0") {
      setStatus({ kind: "err", msg: "amount must be a positive integer" });
      return;
    }
    setStatus({ kind: "submitting" });
    try {
      const r = await fetch(`${RELAY_V2_URL}/v0/bridge-out`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destAddress: dest, amount }),
      });
      // 404 = relay is up but the bridge-out endpoint isn't deployed
      // (the worker can do the burn but the REST hasn't exposed it
      // yet). Show that as a feature flag rather than a generic err.
      if (r.status === 404) {
        setStatus({
          kind: "err",
          msg: `Relay at ${RELAY_V2_URL} does not expose /v0/bridge-out yet. Add it on the backend to enable the canonical Bali outbound from the UI.`,
        });
        return;
      }
      const j = (await r.json()) as { ok: boolean; txId?: string; error?: string };
      if (!j.ok || !j.txId) {
        setStatus({ kind: "err", msg: j.error ?? `relay HTTP ${r.status}` });
        return;
      }
      setStatus({ kind: "ok", txId: j.txId });
    } catch (e) {
      // Network error — relay unreachable (common on Vercel deploys
      // without a backend wired in via NEXT_PUBLIC_RELAY_V2_URL).
      setStatus({
        kind: "err",
        msg: `Cannot reach relay at ${RELAY_V2_URL} — set NEXT_PUBLIC_RELAY_V2_URL to a running darwin-relay v2 instance. (${e instanceof Error ? e.message : String(e)})`,
      });
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
        Bridge Bali ETH → Sepolia (direct outbound)
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Direct canonical Bali outbound — burns Bali ETH faucet tokens
        from the relay wallet and emits a B2AggNote toward a Sepolia
        destination. No basket position involved (use the
        RedeemPanel above for that). After ~30-90 min the agglayer
        cert settles and the BaliClaimPanel below this section will
        let you (or anyone) sign the L1 <code>claimAsset</code>.
      </p>

      <div
        style={{
          padding: "12px 14px",
          background: "var(--paper-2)",
          fontFamily: "var(--font-mono-stack)",
          fontSize: 13,
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          gap: 12,
          alignItems: "center",
        }}
      >
        <label>
          dest{" "}
          <input
            type="text"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="0x…"
            style={{
              width: 380,
              fontFamily: "inherit",
              padding: "4px 6px",
            }}
          />
        </label>

        <label style={{ justifySelf: "start" }}>
          amount (base units 8-dec){" "}
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min="1"
            step="1"
            style={{
              width: 140,
              fontFamily: "inherit",
              padding: "4px 6px",
              textAlign: "right",
            }}
          />
        </label>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={status.kind === "submitting"}
          style={{
            padding: "6px 14px",
            background: "var(--ink)",
            color: "var(--paper)",
            border: 0,
            cursor: status.kind === "submitting" ? "wait" : "pointer",
          }}
        >
          {status.kind === "submitting" ? "burning…" : "Burn + bridge out"}
        </button>
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
          ✓ B2AGG note submitted on Miden — tx{" "}
          <a
            href={MIDEN_EXPLORER_TX + status.txId}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--ink)" }}
          >
            <code>{status.txId.slice(0, 18)}…</code>
          </a>
          . The agglayer cert will settle in ~30-90 min; check the
          BaliClaimPanel for the L1 claim button when{" "}
          <code>ready_for_claim=true</code>.
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
