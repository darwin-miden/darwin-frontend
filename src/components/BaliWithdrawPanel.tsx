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
  | { kind: "pending"; requestId: string }
  | { kind: "ok"; txId: string }
  | { kind: "err"; msg: string };

interface BridgeOutStatus {
  request_id: string;
  status: "pending" | "submitted" | "failed";
  txId: string | null;
  ok: boolean;
  error: string | null;
}

// Poll the GET endpoint every 2s until the worker either submits the
// burn (status="submitted" + txId set) or fails it. Bounded at 60s so
// the UI doesn't spin forever if the worker is wedged.
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 60_000;

async function pollUntilResolved(requestId: string): Promise<BridgeOutStatus> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (Date.now() > deadline) {
      throw new Error(
        `timeout after ${POLL_TIMEOUT_MS / 1000}s — check the relay worker logs for request ${requestId}`,
      );
    }
    const r = await fetch(`${RELAY_V2_URL}/v0/bridge-out/${requestId}`);
    if (!r.ok) continue; // transient network/worker hiccup, retry
    const j = (await r.json()) as BridgeOutStatus;
    if (j.status === "submitted" || j.status === "failed") return j;
    // Otherwise still "pending" — keep polling.
  }
}

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
    let requestId: string;
    try {
      const r = await fetch(`${RELAY_V2_URL}/v0/bridge-out`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ destAddress: dest, amount }),
      });
      if (r.status === 404) {
        setStatus({
          kind: "err",
          msg: `Relay at ${RELAY_V2_URL} does not expose /v0/bridge-out yet. Upgrade the backend to enable the canonical Bali outbound from the UI.`,
        });
        return;
      }
      const j = (await r.json()) as { request_id?: string; error?: string };
      if (!r.ok || !j.request_id) {
        setStatus({ kind: "err", msg: j.error ?? `relay HTTP ${r.status}` });
        return;
      }
      requestId = j.request_id;
      setStatus({ kind: "pending", requestId });
    } catch (e) {
      setStatus({
        kind: "err",
        msg: `Cannot reach relay at ${RELAY_V2_URL} — set NEXT_PUBLIC_RELAY_V2_URL to a running darwin-relay v2 instance. (${e instanceof Error ? e.message : String(e)})`,
      });
      return;
    }

    // Hand off to the worker via the polling loop. The REST POST has
    // already persisted the row; even if the user closes the tab now
    // the worker will still drain it.
    try {
      const final = await pollUntilResolved(requestId);
      if (final.status === "submitted" && final.txId) {
        setStatus({ kind: "ok", txId: final.txId });
      } else {
        setStatus({
          kind: "err",
          msg: final.error ?? `bridge-out ${final.status}`,
        });
      }
    } catch (e) {
      setStatus({
        kind: "err",
        msg: e instanceof Error ? e.message : String(e),
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
          disabled={status.kind === "submitting" || status.kind === "pending"}
          style={{
            padding: "6px 14px",
            background: "var(--ink)",
            color: "var(--paper)",
            border: 0,
            cursor:
              status.kind === "submitting" || status.kind === "pending"
                ? "wait"
                : "pointer",
          }}
        >
          {status.kind === "submitting"
            ? "submitting…"
            : status.kind === "pending"
              ? "burning…"
              : "Burn + bridge out"}
        </button>
      </div>

      {status.kind === "pending" && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: "var(--paper-2)",
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            borderLeft: "3px solid var(--ink-3)",
            color: "var(--ink-2)",
          }}
        >
          Request <code>{status.requestId}</code> enqueued — waiting for the
          relay worker to emit the B2AGG note. This usually takes ~2-5s.
        </div>
      )}

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
