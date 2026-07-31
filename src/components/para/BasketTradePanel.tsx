"use client";

/**
 * Buy into / sell out of a basket from the connected Miden account (Para or
 * native MidenFi). This is the confidential/NAV flow the main app uses on
 * `/baskets` (TrustlessDeposit/RedeemPanel `network` branch), stripped of the
 * derived-wallet + Epoch-bridge machinery and keyed off `useMiden().signerAccountId`.
 *
 * Buy  — spend vault dUSDC → basket shares:
 *   POST /api/confidential-note → emit the deposit note (executeTx) → the NTX
 *   builder drains dUSDC into the faucet vault and mints shares (priced at live
 *   NAV for DCC) into a private payback note → import + consume it.
 * Sell — burn basket shares → vault dUSDC (the mirror):
 *   POST /api/confidential-redeem → emit the redeem-request note carrying the
 *   shares → the NTX builder burns them and releases pro-rata dUSDC into a
 *   private payback note → import + consume it.
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
const BUY_LABEL: Record<Stage, string> = {
  idle: "",
  building: "Building your order…",
  emitting: "Signing the deposit…",
  claiming: "Minting basket shares…",
  done: "Bought ✓",
  error: "",
};
const SELL_LABEL: Record<Stage, string> = {
  idle: "",
  building: "Building your order…",
  emitting: "Signing the sale…",
  claiming: "Releasing dUSDC…",
  done: "Sold ✓",
  error: "",
};

type BuiltNote = {
  noteId?: string;
  noteB64?: string;
  paybackId?: string;
  paybackFileB64?: string;
  error?: string;
};

export function BasketTradePanel({
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
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [buyStage, setBuyStage] = useState<Stage>("idle");
  const [sellStage, setSellStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const buyBusy = buyStage !== "idle" && buyStage !== "done" && buyStage !== "error";
  const sellBusy = sellStage !== "idle" && sellStage !== "done" && sellStage !== "error";
  const nav = isNavBasket(symbol);
  const shareDecimals = basketDecimals(symbol);

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

  // Emit a server-built note as the account's own output note, then import +
  // consume the private payback note the NTX builder produces. Shared by buy
  // (deposit note → minted shares) and sell (redeem note → released dUSDC).
  async function emitAndClaim(built: BuiltNote, setStage: (s: Stage) => void) {
    setStage("emitting");
    const { Note, NoteArray, NoteFile } = await import("@miden-sdk/miden-sdk");
    const note = Note.deserialize(Uint8Array.from(atob(built.noteB64!), (c) => c.charCodeAt(0)));
    await executeTx({
      accountId: signerAccountId!,
      request: () => new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note])).build(),
    });

    setStage("claiming");
    const noteFile = NoteFile.deserialize(
      Uint8Array.from(atob(built.paybackFileB64!), (c) => c.charCodeAt(0)),
    );
    await (client as { importNoteFile?: (f: unknown) => Promise<string> }).importNoteFile?.(noteFile);
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      try {
        await runExclusive(() => syncState());
      } catch {
        /* retry */
      }
      try {
        await consume({ accountId: signerAccountId!, notes: [built.paybackId!] });
        return true;
      } catch {
        /* not settled yet — keep polling */
      }
    }
    return false;
  }

  async function onBuy() {
    if (!signerAccountId || !client) return;
    setError(null);
    try {
      // dUSDC is 6-dec; the note carries dUSDC base units drained from the vault.
      let amountBase = parseUnits(buyAmount || "0", EPOCH_USDC_SEPOLIA.midenDecimals);
      if (dusdc != null && amountBase > dusdc) amountBase = dusdc; // never over-spend
      if (amountBase <= 0n) throw new Error("Enter an amount to buy.");

      setBuyStage("building");
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
      const built = (await r.json()) as BuiltNote;
      if (!r.ok || !built.noteB64 || !built.paybackFileB64 || !built.paybackId) {
        throw new Error(built.error ?? `confidential-note API ${r.status}`);
      }
      const claimed = await emitAndClaim(built, setBuyStage);
      if (!claimed) throw new Error("Shares minted but not claimed yet — refresh in a moment, your funds are safe.");
      setBuyStage("done");
      await refresh();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBuyStage("error");
    }
  }

  async function onSell() {
    if (!signerAccountId || !client) return;
    setError(null);
    try {
      // Shares are basketDecimals-dec; the redeem note carries the shares to burn.
      let sharesBase = parseUnits(sellAmount || "0", shareDecimals);
      if (shares != null && sharesBase > shares) sharesBase = shares; // never over-sell
      if (sharesBase <= 0n) throw new Error("Enter an amount of shares to sell.");

      setSellStage("building");
      const r = await fetch("/api/confidential-redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: signerAccountId,
          recipient: signerAccountId,
          basket: symbol,
          amount: sharesBase.toString(),
        }),
      });
      const built = (await r.json()) as BuiltNote;
      if (!r.ok || !built.noteB64 || !built.paybackFileB64 || !built.paybackId) {
        throw new Error(built.error ?? `confidential-redeem API ${r.status}`);
      }
      const claimed = await emitAndClaim(built, setSellStage);
      if (!claimed) throw new Error("dUSDC released but not claimed yet — refresh in a moment, your funds are safe.");
      setSellStage("done");
      await refresh();
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSellStage("error");
    }
  }

  if (!isReady || !signerAccountId) {
    return <p style={{ fontSize: 14, color: "var(--ink-3)" }}>Connect your account to trade.</p>;
  }

  const dusdcHuman = dusdc != null ? formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals) : "—";
  const sharesHuman = shares != null ? formatUnits(shares, shareDecimals) : "—";
  const buyNum = Number(buyAmount);
  const sellNum = Number(sellAmount);
  const buyOver = !!buyAmount && dusdc != null && buyNum > Number(dusdcHuman);
  const sellOver = !!sellAmount && shares != null && sellNum > Number(sharesHuman);
  const noFunds = dusdc != null && dusdc <= 0n;
  const holdsShares = shares != null && shares > 0n;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--ink)" }}>
        {name} <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>({symbol})</span>
      </h2>
      <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
        {nav
          ? "Trade dUSDC and basket shares at the basket's live net asset value."
          : "Trade dUSDC and basket shares (1:1 collateral)."}
      </p>

      <div style={sty.row}>
        <span style={{ color: "var(--ink-3)" }}>Your dUSDC</span>
        <span style={sty.mono}>{dusdcHuman}</span>
      </div>
      <div style={sty.row}>
        <span style={{ color: "var(--ink-3)" }}>Your {symbol} shares</span>
        <span style={sty.mono}>{sharesHuman}</span>
      </div>

      {/* Buy */}
      <label style={{ ...sty.fieldLabel, display: "flex", justifyContent: "space-between" }}>
        <span>Buy — spend dUSDC</span>
        <span style={{ textTransform: "none" }}>Balance: {dusdcHuman} dUSDC</span>
      </label>
      <div style={sty.inputRow}>
        <input
          value={buyAmount}
          onChange={(e) => setBuyAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          disabled={buyBusy || noFunds}
          style={sty.input}
          placeholder="0.0"
        />
        <button
          type="button"
          onClick={() => dusdc != null && setBuyAmount(formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals))}
          disabled={buyBusy || noFunds}
          style={sty.maxBtn}
        >
          Max
        </button>
        <span style={{ fontSize: 14, color: "var(--ink-3)" }}>dUSDC</span>
      </div>
      {buyOver && <p style={sty.warn}>Amount exceeds your dUSDC balance.</p>}
      {noFunds && <p style={sty.muted}>No dUSDC yet — use Deposit to add funds first.</p>}
      <button
        type="button"
        onClick={onBuy}
        disabled={buyBusy || noFunds || !buyAmount || buyNum <= 0 || buyOver}
        className="nav-cta"
        style={{ ...sty.fullBtn, opacity: buyBusy || noFunds || !buyAmount || buyNum <= 0 || buyOver ? 0.5 : 1 }}
      >
        {buyBusy ? BUY_LABEL[buyStage] : `Buy ${symbol}`}
      </button>
      {buyStage === "claiming" && <p style={sty.hint}>The network is minting your shares — up to a minute.</p>}
      {buyStage === "done" && <p style={sty.doneMsg}>Bought ✓ — {symbol} shares are in your account.</p>}

      {/* Sell — shown once the account holds shares */}
      {holdsShares && (
        <div style={{ marginTop: 24, borderTop: "1px solid var(--rule)", paddingTop: 20 }}>
          <label style={{ ...sty.fieldLabel, marginTop: 0, display: "flex", justifyContent: "space-between" }}>
            <span>Sell — burn shares for dUSDC</span>
            <span style={{ textTransform: "none" }}>Balance: {sharesHuman} {symbol}</span>
          </label>
          <div style={sty.inputRow}>
            <input
              value={sellAmount}
              onChange={(e) => setSellAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={sellBusy}
              style={sty.input}
              placeholder="0.0"
            />
            <button
              type="button"
              onClick={() => shares != null && setSellAmount(formatUnits(shares, shareDecimals))}
              disabled={sellBusy}
              style={sty.maxBtn}
            >
              Max
            </button>
            <span style={{ fontSize: 14, color: "var(--ink-3)" }}>{symbol}</span>
          </div>
          {sellOver && <p style={sty.warn}>Amount exceeds your {symbol} balance.</p>}
          <button
            type="button"
            onClick={onSell}
            disabled={sellBusy || !sellAmount || sellNum <= 0 || sellOver}
            className="nav-cta"
            style={{ ...sty.fullBtn, opacity: sellBusy || !sellAmount || sellNum <= 0 || sellOver ? 0.5 : 1 }}
          >
            {sellBusy ? SELL_LABEL[sellStage] : `Sell ${symbol}`}
          </button>
          {sellStage === "claiming" && <p style={sty.hint}>The network is releasing your dUSDC — up to a minute.</p>}
          {sellStage === "done" && <p style={sty.doneMsg}>Sold ✓ — dUSDC is back in your account.</p>}
        </div>
      )}

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
  warn: { marginTop: 8, fontSize: 12, color: "#b91c1c" },
  muted: { marginTop: 8, fontSize: 12, color: "var(--ink-3)" },
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
