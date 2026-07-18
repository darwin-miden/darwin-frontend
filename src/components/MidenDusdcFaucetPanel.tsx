"use client";

/**
 * Miden dUSDC faucet — same clean interface as the Sepolia panel (balance + one
 * button), but dUSDC comes from the PERMISSIONLESS on-chain dispenser: the
 * button emits a drip request from the user's own MidenFi wallet, waits for the
 * network to pay out a private note, imports it into MidenFi and consumes it.
 *
 * The balance + claim both go through the MidenFi adapter (requestAssets /
 * importPrivateNote / requestConsume), NOT the frontend web client: the wallet
 * is a private account, so only MidenFi can read its assets or prove-consume its
 * private notes. The web client's useAccount can't (it has no account header for
 * a private id — "No account header record found" — and every balance read 0).
 */
import { useCallback, useEffect, useState } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";

import { EPOCH_DUSDC_FAUCET_ID } from "../lib/midenConstants";

export function MidenDusdcFaucetPanel() {
  const wallet = useMidenFiWallet();
  const { connected, address } = wallet;
  const [balance, setBalance] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Read the balance straight from MidenFi (works for a private account; the
  // web client can't). Match the dUSDC faucet id whether MidenFi returns it as
  // hex or bech32 by canonicalising both sides through AccountId.
  const refreshBalance = useCallback(async () => {
    if (!wallet.requestAssets) return;
    try {
      const assets = await wallet.requestAssets();
      const { AccountId } = await import("@miden-sdk/miden-sdk");
      const canon = (s: string) => {
        if (/^0x[0-9a-fA-F]+$/.test(s)) return s.toLowerCase();
        try {
          return AccountId.fromBech32(s).toString().toLowerCase();
        } catch {
          return s.toLowerCase();
        }
      };
      const want = canon(EPOCH_DUSDC_FAUCET_ID);
      const hit = assets.find((a) => canon(a.faucetId) === want);
      setBalance(hit ? BigInt(hit.amount) : 0n);
    } catch {
      /* leave the last known balance in place */
    }
  }, [wallet]);

  useEffect(() => {
    if (connected) void refreshBalance();
  }, [connected, refreshBalance]);

  const human = (Number(balance) / 1e6).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });

  const getDusdc = useCallback(async () => {
    if (!address || busy) return;
    setBusy(true);
    setErr(null);
    setStage("Building request…");
    try {
      // MidenFi hands us an Address bech32 (account id + interface suffix, with
      // a `_`) — not a bare AccountId. Extract the account id the dispenser pays
      // out to; send its canonical string to the builder.
      const { AccountId, Address } = await import("@miden-sdk/miden-sdk");
      let requester = address;
      if (!/^0x[0-9a-fA-F]+$/.test(address)) {
        try {
          requester = AccountId.fromBech32(address).toString();
        } catch {
          requester = Address.fromBech32(address).accountId().toString();
        }
      }

      const resp = await fetch("/api/drip-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requester }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.noteB64) {
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }
      const b64ToBytes = (b: string) =>
        Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const {
        Note,
        NoteArray,
        NoteAndArgs,
        NoteAndArgsArray,
        TransactionRequestBuilder,
      } = await import("@miden-sdk/miden-sdk");

      // 1. Emit the drip request from the user's own wallet.
      setStage("Emitting — sign in MidenFi…");
      const dripNote = Note.deserialize(b64ToBytes(data.noteB64));
      const txReq = new TransactionRequestBuilder()
        .withOwnOutputNotes(new NoteArray([dripNote]))
        .build();
      await wallet.requestTransaction!(
        Transaction.createCustomTransaction(address, data.dispenser, txReq),
      );

      // 2. Wait for the network to run the drip + create the payout note.
      setStage("Network paying out (~30s)…");
      await new Promise((r) => setTimeout(r, 30_000));

      // 3. Claim the payout. It's a PRIVATE note the dispenser just created —
      // requestConsume expects an already-authenticated note in MidenFi's store
      // and silently re-prompts on a fresh one. Consuming it as an
      // UNAUTHENTICATED input note inside a custom tx works cleanly (the network
      // verifies the note exists on-chain at submission — the CLI's
      // `input_notes([(note, None)])` equivalent). Retry a couple times to give
      // the payout note a block or two to commit.
      setStage("Claiming — sign in MidenFi…");
      const payoutBytes = b64ToBytes(data.payoutNoteB64);
      const payoutNote = Note.deserialize(payoutBytes);
      const consumeReq = new TransactionRequestBuilder()
        .withInputNotes(new NoteAndArgsArray([new NoteAndArgs(payoutNote)]))
        .build();
      let claimed = false;
      let lastErr: unknown = null;
      for (let i = 0; i < 3 && !claimed; i++) {
        try {
          await wallet.requestTransaction!(
            Transaction.createCustomTransaction(
              address,
              address,
              consumeReq,
              [data.payoutId],
              [payoutBytes],
            ),
          );
          claimed = true;
        } catch (e) {
          lastErr = e;
          if (i < 2) await new Promise((x) => setTimeout(x, 6_000));
        }
      }
      if (!claimed) throw lastErr ?? new Error("claim failed");

      setStage("Refreshing balance…");
      await refreshBalance();
      setStage(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e).slice(0, 200));
      setStage(null);
    } finally {
      setBusy(false);
    }
  }, [address, busy, wallet, refreshBalance]);

  return (
    <section style={{ marginBottom: 40, maxWidth: 720 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>
        Miden — Miden-wallet rail (MidenFi)
      </h2>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 14,
          lineHeight: 1.6,
          marginBottom: 16,
        }}
      >
        dUSDC from the <strong>permissionless on-chain dispenser</strong> — you
        emit the request from your own wallet, the network pays out. No server.
      </p>

      {!connected ? (
        <div
          style={{
            background: "var(--surface-2, #efece3)",
            borderLeft: "3px solid var(--orange)",
            padding: "16px 20px",
          }}
        >
          <strong>Connect a Miden wallet</strong>
          <p style={{ color: "var(--ink-2)", fontSize: 14, margin: "6px 0 0" }}>
            Click <em>Connect Miden</em> in the top nav (MidenFi extension).
          </p>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            background: "var(--surface-2, #efece3)",
            padding: "16px 20px",
          }}
        >
          <div style={{ fontFamily: "var(--font-mono-stack)", fontSize: 14 }}>
            dUSDC balance: <strong>{human} dUSDC</strong>
          </div>
          <button
            type="button"
            onClick={getDusdc}
            disabled={busy}
            className="nav-cta"
            style={{ padding: "6px 16px", fontSize: 13, opacity: busy ? 0.5 : 1 }}
          >
            {busy ? "Working…" : "Get 5 test dUSDC"}
          </button>
          {stage && (
            <span
              style={{
                color: "var(--ink-2)",
                fontSize: 12,
                fontFamily: "var(--font-mono-stack)",
              }}
            >
              {stage}
            </span>
          )}
          {err && <span style={{ color: "crimson", fontSize: 12 }}>{err}</span>}
        </div>
      )}
    </section>
  );
}
