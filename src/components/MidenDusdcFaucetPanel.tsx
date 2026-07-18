"use client";

/**
 * Miden dUSDC faucet — same clean interface as the Sepolia panel (balance + one
 * button), but dUSDC comes from the PERMISSIONLESS on-chain dispenser: the
 * button emits a drip request from the user's own MidenFi wallet, waits for the
 * network to pay out, and claims the private payout. Two MidenFi popups (emit +
 * claim) behind one button.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import { useAccount, useImportAccount } from "@miden-sdk/react";

import { EPOCH_DUSDC_FAUCET_ID } from "../lib/midenConstants";

export function MidenDusdcFaucetPanel() {
  const wallet = useMidenFiWallet();
  const { connected, address } = wallet;
  const {
    account: walletAccount,
    isLoading: walletAccountLoading,
    getBalance,
  } = useAccount(address ?? undefined);
  const { importAccount, isImporting } = useImportAccount();
  const [importTriedFor, setImportTriedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Hydrate the local account record so getBalance works (same as the deposit panel).
  useEffect(() => {
    if (!address || walletAccountLoading || walletAccount) return;
    if (importTriedFor === address || isImporting) return;
    setImportTriedFor(address);
    importAccount({ type: "id", accountId: address }).catch(() => {});
  }, [
    address,
    walletAccount,
    walletAccountLoading,
    isImporting,
    importTriedFor,
    importAccount,
  ]);

  // Return 0 (not null) when the account record isn't hydrated yet or the asset
  // isn't in the vault — same as the deposit panel — so it reads "0 dUSDC"
  // instead of a stuck "…". Updates once the account loads / after a drip.
  const balance = useMemo(() => {
    void nonce;
    if (!walletAccount) return 0n;
    try {
      return getBalance(EPOCH_DUSDC_FAUCET_ID);
    } catch {
      return 0n;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAccount, getBalance, nonce]);

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
      // out to; send its canonical string (hex/clean-bech32) to the builder.
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
      const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
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

      // 2. Wait for the network to run the drip + pay out.
      setStage("Network paying out (~30s)…");
      await new Promise((r) => setTimeout(r, 30_000));

      // 3. Claim the payout. It's a PRIVATE note the dispenser just created —
      // MidenFi hasn't synced it, so requestConsume (which expects an
      // already-authenticated note sitting in the store) can't prove it and
      // silently re-prompts. Instead build a custom consume tx with the note as
      // an UNAUTHENTICATED input note (the CLI's `input_notes([(note, None)])`
      // equivalent): the network verifies the note exists on-chain at submission.
      // Retry a few times to give the payout note a couple of blocks to commit.
      setStage("Claiming — sign in MidenFi…");
      const payoutBytes = b64ToBytes(data.payoutNoteB64);
      const payoutNote = Note.deserialize(payoutBytes);
      const consumeReq = new TransactionRequestBuilder()
        .withInputNotes(new NoteAndArgsArray([new NoteAndArgs(payoutNote)]))
        .build();
      let claimed = false;
      let lastErr: unknown = null;
      for (let i = 0; i < 5 && !claimed; i++) {
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
          if (i < 4) await new Promise((x) => setTimeout(x, 6_000));
        }
      }
      if (!claimed) throw lastErr ?? new Error("claim failed");
      setStage(null);
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(String((e as Error).message ?? e).slice(0, 180));
      setStage(null);
    } finally {
      setBusy(false);
    }
  }, [address, busy, wallet]);

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
