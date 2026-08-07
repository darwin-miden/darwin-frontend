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
import {
  clearMidenStorage,
  useCompile,
  useConsume,
  useExecuteProgram,
  useExportStore,
  useMiden,
  useSyncState,
  useTransaction,
} from "@miden-sdk/react";
import { type CSSProperties, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatUnits, parseUnits } from "viem";

import { EPOCH_USDC_SEPOLIA } from "../../lib/epoch";
import { ensureSignerAccountLoaded } from "../../lib/ensureAccount";
import { resilientSync } from "../../lib/resilientSync";
import { awaitRestore } from "../../lib/paraRestoreGate";
import { basketDecimals, basketFaucetId, isFpiBasket, isNavBasket } from "../../lib/basketFaucets";
import {
  buildClientDepositNote,
  buildClientRedeemNote,
  compileNavDepositScript,
  compileNavDepositScriptFpi,
  compileNavReadScripts,
  compileNavReadScriptsFpi,
  compileNavRedeemScript,
  compileNavRedeemScriptFpi,
  computeMintAmount,
  computeReleaseAmount,
  PRAGMA_ORACLE_ID,
  PRAGMA_PUBLISHER_ID,
  readFaucetNavBrowser,
  readFaucetNavBrowserFpi,
} from "../../lib/clientNote";
import { liveDccBalance } from "../../lib/dccBalance";
import { autoBackupPara } from "../../lib/paraBackup";

// Private /para: after a settled state change, refresh the encrypted on-chain
// backup so the account is restorable on a new origin. Gated so the public build
// (self-healing) skips it.
const PARA_PRIVATE = process.env.NEXT_PUBLIC_PARA_PRIVATE === "1";

// Decentralization flag: build the confidential deposit note ENTIRELY in the
// browser (compile + build + emit) instead of fetching it from
// /api/confidential-note. Gated so the validated server path stays default until
// the client path is proven E2E against a 0.15.x faucet. When set, DCC buys
// target the test faucet whose allowlist includes the client-compiled root.
// Client-side note-building is the default now (the decentralized path); set
// NEXT_PUBLIC_CLIENT_NOTE=0 to force the legacy server route. Any client-path
// failure falls back to the server build automatically (see onBuy).
const CLIENT_NOTE_BUILD = process.env.NEXT_PUBLIC_CLIENT_NOTE !== "0";
// Fallback faucet if a basket isn't in the table — the 2026-08-05 test faucet,
// which also allowlists the client @note_script root. The client-buy normally
// targets the real basket faucet via basketFaucetId(symbol) (DCC = v20
// 0xc1aa9945…, which allowlists the client root). The client reads live S/V
// on-chain (readFaucetNav) so any deposit predicts the mint felt-exact.
const CLIENT_TEST_FAUCET = "0x6a1410b5a60850d15812b56a0f506d";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A Miden account is SEQUENTIAL — only one transaction can be in flight at a time.
// The optimistic-settle flow runs the payback claim in the BACKGROUND (and it
// survives the modal closing → the panel remounting), so a naive UI would let the
// user start a 2nd trade while the 1st's consume is still pending → the two txs
// conflict in the mempool ("account commitment … does not match" / "vault root …
// does not match") and surface a scary error. We therefore track in-flight
// settlements at MODULE scope (persists across remounts) and block a new trade on
// that account until its previous trade commits. This is the honest constraint, not
// a limitation we can engineer away — one account settles one trade at a time.
const settlingAccounts = new Set<string>();
const settlingListeners = new Set<() => void>();
function markSettling(acct: string, on: boolean) {
  if (on) settlingAccounts.add(acct);
  else settlingAccounts.delete(acct);
  settlingListeners.forEach((l) => l());
}
function useAccountSettling(acct: string | null): boolean {
  return useSyncExternalStore(
    (cb) => {
      settlingListeners.add(cb);
      return () => settlingListeners.delete(cb);
    },
    () => (acct ? settlingAccounts.has(acct) : false),
    () => false,
  );
}

// /para proves on the LOCAL single-threaded prover (no cross-origin isolation
// needed, so Para's auth iframe still loads — see ParaProviders). Local proving
// avoids the remote testnet prover's "DeadlineExceeded" stalls, but keep a small
// retry as a harmless safety net: a retried, never-submitted prove can't
// double-emit, and it still covers the remote path if the prover config flips.
async function withProveRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as { message?: string })?.message ?? e);
      // Retry ONLY the remote prover's pre-submit timeout (gRPC DeadlineExceeded /
      // "Request timed out"). A tx that timed out at PROVE never submitted, so
      // re-emitting the identical server-built note is safe. Do NOT retry generic
      // errors that can occur post-submit — narrower than "any timeout".
      if (!/deadline\s*exceeded|deadline expired|request timed out/i.test(msg)) throw e;
      await sleep(2500 * (i + 1));
    }
  }
  throw lastErr;
}

// A corrupt/stale local IndexedDB (e.g. an earlier failed applyTransaction left the
// account record drifted from the chain) surfaces as these storage/root errors, and
// then EVERY trade fails on apply until the cache is reset. For a PUBLIC account the
// on-chain state is the source of truth, so clearing the local store + reloading
// re-syncs it cleanly — funds are never at risk.
function isStoreCorruptError(msg: string): boolean {
  return /vault root|does not match final account header|storage error|failed to apply transaction|conflicts with current mempool/i.test(
    msg,
  );
}

function prettyErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/deadline|timed\s*out|timeout/i.test(msg)) {
    return "The testnet prover is busy and timed out after a few retries. Wait a moment and try again — your funds are safe.";
  }
  if (isStoreCorruptError(msg)) {
    return "Your local cache is showing a balance the chain hasn't confirmed — a display glitch, not lost funds. Re-sync below to pull your TRUE on-chain balance. Your on-chain funds and notes are untouched (we back up the cache first).";
  }
  return msg;
}

// Re-sync the local store from the chain. Before wiping, snapshot the store so a
// pending PRIVATE note (whose secret lives only locally) can never be permanently
// stranded by a reset — the snapshot is kept in localStorage (survives the wipe)
// and can be re-imported to recover. Best-effort: a failed/oversized backup never
// blocks the re-sync (the account itself is public and re-imports cleanly on reload).
async function resetLocalCache() {
  // NOTE: this used to snapshot the ENTIRE Miden store to localStorage in cleartext
  // (`darwin.para.storeBackup.<id>`) "as a safety copy" before clearing. That blob is the
  // confidential vault/notes, was readable by any same-origin script, and nothing ever
  // read it back — a pure confidentiality leak with no consumer. Removed. Recovery is the
  // on-chain encrypted backup (restorePara), not a plaintext localStorage dump.
  try {
    await clearMidenStorage();
  } catch {
    /* best-effort — reload re-inits the client either way */
  }
  if (typeof window !== "undefined") window.location.reload();
}

type Stage = "idle" | "building" | "emitting" | "claiming" | "settling" | "done" | "pending" | "error";
const BUY_LABEL: Record<Stage, string> = {
  idle: "",
  building: "Building your order…",
  emitting: "Signing the deposit…",
  claiming: "Minting basket shares…",
  settling: "Shares on the way ✓",
  done: "Bought ✓",
  pending: "Awaiting claim",
  error: "",
};
const SELL_LABEL: Record<Stage, string> = {
  idle: "",
  building: "Building your order…",
  emitting: "Signing the sale…",
  claiming: "Releasing dUSDC…",
  settling: "dUSDC on the way ✓",
  done: "Sold ✓",
  pending: "Awaiting claim",
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
  const { exportStore } = useExportStore() as unknown as {
    exportStore: () => Promise<string | Uint8Array>;
  };
  // Compile the confidential note + NAV-read scripts client-side (decentralized
  // note-building). noteScript/txScript (useCompile) do NOT self-lock — we wrap
  // them in runExclusive ourselves.
  const { noteScript, txScript } = useCompile() as unknown as {
    noteScript: (o: {
      code: string;
      libraries?: Array<{ namespace: string; code: string; linking: "static" | "dynamic" }>;
    }) => Promise<{ root: () => { toHex: () => string } }>;
    txScript: (o: {
      code: string;
      libraries?: Array<{ namespace: string; code: string; linking: "static" | "dynamic" }>;
    }) => Promise<unknown>;
  };
  const { execute: executeTx } = useTransaction() as unknown as {
    execute: (o: {
      accountId: string;
      skipSync?: boolean;
      request: () => unknown;
    }) => Promise<{ transactionId?: { toString?: () => string } } | null>;
  };
  // executeProgram (useExecuteProgram) DOES self-lock via runExclusive internally,
  // so it must be called OUTSIDE our runExclusive blocks (nesting the non-reentrant
  // lock would deadlock). Returns the 16-felt stack as bigint[]; stack[0] is top.
  const { execute: executeProgram } = useExecuteProgram() as unknown as {
    execute: (o: {
      accountId: string;
      script: unknown;
      skipSync?: boolean;
    }) => Promise<{ stack: bigint[] }>;
  };

  const [dusdc, setDusdc] = useState<bigint | null>(null);
  const [shares, setShares] = useState<bigint | null>(null);
  const [buyAmount, setBuyAmount] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [buyStage, setBuyStage] = useState<Stage>("idle");
  const [sellStage, setSellStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  // Set when a payback note was minted/released on-chain but the local consume
  // stalled (prover flakiness). Kept so the user can re-claim instead of the
  // funds being stranded with no recovery path (they're on-chain, just unclaimed).
  const [pendingClaim, setPendingClaim] = useState<{ built: BuiltNote; kind: "buy" | "sell" } | null>(null);

  const busyStage = (s: Stage) => s !== "idle" && s !== "done" && s !== "pending" && s !== "error";
  const buyBusy = busyStage(buyStage);
  const sellBusy = busyStage(sellStage);
  // A previous trade on THIS account is still settling on-chain (its background
  // claim hasn't committed). Block new trades until it does — one account, one
  // in-flight tx — else the txs conflict. Persists across the modal close/reopen.
  const accountBusy = useAccountSettling(signerAccountId);
  const otherTradeSettling = accountBusy && !buyBusy && !sellBusy;
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
  // Import + consume the private payback note the NTX builder produced. Idempotent
  // (re-importing an already-known note is a no-op; a consumed note stops matching),
  // so this is also the retry path for a stalled claim. Returns true once consumed.
  async function claimPayback(built: BuiltNote): Promise<boolean> {
    const { NoteFile } = await import("@miden-sdk/miden-sdk");
    const noteFile = NoteFile.deserialize(
      Uint8Array.from(atob(built.paybackFileB64!), (c) => c.charCodeAt(0)),
    );
    try {
      // Under the lock — a raw WASM client call, same double-borrow hazard as the
      // compile if it runs concurrently with the background balance poll.
      await runExclusive(() =>
        (client as { importNoteFile?: (f: unknown) => Promise<string> }).importNoteFile?.(noteFile),
      );
    } catch {
      /* already imported */
    }
    // Detection cadence tuned from MEASURED testnet numbers (probe_blocktime,
    // 2026-08-05): block time ~3.3s, and one full syncState costs ~1.8s (it's a
    // combined NTL + chain sync — the cheapest primitive that also imports the
    // inclusion proof consume() needs, so a lighter tag-filtered RPC probe can't
    // replace it). The payback note commits ~1-2 blocks after the NTB mints it, so
    // a full sync already catches it within a block; the ONLY client-side slack is
    // the poll gap. A 1s sleep (≈2.8s effective cadence incl. the ~1.8s sync)
    // detects the commit within ~1 block instead of the old ~5s gap, without
    // hammering the node. Sync + attempt-consume immediately each round (a consume
    // before the note commits fails cheaply — no proof attempted). ~150 iters ≈
    // 5-7 min budget: the testnet NTB can occasionally lag well past 2 min.
    for (let i = 0; i < 150; i++) {
      try {
        await runExclusive(() => syncState());
      } catch {
        /* transient node replica lag (block_to > chain tip) — retry next round */
      }
      try {
        await withProveRetry(
          () => consume({ accountId: signerAccountId!, notes: [built.paybackId!] }),
          2,
        );
        return true;
      } catch {
        /* not settled yet (note not produced / prover busy) — keep polling */
      }
      await sleep(1000);
    }
    return false;
  }

  // Emit the server-built note (local prove + submit), THEN settle optimistically.
  // Once the emit is submitted the on-chain mint/redeem is GUARANTEED, so we flip
  // to a "settling" success right away and finish the payback claim in the
  // BACKGROUND — the modal is closable and the balance reconciles on its own. This
  // is what makes a trade FEEL ~10s instead of ~40s: the ~30s the network needs
  // (NTB pickup + ~2 blocks + a local consume) no longer blocks the UI. Resolves
  // as soon as the emit lands — it does NOT await the background claim.
  // Private /para: after a settled buy/sell, refresh the encrypted on-chain backup
  // so the account (whose state lives only locally) stays restorable on a new origin.
  // The write goes to the NoAuth controller's slot-10 via txs FROM THE CONTROLLER
  // (set_user_position batches) — the Para account never emits, so ITS nonce stays put
  // and the restored account still matches its on-chain commitment. This depends on the
  // browser being able to build+submit a tx for the imported NoAuth controller, which
  // was broken in the 2026-07 SDK (→ Mac relay) but 0.15.9 enabled FPI / foreign-account
  // reads / network notes that were all "impossible" before — so we re-test it live.
  // Fire-and-forget; a failure just logs (the local account still works this session).
  // Refresh the on-chain backup after the account nonce advanced. Fired on BOTH the
  // settled ("done") AND stalled ("pending") paths: the emit already advanced + committed
  // the on-chain nonce, so a "pending" state is a valid on-chain state that must be
  // backed up too — otherwise leaving at "pending" strands the new state unbacked (a new
  // device would re-derive stale). Retries twice; a de-dupe ref avoids overlapping runs.
  const backupInFlight = useRef(false);
  function backupAfterTrade() {
    if (!PARA_PRIVATE || !client || !signerAccountId) return;
    if (backupInFlight.current) return;
    backupInFlight.current = true;
    const acct = signerAccountId;
    void (async () => {
      try {
        for (let i = 0; i < 2; i++) {
          const r = await autoBackupPara({
            client,
            runExclusive,
            compileTxScript: txScript as (o: { code: string }) => Promise<unknown>,
            executeTx,
            walletId: acct,
          });
          console.log(`[para-backup] ${r.ok ? `ok (${r.nWords} words)` : "failed: " + r.error}`);
          if (r.ok) break;
          await sleep(2000);
        }
      } finally {
        backupInFlight.current = false;
      }
    })();
  }

  async function emitThenSettle(built: BuiltNote, kind: "buy" | "sell", presynced: boolean) {
    const setStage = kind === "buy" ? setBuyStage : setSellStage;
    const clearAmount = kind === "buy" ? setBuyAmount : setSellAmount;
    const acct = signerAccountId!;

    setStage("emitting");
    const { Note, NoteArray } = await import("@miden-sdk/miden-sdk");
    const note = Note.deserialize(Uint8Array.from(atob(built.noteB64!), (c) => c.charCodeAt(0)));
    // Mark the account busy from the emit (it advances the account state); cleared
    // when the background claim commits (finally, below) or if the emit itself
    // fails. Blocks a conflicting 2nd trade even across a modal close/reopen.
    markSettling(acct, true);
    try {
      await withProveRetry(() =>
        executeTx({
          accountId: acct,
          // onBuy/onSell already ran syncState() in parallel with the server note-
          // build, so skip executeTx's own pre-execute sync (~1.8s measured) —
          // unless that parallel sync failed (presynced=false), then let it sync.
          skipSync: presynced,
          request: () => new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note])).build(),
        }),
      );
    } catch (e) {
      markSettling(acct, false); // emit failed → account is not in flight
      throw e;
    }

    // ── OPTIMISTIC POINT ── the deposit/redeem note is on-chain; settlement is now
    // guaranteed. Show success, clear the input, bump the header — the user can
    // walk away. The payback claim below runs WITHOUT blocking the UI.
    setStage("settling");
    clearAmount("");
    onDone?.();

    // Background: wait for the NTB to produce the payback note, consume it locally,
    // then flip to done + refresh the real balance. If it stalls, the funds are on
    // -chain (just unclaimed) — surface the Retry path; nothing is lost.
    void claimPayback(built)
      .then((claimed) => {
        if (claimed) {
          setStage("done");
          void refresh();
          onDone?.();
        } else {
          setPendingClaim({ built, kind });
          setStage("pending");
        }
      })
      .catch((e) => {
        console.warn("[basket-trade] background claim failed", e);
        setPendingClaim({ built, kind });
        setStage("pending");
      })
      .finally(() => {
        markSettling(acct, false); // account free once the claim commits
        // Back up regardless of done/pending: the emit already advanced + committed the
        // on-chain nonce, so both are valid on-chain states worth preserving.
        backupAfterTrade();
      });
  }

  // Re-run a stalled claim (payback already emitted on-chain — just re-consume).
  async function retryClaim() {
    if (!pendingClaim || !signerAccountId || !client) return;
    const { built, kind } = pendingClaim;
    const setStage = kind === "buy" ? setBuyStage : setSellStage;
    setError(null);
    setStage("claiming");
    try {
      const ok = await claimPayback(built);
      if (ok) {
        setPendingClaim(null);
        setStage("done");
        await refresh();
        onDone?.();
        backupAfterTrade();
      } else {
        setStage("pending");
      }
    } catch (e) {
      setError(prettyErr(e));
      setStage("pending");
    }
  }

  async function onBuy() {
    if (!signerAccountId || !client) return;
    setError(null);
    const acct = signerAccountId;
    try {
      // Block a concurrent trade on the same sequential account: the Sell button is
      // visible while a Buy is still BUILDING (10-30s for FPI), and two emits on one
      // account collide on the nonce. Guard at entry and hold the flag across the build.
      if (settlingAccounts.has(acct)) {
        throw new Error("A trade is already in progress on this account — please wait.");
      }
      // Don't emit against an un-restored/failed private account (a fresh-origin restore
      // may still be in flight, or it errored). awaitRestore returns fast once resolved.
      if (PARA_PRIVATE) {
        const rs = await awaitRestore(acct);
        if (rs === "failed") {
          throw new Error("Couldn't restore your account state — reload the page before trading.");
        }
      }
      markSettling(acct, true);
      // Fresh-store self-heal (new origin / cleared storage) — re-import the
      // deterministic public account before the emit touches it, else executeTx/
      // consume throw "account data wasn't found". No-op once tracked.
      await ensureSignerAccountLoaded(client, runExclusive, acct);
      // dUSDC is 6-dec; the note carries dUSDC base units drained from the vault.
      let amountBase = parseUnits(buyAmount || "0", EPOCH_USDC_SEPOLIA.midenDecimals);
      if (dusdc != null && amountBase > dusdc) amountBase = dusdc; // never over-spend
      if (amountBase <= 0n) throw new Error("Enter an amount to buy.");

      setBuyStage("building");
      let built: BuiltNote | undefined;
      let presynced = false;

      // The proven server note-build — used when the client path is disabled, and
      // as the automatic fallback if client-side building throws.
      const buildViaServer = async (): Promise<BuiltNote> => {
        // Overlap the pre-emit sync with the server note-build: both take ~2s, so
        // running them together lets the emit skip its own ~1.8s sync (skipSync).
        const [r, ps] = await Promise.all([
          fetch("/api/confidential-note", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sender: signerAccountId,
              recipient: signerAccountId,
              basket: symbol,
              amount: amountBase.toString(),
            }),
          }),
          runExclusive(() => syncState())
            .then(() => true)
            .catch(() => false),
        ]);
        presynced = ps;
        const server = (await r.json()) as BuiltNote;
        if (!r.ok || !server.noteB64 || !server.paybackFileB64 || !server.paybackId) {
          throw new Error(server.error ?? `confidential-note API ${r.status}`);
        }
        return server;
      };

      // The client build is NAV-specific (its note scripts + on-chain compute_v read
      // only exist on NAV faucets). Legacy 1:1 baskets (DAG/DCO) have no compute_v →
      // executeProgram throws push_procedure_index — so those go straight to the
      // server build. Gate the client path on isNavBasket.
      if (CLIENT_NOTE_BUILD && isNavBasket(symbol)) {
        // Decentralized path: compile + build the confidential note IN THE BROWSER
        // (no /api/confidential-note). Reads the faucet's LIVE S/V on-chain so the
        // predicted mint = net*S/V matches what the network settles (the payback
        // P2ID must reconstruct to the exact minted amount to be consumable). All
        // WASM/store ops run under one runExclusive lock; presynced so the emit
        // skips its own sync. Any failure falls back to the proven server build.
        try {
          const clientFaucet = basketFaucetId(symbol) ?? CLIENT_TEST_FAUCET;
          // Split by lock discipline (both compilers and executeProgram touch the
          // same WASM client, so they can never run concurrently — a concurrent
          // borrow panics an internal RefCell and hangs forever):
          //  · compile (noteScript/txScript) does NOT self-lock → wrap in runExclusive
          //    so the background "keep cash live" sync can't race it.
          //  · executeProgram DOES self-lock (its own runExclusive) → call it OUTSIDE
          //    ours; nesting the non-reentrant lock would deadlock.
          const fpi = isFpiBasket(symbol);
          const prep = await runExclusive(async () => {
            await syncState();
            return {
              navScript: await (fpi
                ? compileNavDepositScriptFpi(noteScript)
                : compileNavDepositScript(noteScript)),
              navRead: await (fpi
                ? compileNavReadScriptsFpi(txScript)
                : compileNavReadScripts(txScript)),
            };
          });
          // Import the faucet's public state (flat web-client import, under the lock).
          await ensureSignerAccountLoaded(client, runExclusive, clientFaucet);
          // FPI faucet: compute_v is priced ON-CHAIN via Pragma (execute_foreign_
          // procedure). The read reproduces the note's exact load_prices + compute_v
          // sequence with the Pragma oracle supplied as a foreign account, so V — and
          // thus mint = net*S/V — is felt-exact at ANY S, matching whatever the on-chain
          // note settles against. Pragma's public state must be importable for the
          // local FPI read, so import it first (no-op once tracked).
          if (fpi) {
            await ensureSignerAccountLoaded(client, runExclusive, PRAGMA_ORACLE_ID);
            await ensureSignerAccountLoaded(client, runExclusive, PRAGMA_PUBLISHER_ID);
            // Warm the just-imported oracle + publisher on a COLD store (fresh
            // private account): read_pragma.rs sync_states after importing, before
            // execute_program. Without it, the foreign-account get_median can't
            // resolve the publisher's entries and the FPI read faults.
            await runExclusive(() => syncState());
          }
          // FPI read with retry: the Pragma publisher's price ENTRIES (a storage map)
          // sync a beat AFTER its account header on a COLD store, so the first read
          // asserts "pragma <pair> not tracked". Re-sync + retry a few times rather than
          // fall through to the server build — the server misprices FPI (it values V via
          // CoinGecko, not the on-chain Pragma feed the note settles against), so its
          // payback prediction is unconsumable and the claim hangs forever. A client
          // read that eventually resolves is the only correct price for an FPI basket.
          const readFpiNav = async () => {
            let lastErr: unknown;
            for (let i = 0; i < 8; i++) {
              try {
                return await readFaucetNavBrowserFpi(executeProgram, clientFaucet, prep.navRead);
              } catch (e) {
                lastErr = e;
                // Re-sync so the publisher's price entries can land. resilientSync retries
                // through transient replica lag ("block_to > chain tip") internally, so a
                // lagging node no longer aborts the read — the next round hits a caught-up
                // replica once the sync succeeds.
                await resilientSync(runExclusive, syncState);
                await sleep(1500);
              }
            }
            throw lastErr;
          };
          const nav = fpi
            ? await readFpiNav()
            : await readFaucetNavBrowser(executeProgram, clientFaucet, prep.navRead);
          // SECURITY / FUND-SAFETY — DEFERRED (needs an on-chain note change): mintAmount
          // is predicted from S/V read NOW, and baked as a FIXED amount into the payback
          // P2ID that claimPayback matches by id. The on-chain note re-reads LIVE Pragma
          // + supply ~30s later, so if the price/supply moves in that window the network
          // mints a different amount into a payback with a different id → unmatchable →
          // stranded. Durable fix: the note must mint the note-carried amount (bound by
          // collateral) instead of recomputing at settlement, OR the payback must be
          // consumable by tag/recipient rather than a fixed-amount id. Tracked.
          const mintAmount = computeMintAmount(amountBase, nav.supply, nav.vaultValue);
          built = await buildClientDepositNote(prep.navScript, {
            faucet: clientFaucet,
            sender: signerAccountId,
            recipient: signerAccountId,
            dusdcFaucet: EPOCH_USDC_SEPOLIA.midenFaucetId,
            amount: amountBase,
            mintAmount,
          });
          presynced = false; // let the emit re-sync (state may have moved during the read)
        } catch (e) {
          console.warn("[client-buy] client note-build failed", e);
          built = undefined;
        }
      }
      if (!built) {
        // NEVER fall back to the server build for an FPI basket: the server prices V via
        // CoinGecko, not the on-chain Pragma feed the note settles against, so its mint
        // prediction (and thus the payback P2ID it returns) can't be consumed — the claim
        // hangs forever and the spent dUSDC is stranded. Surface a retry instead; the
        // client read only needs the node + Pragma publisher to finish syncing.
        if (isFpiBasket(symbol)) {
          throw new Error(
            "Live prices are still syncing (testnet node catching up) — please try again in a moment.",
          );
        }
        built = await buildViaServer();
      }
      // Returns once the deposit is emitted on-chain; the mint + claim then settle
      // in the background (see emitThenSettle).
      await emitThenSettle(built, "buy", presynced);
    } catch (e) {
      // Clear the entry guard on any PRE-background error (build failed, gate, price
      // sync). On success, emitThenSettle owns the flag and clears it when the
      // background claim commits, so this only fires when nothing was handed off.
      markSettling(acct, false);
      setError(prettyErr(e));
      setBuyStage("error");
    }
  }

  async function onSell() {
    if (!signerAccountId || !client) return;
    setError(null);
    const acct = signerAccountId;
    try {
      if (settlingAccounts.has(acct)) {
        throw new Error("A trade is already in progress on this account — please wait.");
      }
      if (PARA_PRIVATE) {
        const rs = await awaitRestore(acct);
        if (rs === "failed") {
          throw new Error("Couldn't restore your account state — reload the page before trading.");
        }
      }
      markSettling(acct, true);
      // Fresh-store self-heal — see onBuy. Import the account before the redeem
      // emit touches it.
      await ensureSignerAccountLoaded(client, runExclusive, signerAccountId);
      // Shares are basketDecimals-dec; the redeem note carries the shares to burn.
      let sharesBase = parseUnits(sellAmount || "0", shareDecimals);
      if (shares != null && sharesBase > shares) sharesBase = shares; // never over-sell
      if (sharesBase <= 0n) throw new Error("Enter an amount of shares to sell.");

      setSellStage("building");
      let built: BuiltNote | undefined;
      let presynced = false;

      // The proven server redeem — used when the client path is off, and the
      // automatic fallback if client-side building throws.
      const redeemViaServer = async (): Promise<BuiltNote> => {
        const [r, ps] = await Promise.all([
          fetch("/api/confidential-redeem", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sender: signerAccountId,
              recipient: signerAccountId,
              basket: symbol,
              amount: sharesBase.toString(),
            }),
          }),
          runExclusive(() => syncState())
            .then(() => true)
            .catch(() => false),
        ]);
        presynced = ps;
        const server = (await r.json()) as BuiltNote;
        if (!r.ok || !server.noteB64 || !server.paybackFileB64 || !server.paybackId) {
          throw new Error(server.error ?? `confidential-redeem API ${r.status}`);
        }
        return server;
      };

      // The client build is NAV-specific (its note scripts + on-chain compute_v read
      // only exist on NAV faucets). Legacy 1:1 baskets (DAG/DCO) have no compute_v →
      // executeProgram throws push_procedure_index — so those go straight to the
      // server build. Gate the client path on isNavBasket.
      if (CLIENT_NOTE_BUILD && isNavBasket(symbol)) {
        // Decentralized redeem: build the burn note IN THE BROWSER (no
        // /api/confidential-redeem). Reads live S/V so the released dUSDC =
        // shares*V/S/100 matches what the network settles (the payback must
        // reconstruct at the exact released amount). Falls back to the server
        // build on any error.
        try {
          const clientFaucet = basketFaucetId(symbol) ?? CLIENT_TEST_FAUCET;
          // Compile under the lock; executeProgram outside it (self-locks). Same
          // lock discipline as onBuy — see the detailed note there.
          const fpi = isFpiBasket(symbol);
          const prep = await runExclusive(async () => {
            await syncState();
            return {
              redeemScript: await (fpi
                ? compileNavRedeemScriptFpi(noteScript)
                : compileNavRedeemScript(noteScript)),
              navRead: await (fpi
                ? compileNavReadScriptsFpi(txScript)
                : compileNavReadScripts(txScript)),
            };
          });
          await ensureSignerAccountLoaded(client, runExclusive, clientFaucet);
          // FPI: read V via the exact load_prices + compute_v sequence with Pragma
          // supplied as a foreign account, so release = shares*V/S/100 is felt-exact
          // (see onBuy for the full rationale). Import Pragma's state first.
          if (fpi) {
            await ensureSignerAccountLoaded(client, runExclusive, PRAGMA_ORACLE_ID);
            await ensureSignerAccountLoaded(client, runExclusive, PRAGMA_PUBLISHER_ID);
            // Warm the just-imported oracle + publisher on a COLD store (fresh
            // private account): read_pragma.rs sync_states after importing, before
            // execute_program. Without it, the foreign-account get_median can't
            // resolve the publisher's entries and the FPI read faults.
            await runExclusive(() => syncState());
          }
          // FPI read with retry: the Pragma publisher's price ENTRIES (a storage map)
          // sync a beat AFTER its account header on a COLD store, so the first read
          // asserts "pragma <pair> not tracked". Re-sync + retry a few times rather than
          // fall through to the server build — the server misprices FPI (it values V via
          // CoinGecko, not the on-chain Pragma feed the note settles against), so its
          // payback prediction is unconsumable and the claim hangs forever. A client
          // read that eventually resolves is the only correct price for an FPI basket.
          const readFpiNav = async () => {
            let lastErr: unknown;
            for (let i = 0; i < 8; i++) {
              try {
                return await readFaucetNavBrowserFpi(executeProgram, clientFaucet, prep.navRead);
              } catch (e) {
                lastErr = e;
                // Re-sync so the publisher's price entries can land. resilientSync retries
                // through transient replica lag ("block_to > chain tip") internally, so a
                // lagging node no longer aborts the read — the next round hits a caught-up
                // replica once the sync succeeds.
                await resilientSync(runExclusive, syncState);
                await sleep(1500);
              }
            }
            throw lastErr;
          };
          const nav = fpi
            ? await readFpiNav()
            : await readFaucetNavBrowser(executeProgram, clientFaucet, prep.navRead);
          const release = computeReleaseAmount(sharesBase, nav.supply, nav.vaultValue);
          built = await buildClientRedeemNote(prep.redeemScript, {
            faucet: clientFaucet,
            redeemer: signerAccountId,
            dusdcFaucet: EPOCH_USDC_SEPOLIA.midenFaucetId,
            shares: sharesBase,
            release,
          });
          presynced = false;
        } catch (e) {
          console.warn("[client-sell] client note-build failed", e);
          built = undefined;
        }
      }
      if (!built) {
        // FPI: no server fallback — it misprices V (CoinGecko vs on-chain Pragma), so the
        // released dUSDC / payback can't reconcile and the claim hangs. Retry instead.
        if (isFpiBasket(symbol)) {
          throw new Error(
            "Live prices are still syncing (testnet node catching up) — please try again in a moment.",
          );
        }
        built = await redeemViaServer();
      }
      // Returns once the redeem note is emitted on-chain; the burn + dUSDC release
      // then settle in the background (see emitThenSettle).
      await emitThenSettle(built, "sell", presynced);
    } catch (e) {
      markSettling(acct, false); // clear the entry guard on any pre-background error
      setError(prettyErr(e));
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
        disabled={buyBusy || otherTradeSettling || noFunds || !buyAmount || buyNum <= 0 || buyOver}
        className="nav-cta"
        style={{
          ...sty.fullBtn,
          opacity: buyBusy || otherTradeSettling || noFunds || !buyAmount || buyNum <= 0 || buyOver ? 0.5 : 1,
        }}
      >
        {buyBusy ? BUY_LABEL[buyStage] : otherTradeSettling ? "Previous trade settling…" : `Buy ${symbol}`}
      </button>
      {otherTradeSettling && (
        <p style={sty.hint}>
          Your previous trade is still settling on-chain — a Miden account settles one trade at a time. This unlocks
          automatically in a moment.
        </p>
      )}
      {buyStage === "claiming" && <p style={sty.hint}>The network is minting your shares — up to a minute.</p>}
      {buyStage === "settling" && (
        <p style={sty.settleMsg}>
          Shares on the way ✓ — settling on-chain (~30s). Your balance updates automatically; you can close this
          window.
        </p>
      )}
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
            disabled={sellBusy || otherTradeSettling || !sellAmount || sellNum <= 0 || sellOver}
            className="nav-cta"
            style={{
              ...sty.fullBtn,
              opacity: sellBusy || otherTradeSettling || !sellAmount || sellNum <= 0 || sellOver ? 0.5 : 1,
            }}
          >
            {sellBusy ? SELL_LABEL[sellStage] : otherTradeSettling ? "Previous trade settling…" : `Sell ${symbol}`}
          </button>
          {sellStage === "claiming" && <p style={sty.hint}>The network is releasing your dUSDC — up to a minute.</p>}
          {sellStage === "settling" && (
            <p style={sty.settleMsg}>
              dUSDC on the way ✓ — settling on-chain (~30s). Your balance updates automatically; you can close this
              window.
            </p>
          )}
          {sellStage === "done" && <p style={sty.doneMsg}>Sold ✓ — dUSDC is back in your account.</p>}
        </div>
      )}

      {pendingClaim && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
          {/* Honest copy: for an FPI basket the payback is a fixed-amount private note the
              client pre-built at its price read; if the live Pragma price (or supply)
              moved before the network settled, the minted amount differs and this claim
              can't reconcile by retrying. Don't promise "nothing is lost" unconditionally.
              The durable fix is on-chain (the note carrying the client-computed amount, or
              a recallable/public payback) — flagged separately. */}
          <p style={sty.hint}>
            Your {pendingClaim.kind === "buy" ? "shares were minted" : "dUSDC was released"} on-chain and we&apos;re
            claiming them into your account. Retry below. If the price moved while it settled the claim may not
            reconcile automatically — if retries keep failing, your funds are on-chain and recoverable, reach out.
          </p>
          <button
            type="button"
            onClick={retryClaim}
            disabled={buyBusy || sellBusy}
            className="nav-cta"
            style={{ ...sty.fullBtn, opacity: buyBusy || sellBusy ? 0.5 : 1 }}
          >
            {buyBusy || sellBusy ? "Claiming…" : "Retry claim"}
          </button>
        </div>
      )}

      {error && (
        <>
          <p style={sty.errMsg}>{error}</p>
          {error.includes("TRUE on-chain balance") && (
            <button
              type="button"
              onClick={() => resetLocalCache()}
              className="nav-cta"
              style={{ ...sty.fullBtn, marginTop: 8 }}
            >
              Re-sync from chain
            </button>
          )}
        </>
      )}
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
  // Optimistic "settling" state — positive but in-flight, so a calm blue rather
  // than the final green of doneMsg.
  settleMsg: {
    marginTop: 12,
    borderRadius: 8,
    border: "1px solid rgba(59,130,246,0.4)",
    background: "rgba(59,130,246,0.10)",
    padding: "8px 12px",
    fontSize: 13,
    color: "#1d4ed8",
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
