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
      console.log("[faucet-debug] requestAssets ->", assets);
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
      const { Note, NoteArray, TransactionRequestBuilder } = await import(
        "@miden-sdk/miden-sdk"
      );

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

      // 3. Claim the private payout — DIAGNOSTIC BUILD. Log everything MidenFi
      // sees so we can pinpoint why the consume doesn't land: does the payout
      // show up as consumable? does import work? what does requestConsume /
      // waitForTransaction actually return?
      setStage("Claiming — sign in MidenFi…");
      const D = "[faucet-debug]";
      console.log(D, "payoutId", data.payoutId, "dispenser", data.dispenser);

      const dumpConsumable = async (when: string) => {
        if (!wallet.requestConsumableNotes) return;
        try {
          const notes = await wallet.requestConsumableNotes();
          console.log(D, `consumable notes ${when}:`, notes);
        } catch (e) {
          console.warn(D, `requestConsumableNotes ${when} threw`, e);
        }
      };

      await dumpConsumable("before import");

      const payoutFileBytes = b64ToBytes(data.payoutFileB64);
      try {
        const imp = await wallet.importPrivateNote!(payoutFileBytes);
        console.log(D, "importPrivateNote OK ->", imp);
      } catch (e) {
        console.warn(D, "importPrivateNote FAILED", e);
      }

      await dumpConsumable("after import");

      let txId: string | undefined;
      try {
        txId = await wallet.requestConsume!({
          faucetId: EPOCH_DUSDC_FAUCET_ID,
          noteId: data.payoutId,
          noteType: "private",
          amount: 5_000_000,
          noteBytes: data.payoutNoteB64,
        });
        console.log(D, "requestConsume returned txId", txId);
      } catch (e) {
        console.error(D, "requestConsume THREW", e);
        throw e;
      }

      if (txId && wallet.waitForTransaction) {
        setStage("Confirming on-chain…");
        try {
          const r = await wallet.waitForTransaction(txId, 90_000);
          console.log(D, "waitForTransaction result", r);
        } catch (e) {
          console.error(D, "waitForTransaction threw", e);
        }
      }

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
