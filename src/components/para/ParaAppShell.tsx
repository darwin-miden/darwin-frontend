"use client";

/**
 * Connected app shell (Polymarket-style): top bar with Portfolio / Cash /
 * Deposit / account, plus the funding+withdraw flow in a modal. Signer-AGNOSTIC
 * — it drives connect/disconnect through the unified `useSigner()`, so it works
 * identically under ParaProviders (Para) or MidenNativeProviders (MidenFi). The
 * Para-vs-Miden choice is made a level up (ParaApp), which mounts the matching
 * provider around this shell.
 *
 * Styled with the app's own CSS system (CSS vars + `nav-cta`) via inline styles
 * — the app does NOT use Tailwind.
 */

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useCompile, useMiden, useSigner, useSyncState, useTransaction } from "@miden-sdk/react";
import { formatUnits } from "viem";

import { EPOCH_USDC_SEPOLIA } from "../../lib/epoch";
import { ensureSignerAccountLoaded } from "../../lib/ensureAccount";
import { restorePara, verifyParaBackupRoundtrip } from "../../lib/paraBackup";
import { resilientSync } from "../../lib/resilientSync";
import { setRestoreStatus } from "../../lib/paraRestoreGate";

// Private-account mode: the Para-derived Miden account is storageMode: private, so
// its state can't self-heal from chain — it's restored from the encrypted on-chain
// backup instead. Gated so the public build keeps its (working) self-heal path.
const PARA_PRIVATE = process.env.NEXT_PUBLIC_PARA_PRIVATE === "1";
import { BASKETS } from "../../lib/baskets";
import { DepositMethods } from "./DepositMethods";
import { BasketTradePanel } from "./BasketTradePanel";
import { LogoFull } from "../Logo";

function short(v: string | null | undefined, head = 6, tail = 4) {
  if (!v) return "";
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}

const label: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--ink-3)",
};
const value: CSSProperties = {
  fontFamily: "var(--font-mono-stack)",
  fontSize: 15,
  fontWeight: 600,
  color: "var(--ink)",
};

const shellRoot: CSSProperties = {
  minHeight: "100vh",
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans-stack)",
};
const topbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px clamp(20px, 4vw, 40px)",
  borderBottom: "1px solid var(--rule)",
};

export function ParaAppShell({ onExit }: { onExit: () => void }) {
  const signer = useSigner();
  const { client, runExclusive, signerAccountId, isReady } = useMiden() as unknown as {
    client: unknown;
    runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>;
    signerAccountId: string | null;
    isReady: boolean;
  };
  const { sync: syncState } = useSyncState();
  const { txScript } = useCompile() as unknown as {
    txScript: (o: { code: string }) => Promise<unknown>;
  };
  const { execute: executeTx } = useTransaction() as unknown as {
    execute: (o: { accountId: string; skipSync?: boolean; request: () => unknown }) => Promise<unknown>;
  };
  // Latch the connected gate on the STICKY signerAccountId. Para's useAccount()
  // react-query key includes the injected wallet's evmAccount address/chainId, so
  // during a long sign+prove (a NAV redeem can take up to 120s on the remote
  // prover) a transient wagmi refresh flips signer.isConnected to false for a
  // render or two — which, if gated on directly, tears this shell down to the
  // "Finishing sign-in…" screen MID-TRADE (the user perceives it as a logout, and
  // the client re-init that follows leaves the vault reading 0 → redeem underflow).
  // signerAccountId survives that blip (MidenProvider keeps it across a transient
  // Para disconnect; a real disconnect goes through onExit at the ParaApp level and
  // unmounts this whole shell), so once connected, gate on the account id alone.
  const everConnected = useRef(false);
  if (signer?.isConnected && signerAccountId) everConnected.current = true;
  const connected = everConnected.current
    ? !!signerAccountId
    : !!signer?.isConnected && !!signerAccountId;

  const [dusdc, setDusdc] = useState<bigint | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [buySymbol, setBuySymbol] = useState<string | null>(null);

  // Kick off the wallet connection once when this shell mounts (the method was
  // already chosen a level up). For Para this pops the Para modal; for MidenFi
  // it prompts the extension.
  const tried = useRef(false);
  useEffect(() => {
    if (!tried.current && !signer?.isConnected) {
      tried.current = true;
      Promise.resolve(signer?.connect?.()).catch(() => {});
    }
  }, [signer]);

  // Read the dUSDC vault balance. Sync FIRST — a `getAccount` without a fresh
  // sync returns the last-known (often stale/zero) state, which is why a funded
  // account can read $0.00 right after connecting or switching. Retry a couple of
  // times: the node may lag a beat behind the on-chain deposit.
  const refreshBalance = useCallback(async () => {
    if (!client || !signerAccountId) return;
    const { AccountId } = await import("@miden-sdk/miden-sdk");
    const faucet = AccountId.fromHex(EPOCH_USDC_SEPOLIA.midenFaucetId);
    for (let attempt = 0; attempt < 3; attempt++) {
      // resilientSync retries through transient replica lag ("block_to > chain tip") so a
      // load-balanced node that's a couple blocks behind doesn't leave the balance stale.
      await resilientSync(runExclusive, syncState);
      try {
        const acc = (await runExclusive(() =>
          (client as { getAccount: (id: unknown) => Promise<unknown> }).getAccount(
            AccountId.fromHex(signerAccountId),
          ),
        )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
        const bal = acc ? BigInt(acc.vault().getBalance(faucet) ?? 0n) : 0n;
        setDusdc(bal);
        if (bal > 0n) return;
      } catch {
        /* vault not synced yet — retry */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, [client, signerAccountId, runExclusive, syncState]);

  // Self-heal the signer account into a fresh local store (new browser / cleared
  // storage / a DIFFERENT ORIGIN like the Vercel deploy vs the Mac). The account
  // is public + deterministic, so if it's missing locally we re-import its
  // on-chain state — otherwise a later claim throws "account data wasn't found".
  // Runs once per account, BEFORE the first balance read (which then sees it).
  // Restore-failed banner: when restore ERRORS (not "no backup"), we must block trading
  // and tell the user to reload — an emit against the un-restored account would be wrong.
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const healed = useRef<string | null>(null);
  useEffect(() => {
    if (!isReady || !signerAccountId || !client) return;
    if (healed.current === signerAccountId) return;
    const acct = signerAccountId;
    void (async () => {
      await ensureSignerAccountLoaded(client, runExclusive, acct).catch(() => {});
      // Private /para: a private account can't re-import its state from chain (the node
      // keeps only the commitment). Restore the account file from the encrypted on-chain
      // backup so the LOCAL state matches its commitment. Distinguish the outcomes:
      //  · restored / skipped (local already newer or equal) → ready to trade
      //  · no backup → genuinely fresh account, ready to trade
      //  · error → do NOT latch (so it retries on the next render/reload), block trading
      if (PARA_PRIVATE) {
        try {
          const r = await restorePara({ client, runExclusive, walletId: acct });
          if (r.error) {
            console.warn(`[para-restore] FAILED (not 'no backup') — ${r.error}`);
            setRestoreError(r.error);
            setRestoreStatus(acct, "failed");
            await refreshBalance();
            return; // do NOT latch healed → retry on next effect run/reload
          }
          console.log(
            `[para-restore] ${r.restored ? "restored from backup" : r.skipped ? "skipped (" + r.skipped + ")" : "no backup"}`,
          );
          setRestoreError(null);
          setRestoreStatus(acct, r.restored || r.skipped ? "ready" : "none");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[para-restore] failed", e);
          setRestoreError(msg);
          setRestoreStatus(acct, "failed");
          await refreshBalance();
          return; // do NOT latch → retry
        }
      } else {
        setRestoreStatus(acct, "none"); // public build: nothing to restore, never block
      }
      healed.current = acct; // latch ONLY on a clean outcome
      await refreshBalance();
    })();
  }, [isReady, signerAccountId, client, runExclusive, refreshBalance]);

  useEffect(() => {
    if (isReady && signerAccountId) refreshBalance();
  }, [isReady, signerAccountId, refreshBalance]);

  // DEV-ONLY console self-test for the backup — `__darwinParaBackupTest()`. It writes
  // REAL txs to the controller and (dummy mode) to a throwaway slot, so it is gated on
  // NODE_ENV: NEVER exposed on window in a production build (a "paste this in console"
  // scam could otherwise spend prover cycles / probe the backup). Dev builds only.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!PARA_PRIVATE || !client || !signerAccountId) return;
    const w = window as unknown as {
      __darwinParaBackupTest?: (dummyChunks?: number, chunksPerTx?: number) => Promise<unknown>;
    };
    // __darwinParaBackupTest()            → back up the REAL account file
    // __darwinParaBackupTest(1)           → write a 1-word dummy (probe the prover)
    // __darwinParaBackupTest(1, 6)        → dummy + explicit chunks-per-tx
    w.__darwinParaBackupTest = async (dummyChunks?: number, chunksPerTx?: number) => {
      console.log(
        `[para-backup-test] running (write → read-back${dummyChunks ? "" : " → deserialize"})…`,
        { dummyChunks: dummyChunks ?? null, chunksPerTx: chunksPerTx ?? "default" },
      );
      const r = await verifyParaBackupRoundtrip(
        { client, runExclusive, compileTxScript: txScript, executeTx, walletId: signerAccountId },
        { dummyChunks, chunksPerTx },
      );
      console.log("[para-backup-test] verdict:", r);
      return r;
    };
    return () => {
      delete (window as unknown as { __darwinParaBackupTest?: unknown }).__darwinParaBackupTest;
    };
  }, [client, signerAccountId, runExclusive, txScript, executeTx]);
  useEffect(() => {
    if (!depositOpen && connected) refreshBalance();
  }, [depositOpen, connected, refreshBalance]);
  // Keep Cash live: poll while connected so a deposit made in the modal (or the
  // initial synced-in balance) shows up in the header without a manual reload.
  // Once the balance is non-zero, refreshBalance returns on the first read, so a
  // funded account polls cheaply (one sync).
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      void refreshBalance();
    }, 10_000);
    return () => clearInterval(id);
  }, [connected, refreshBalance]);

  const cash = dusdc != null ? Number(formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals)) : 0;
  const cashUsd = cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function disconnect() {
    try {
      await signer?.disconnect?.();
    } catch {
      /* ignore */
    }
    onExit();
  }

  // Not connected yet (completing sign-in / user closed the modal).
  if (!connected) {
    return (
      <div style={shellRoot}>
        <header style={topbar}>
          <span className="nav-logo" style={{ display: "flex" }}>
            <LogoFull aria-label="Darwin" />
          </span>
          <button type="button" className="nav-cta" onClick={disconnect}>
            Cancel
          </button>
        </header>
        <main style={{ maxWidth: 480, margin: "0 auto", padding: "clamp(60px, 14vh, 160px) 20px", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Finishing sign-in…</h1>
          <p style={{ marginTop: 10, color: "var(--ink-3)" }}>
            A Para popup opens to finish sign-in. If your browser blocked it, allow
            popups for this site, then Retry — and sign the verification message your
            wallet prompts.
          </p>
          <button
            type="button"
            className="nav-cta"
            style={{ marginTop: 18 }}
            onClick={() => Promise.resolve(signer?.connect?.()).catch(() => {})}
          >
            Retry
          </button>
        </main>
      </div>
    );
  }

  return (
    <div style={shellRoot}>
      <header style={topbar}>
        <span className="nav-logo" style={{ display: "flex" }}>
          <LogoFull aria-label="Darwin" />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ textAlign: "right" }}>
            <div style={label}>Portfolio</div>
            <div style={value}>$0.00</div>
          </div>
          <button
            type="button"
            onClick={() => setDepositOpen(true)}
            style={{ textAlign: "right", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            title="Add or withdraw funds"
          >
            <div style={label}>Cash</div>
            <div style={{ ...value, color: "var(--green)" }}>${cashUsd}</div>
          </button>
          <button type="button" className="nav-cta" onClick={() => setDepositOpen(true)}>
            Deposit
          </button>
          <button
            type="button"
            className="nav-cta"
            onClick={disconnect}
            title={signerAccountId ?? ""}
            style={{ fontFamily: "var(--font-mono-stack)", fontSize: 12 }}
          >
            {short(signerAccountId)} ⏻
          </button>
        </div>
      </header>

      <main style={{ maxWidth: "var(--max)", margin: "0 auto", padding: "clamp(32px, 6vh, 72px) clamp(20px, 4vw, 40px)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Baskets</h1>
          <p style={{ margin: 0, fontSize: 14, color: "var(--ink-3)" }}>
            You hold{" "}
            <span style={{ fontFamily: "var(--font-mono-stack)", color: "var(--green)" }}>${cashUsd}</span> in dUSDC ·{" "}
            <button
              type="button"
              onClick={() => setDepositOpen(true)}
              style={{ background: "none", border: "none", padding: 0, color: "var(--orange)", cursor: "pointer", textDecoration: "underline" }}
            >
              Deposit
            </button>
          </p>
        </div>

        {restoreError && (
          <div
            role="alert"
            style={{
              marginTop: 16,
              padding: "12px 16px",
              borderRadius: 10,
              background: "color-mix(in srgb, var(--orange) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--orange) 45%, transparent)",
              color: "var(--ink-1)",
              fontSize: 14,
            }}
          >
            Couldn&apos;t restore your account state (node may be syncing). Please reload
            before trading, so a trade isn&apos;t sent against an unrestored account.
          </div>
        )}

        <div
          style={{
            marginTop: 20,
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {BASKETS.map((b) => (
            <div
              key={b.symbol}
              style={{
                background: "var(--paper-2)",
                border: "1px solid var(--rule)",
                borderRadius: 16,
                padding: 20,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{b.name}</h2>
                <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 13, color: "var(--ink-3)" }}>{b.symbol}</span>
              </div>
              <p style={{ marginTop: 8, fontSize: 13, color: "var(--ink-3)", flex: 1 }}>{b.description}</p>
              <button
                type="button"
                className="nav-cta"
                style={{ marginTop: 16, width: "100%", textAlign: "center" }}
                onClick={() => setBuySymbol(b.symbol)}
              >
                Buy
              </button>
            </div>
          ))}
        </div>
      </main>

      {depositOpen && (
        <Overlay onClose={() => setDepositOpen(false)}>
          <DepositMethods />
        </Overlay>
      )}

      {buySymbol && (
        <Overlay onClose={() => setBuySymbol(null)}>
          <BasketTradePanel
            symbol={buySymbol}
            name={BASKETS.find((b) => b.symbol === buySymbol)?.name ?? buySymbol}
            onDone={refreshBalance}
          />
        </Overlay>
      )}
    </div>
  );
}

export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflowY: "auto",
        background: "rgba(11,11,12,0.55)",
        padding: "40px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--paper)",
          border: "1px solid var(--rule)",
          borderRadius: 18,
          padding: 22,
          boxShadow: "0 20px 60px rgba(11,11,12,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-3)" }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
