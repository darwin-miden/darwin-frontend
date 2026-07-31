"use client";

/**
 * Buy into a basket from the connected Miden account (Para or native MidenFi).
 *
 * This is the confidential/NAV deposit flow the main app's TrustlessDepositPanel
 * uses on `/baskets`, stripped of the derived-wallet + Epoch-bridge machinery: the
 * account is already funded with dUSDC (via the Deposit flow), so buying just
 * converts some of that dUSDC into basket shares.
 *
 * Signer-agnostic: everything keys off `useMiden().signerAccountId`, not a derived
 * wallet. Steps:
 *   1. POST /api/confidential-note (keyless server builder) → a deposit note that
 *      carries `amount` dUSDC, plus a private payback note that mints shares.
 *   2. Emit the deposit note as the account's own output note (executeTx). The
 *      Miden network NTX builder drains the dUSDC into the basket faucet vault and
 *      mints shares (priced at live NAV for DCC) into the private payback note.
 *   3. Import + consume the payback note → shares land in the account's vault.
 *
 * Inline styles + the app CSS vars (no Tailwind).
 */

import { TransactionRequestBuilder } from "@miden-sdk/miden-sdk";
import { useConsume, useMiden, useSyncState, useTransaction } from "@miden-sdk/react";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";

import { EPOCH_USDC_SEPOLIA } from "../../lib/epoch";
import { basketDecimals, isNavBasket } from "../../lib/basketFaucets";
import { liveDccBalance } from "../../lib/dccBalance";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stage = "idle" | "building" | "emitting" | "claiming" | "done" | "error";
const STAGE_LABEL: Record<Stage, string> = {
  idle: "",
  building: "Building your order…",
  emitting: "Signing the deposit…",
  claiming: "Minting basket shares…",
  done: "Bought ✓",
  error: "",
};

export function BasketBuyPanel({
  symbol,
  name,
  onDone,
}: {
  symbol: string;
  name: string;
  onDone?: () => void;
}) {
  const { client, runExclusive, signerAccountId, isReady } = useMiden() as unknown as {
    client: unknown;
    runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>;
    signerAccountId: string | null;
    isReady: boolean;
  };
  const { consume } = useConsume();
  const { sync: syncState } = useSyncState();
  const { execute: executeTx } = useTransaction() as unknown as {
    execute: (o: {
      accountId: string;
      request: () => unknown;
    }) => Promise<{ transactionId?: { toString?: () => string } } | null>;
  };

  const [dusdc, setDusdc] = useState<bigint | null>(null);
  const [shares, setShares] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";
  const nav = isNavBasket(symbol);

  const refresh = useCallback(async () => {
    if (!client || !signerAccountId) return;
    try {
      const { AccountId } = await import("@miden-sdk/miden-sdk");
      const dFaucet = AccountId.fromHex(EPOCH_USDC_SEPOLIA.midenFaucetId);
      const acc = (await runExclusive(() =>
        (client as { getAccount: (id: unknown) => Promise<unknown> }).getAccount(
          AccountId.fromHex(signerAccountId),
        ),
      )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
      setDusdc(acc ? BigInt(acc.vault().getBalance(dFaucet) ?? 0n) : 0n);
    } catch {
      /* vault not synced yet */
    }
    setShares(await liveDccBalance(client, runExclusive, signerAccountId, symbol));
  }, [client, signerAccountId, runExclusive, symbol]);

  useEffect(() => {
    if (isReady && signerAccountId) refresh();
  }, [isReady, signerAccountId, refresh]);

  async function onBuy() {
    if (!signerAccountId || !client) return;
    setError(null);
    try {
      // dUSDC is 6-dec; the note carries dUSDC base units drained from the vault.
      let amountBase = parseUnits(amount || "0", EPOCH_USDC_SEPOLIA.midenDecimals);
      if (dusdc != null && amountBase > dusdc) amountBase = dusdc; // never over-spend the vault
      if (amountBase <= 0n) throw new Error("Enter an amount to buy.");

      setStage("building");
      const r = await fetch("/api/confidential-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: signerAccountId,
          recipient: signerAccountId,
          basket: symbol,
          amount: amountBase.toString(),
        }),
      });
      const built = (await r.json()) as {
        noteId?: string;
        noteB64?: string;
        paybackId?: string;
        paybackFileB64?: string;
        mintAmount?: string;
        error?: string;
      };
      if (!r.ok || !built.noteB64 || !built.paybackFileB64 || !built.paybackId) {
        throw new Error(built.error ?? `confidential-note API ${r.status}`);
      }

      setStage("emitting");
      const { Note, NoteArray, NoteFile } = await import("@miden-sdk/miden-sdk");
      const depositNote = Note.deserialize(Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0)));
      await executeTx({
        accountId: signerAccountId,
        request: () => new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([depositNote])).build(),
      });

      setStage("claiming");
      const noteFile = NoteFile.deserialize(
        Uint8Array.from(atob(built.paybackFileB64), (c) => c.charCodeAt(0)),
      );
      await (client as { importNoteFile?: (f: unknown) => Promise<string> }).importNoteFile?.(noteFile);
      let claimed = false;
      for (let i = 0; i < 30; i++) {
        await sleep(5000);
        try {
          await runExclusive(() => syncState());
        } catch {
          /* retry */
        }
        try {
          await consume({ accountId: signerAccountId, notes: [built.paybackId] });
          claimed = true;
          break;
        } catch {
          /* shares not minted yet — keep polling */
        }
      }
      if (!claimed) {
        throw new Error("Shares minted but not claimed yet — refresh in a moment, your funds are safe.");
      }

      setStage("done");
      await refresh();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  if (!isReady || !signerAccountId) {
    return <p style={{ fontSize: 14, color: "var(--ink-3)" }}>Connect your account to buy.</p>;
  }

  const dusdcHuman = dusdc != null ? formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals) : "—";
  const sharesHuman = shares != null ? formatUnits(shares, basketDecimals(symbol)) : "—";
  const amountNum = Number(amount);
  const overBalance = !!amount && dusdc != null && amountNum > Number(dusdcHuman);
  const noFunds = dusdc != null && dusdc <= 0n;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--ink)" }}>
        Buy {name} <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>({symbol})</span>
      </h2>
      <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
        {nav
          ? "Convert dUSDC into basket shares, priced at the basket's live net asset value."
          : "Convert dUSDC into basket shares (1:1 collateral)."}
      </p>

      <div style={sty.row}>
        <span style={{ color: "var(--ink-3)" }}>Your dUSDC</span>
        <span style={sty.mono}>{dusdcHuman}</span>
      </div>
      <div style={sty.row}>
        <span style={{ color: "var(--ink-3)" }}>Your {symbol} shares</span>
        <span style={sty.mono}>{sharesHuman}</span>
      </div>

      <label style={{ ...sty.fieldLabel, display: "flex", justifyContent: "space-between" }}>
        <span>Amount to spend</span>
        <span style={{ textTransform: "none" }}>Balance: {dusdcHuman} dUSDC</span>
      </label>
      <div style={sty.inputRow}>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          disabled={busy || noFunds}
          style={sty.input}
          placeholder="0.0"
        />
        <button
          type="button"
          onClick={() => dusdc != null && setAmount(formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals))}
          disabled={busy || noFunds}
          style={sty.maxBtn}
        >
          Max
        </button>
        <span style={{ fontSize: 14, color: "var(--ink-3)" }}>dUSDC</span>
      </div>

      {overBalance && (
        <p style={{ marginTop: 8, fontSize: 12, color: "#b91c1c" }}>Amount exceeds your dUSDC balance.</p>
      )}
      {noFunds && (
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)" }}>
          No dUSDC yet — use Deposit to add funds first.
        </p>
      )}

      <button
        type="button"
        onClick={onBuy}
        disabled={busy || noFunds || !amount || amountNum <= 0 || overBalance}
        className="nav-cta"
        style={{
          ...sty.fullBtn,
          opacity: busy || noFunds || !amount || amountNum <= 0 || overBalance ? 0.5 : 1,
        }}
      >
        {busy ? STAGE_LABEL[stage] : `Buy ${symbol}`}
      </button>

      {stage === "claiming" && (
        <p style={sty.hint}>The network is minting your shares — this can take up to a minute.</p>
      )}
      {stage === "done" && <p style={sty.doneMsg}>Bought ✓ — {symbol} shares are in your account.</p>}
      {error && <p style={sty.errMsg}>{error}</p>}
    </div>
  );
}

const sty: Record<string, CSSProperties> = {
  row: {
    marginTop: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid var(--rule)",
    paddingBottom: 8,
    fontSize: 14,
  },
  mono: { fontFamily: "var(--font-mono-stack)", color: "var(--ink)" },
  fieldLabel: {
    marginTop: 18,
    display: "block",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--ink-3)",
  },
  inputRow: { marginTop: 6, display: "flex", alignItems: "center", gap: 8 },
  input: {
    width: "100%",
    borderRadius: 8,
    border: "1px solid var(--rule)",
    background: "var(--paper)",
    padding: "9px 12px",
    fontFamily: "var(--font-mono-stack)",
    fontSize: 14,
    color: "var(--ink)",
    outline: "none",
  },
  maxBtn: {
    flexShrink: 0,
    borderRadius: 8,
    border: "1px solid var(--rule)",
    background: "transparent",
    padding: "9px 12px",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--ink-2)",
    cursor: "pointer",
  },
  fullBtn: { width: "100%", textAlign: "center", marginTop: 16 },
  hint: { marginTop: 12, fontSize: 12, color: "var(--ink-3)" },
  doneMsg: {
    marginTop: 12,
    borderRadius: 8,
    border: "1px solid rgba(76,195,138,0.4)",
    background: "rgba(76,195,138,0.12)",
    padding: "8px 12px",
    fontSize: 13,
    color: "#2e7d52",
  },
  errMsg: {
    marginTop: 12,
    borderRadius: 8,
    border: "1px solid rgba(220,38,38,0.35)",
    background: "rgba(220,38,38,0.08)",
    padding: "8px 12px",
    fontSize: 12,
    color: "#b91c1c",
  },
};
