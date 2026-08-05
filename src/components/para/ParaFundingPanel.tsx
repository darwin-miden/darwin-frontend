"use client";

/**
 * Funding for the Para-managed Miden account.
 *
 * All-Para design: identity = Para (the Miden account comes from Para's embedded
 * wallet), funding = the user's OWN MetaMask/Rabby as the Sepolia SOURCE, bridged
 * to the Para Miden account via Epoch. Same Epoch machinery as
 * TrustlessDepositPanel; the ONLY difference is the recipient:
 * `midenRecipientId` = the Para account id (useMiden().signerAccountId).
 *
 * IMPORTANT — why we talk to `window.ethereum` directly instead of wagmi's
 * useAccount(): Para registers its EMBEDDED wallet into the wagmi context, so
 * `useAccount()` here would report the Para embedded EVM address (which holds no
 * Sepolia USDC), not the user's real MetaMask/Rabby. `window.ethereum` is the
 * injected browser extension (Para doesn't set it), so it's the user's actual
 * wallet — the one holding the Sepolia USDC to bridge.
 *
 * Flow: connect MetaMask/Rabby → type amount → Fund → the wallet signs the
 * ERC-20 approve + Compact deposit on Sepolia → Epoch delivers dUSDC as a note
 * to the Para account → we sync + consume it → spendable dUSDC balance.
 */

import {
  useConsume,
  useMiden,
  useSend,
  useSyncState,
  useWaitForCommit,
  useWaitForNotes,
} from "@miden-sdk/react";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, formatUnits, http, parseUnits } from "viem";
import { sepolia } from "viem/chains";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";

import {
  ALLOCATOR_URL,
  applySlippageBps,
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
  EPOCH_USDC_SEPOLIA,
  MIDEN_DESTINATION_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  dusdcMidenBaseUnits,
  extractNonce,
  fetchQuote,
  fetchRedeemQuote,
  submitIntent,
  submitRedeemIntent,
  usdcSepoliaBaseUnits,
} from "../../lib/epoch";
import { ensureSignerAccountLoaded } from "../../lib/ensureAccount";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEPOLIA_HEX = "0xaa36a7"; // 11155111

// Retry a prove-gated call across the flaky testnet remote prover's transient
// timeouts (gRPC DeadlineExceeded / "Failed to fetch" / "Request timed out").
// Re-running the same consume is safe — a consumed note can't be re-consumed.
async function withProveRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as { message?: string })?.message ?? e);
      if (!/deadline\s*exceeded|deadline expired|request timed out|failed to fetch/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw lastErr;
}

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
function getEth(): Eth | null {
  const eth = (window as unknown as { ethereum?: Eth }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

// Warm the wallet's Sepolia native balance so the approval popup opens with gas
// already loaded (no "Gas balance not enough" right after switching chains).
async function warmWalletGas(eth: Eth, evmAddress: string): Promise<void> {
  try {
    for (let i = 0; i < 8; i++) {
      try {
        const bal = (await eth.request({ method: "eth_getBalance", params: [evmAddress, "latest"] })) as string;
        if (bal && BigInt(bal) > 0n) return;
      } catch {
        /* provider mid-switch — retry */
      }
      await sleep(400);
    }
  } catch {
    /* best-effort */
  }
}

async function switchToSepolia(eth: Eth): Promise<void> {
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_HEX }] });
  } catch (e) {
    // 4902 = chain not added to the wallet → add it, then it's selected.
    if ((e as { code?: number })?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: SEPOLIA_HEX,
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    }
    // Any other error: the wallet may already be on Sepolia; let the tx proceed.
  }
}

type Stage =
  | "idle"
  | "switching"
  | "quoting"
  | "signing"
  | "bridging"
  | "receiving"
  | "consuming"
  | "done"
  | "error";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "",
  switching: "Switching to Sepolia…",
  quoting: "Getting a quote from Epoch…",
  signing: "Approve + deposit in your wallet…",
  bridging: "Bridging to Miden…",
  receiving: "Waiting for the dUSDC note…",
  consuming: "Claiming your dUSDC…",
  done: "Funded ✓",
  error: "",
};

type WStage = "idle" | "quoting" | "signing-note" | "awaiting-fill" | "done" | "pending" | "error";

const WSTAGE_LABEL: Record<WStage, string> = {
  idle: "",
  quoting: "Getting a redeem quote…",
  "signing-note": "Sign the payout note in Para…",
  "awaiting-fill": "Epoch is paying out on Sepolia…",
  done: "Withdrawn ✓",
  pending: "Still settling…",
  error: "",
};

export function ParaFundingPanel() {
  const { client, runExclusive, signerAccountId, isReady } = useMiden() as unknown as {
    client: unknown;
    runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>;
    signerAccountId: string | null;
    isReady: boolean;
  };
  const { consume } = useConsume();
  const { sync: syncState } = useSyncState();
  const { waitForConsumableNotes } = useWaitForNotes();
  const { send: sendNote } = useSend() as unknown as {
    send: (a: {
      from: string;
      to: string;
      assetId: string;
      amount: bigint;
      noteType: string;
      returnNote: boolean;
    }) => Promise<{ txId?: string; note?: { id?: () => { toString?: () => string } } }>;
  };
  const { waitForCommit } = useWaitForCommit() as unknown as {
    waitForCommit: (txId: string, opts?: { timeoutMs?: number; intervalMs?: number }) => Promise<unknown>;
  };

  const [evmAddress, setEvmAddress] = useState<`0x${string}` | null>(null);
  const [amount, setAmount] = useState("1");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dusdc, setDusdc] = useState<bigint | null>(null);
  const [sepoliaUsdc, setSepoliaUsdc] = useState<bigint | null>(null);
  const [wAmount, setWAmount] = useState("1");
  const [wStage, setWStage] = useState<WStage>("idle");

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";
  const wBusy = wStage !== "idle" && wStage !== "done" && wStage !== "pending" && wStage !== "error";

  const refreshBalance = useCallback(
    async (retries = 3) => {
      if (!client || !signerAccountId) return;
      const { AccountId } = await import("@miden-sdk/miden-sdk");
      const dusdcFaucet = AccountId.fromHex(EPOCH_USDC_SEPOLIA.midenFaucetId);
      for (let i = 0; i < retries; i++) {
        // Sync BEFORE reading — a getAccount without a fresh sync returns the
        // last-known (often stale/zero) state, so a funded account can read 0.
        try {
          await runExclusive(() => syncState());
        } catch {
          /* sync mid-flight — read anyway */
        }
        try {
          const acc = (await runExclusive(() =>
            (client as { getAccount: (id: unknown) => Promise<unknown> }).getAccount(
              AccountId.fromHex(signerAccountId),
            ),
          )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
          const bal = acc ? BigInt(acc.vault().getBalance(dusdcFaucet) ?? 0n) : 0n;
          setDusdc(bal);
          if (bal > 0n) return;
        } catch {
          /* vault not synced yet — retry */
        }
        await sleep(2000);
      }
    },
    [client, signerAccountId, runExclusive, syncState],
  );

  useEffect(() => {
    if (isReady && signerAccountId) refreshBalance(3);
  }, [isReady, signerAccountId, refreshBalance]);

  // Read the wallet's Sepolia USDC balance (ERC-20 balanceOf) via the injected
  // provider. eth_call runs on the wallet's SELECTED chain, so switch to Sepolia
  // first — the balance is meaningless read against mainnet. Best-effort.
  const readSepoliaUsdc = useCallback(async (addr: `0x${string}`): Promise<bigint | null> => {
    const eth = getEth();
    if (!eth) return null;
    try {
      await switchToSepolia(eth);
      const data = ("0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;
      const res = (await eth.request({
        method: "eth_call",
        params: [{ to: EPOCH_USDC_SEPOLIA.address, data }, "latest"],
      })) as string;
      const bal = res && res !== "0x" ? BigInt(res) : 0n;
      setSepoliaUsdc(bal);
      return bal;
    } catch {
      /* balance read best-effort — the user can still type an amount */
      return null;
    }
  }, []);

  async function onMaxFund() {
    if (!evmAddress) return;
    const bal = sepoliaUsdc ?? (await readSepoliaUsdc(evmAddress));
    if (bal != null) setAmount(formatUnits(bal, EPOCH_USDC_SEPOLIA.decimals));
  }

  async function connectEvm() {
    setError(null);
    const eth = getEth();
    if (!eth) {
      setError("No injected wallet found. Install MetaMask or Rabby.");
      return;
    }
    try {
      const accs = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (accs?.[0]) {
        setEvmAddress(accs[0] as `0x${string}`);
        void readSepoliaUsdc(accs[0] as `0x${string}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onFund() {
    if (!signerAccountId || !evmAddress || !client) return;
    const eth = getEth();
    if (!eth) {
      setError("No injected wallet found. Install MetaMask or Rabby.");
      return;
    }
    setError(null);
    try {
      setStage("switching");
      await switchToSepolia(eth);
      await warmWalletGas(eth, evmAddress);

      const walletClient = createWalletClient({
        account: evmAddress,
        chain: sepolia,
        transport: custom(eth as never),
      });
      const sdk = new EpochIntentSDK({ apiBaseUrl: ALLOCATOR_URL, walletClient });

      const tokenInAmount = parseUnits(amount, EPOCH_USDC_SEPOLIA.decimals).toString();
      const minTokenOut = applySlippageBps(dusdcMidenBaseUnits(amount), 1000);

      setStage("quoting");
      const quote = await fetchQuote(sdk, {
        evmSourceAddress: evmAddress,
        midenRecipientId: signerAccountId,
        tokenInAmount,
        minTokenOut,
      });

      setStage("signing");
      // solveIntent signs + broadcasts the approve + Compact deposit on Sepolia,
      // then viem waits for the deposit's confirmation — which can TIME OUT on a
      // slow/flaky Sepolia RPC even though the tx mines fine (verified live: these
      // deposits land, status 0x1). Treat THAT specific confirmation timeout as
      // "submitted": the USDC is on its way + Epoch will see the deposit, so fall
      // through to the note-claim below (it finds the delivery by account, no nonce
      // needed) instead of erroring on a deposit that actually succeeded. Anything
      // else is a real signing/deposit failure — rethrow.
      let submit: unknown = null;
      try {
        submit = await submitIntent(sdk, quote);
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? e);
        if (!/timed out while waiting for transaction|to be confirmed|waitfortransactionreceipt/i.test(msg)) throw e;
        console.warn("[para-fund] deposit confirmation timed out (tx likely mined) — continuing to claim", e);
      }
      const intentNonce = submit ? extractNonce(submit) : undefined;

      setStage("bridging");
      let epochNoteId: string | null = null;
      if (intentNonce) {
        const url = `${ALLOCATOR_URL}/intentStatus/${encodeURIComponent(evmAddress)}/${encodeURIComponent(intentNonce)}`;
        const start = Date.now();
        while (Date.now() - start < 120_000) {
          try {
            const r = await fetch(url).then((res) => res.json());
            if (Array.isArray(r) && r[0]) {
              if (r[0].status === "success") {
                epochNoteId = r[0].midenNoteId ?? null;
                break;
              }
              if (r[0].status === "failed") {
                throw new Error(`Epoch reported failed: ${JSON.stringify(r[0]).slice(0, 150)}`);
              }
            }
          } catch (e) {
            if (String(e).includes("Epoch reported failed")) throw e;
          }
          await sleep(5000);
        }
      }

      // Wait for + consume Epoch's delivered dUSDC note AUTOMATICALLY, right here
      // in the deposit flow — the user must NEVER run a second action to see their
      // dUSDC. Epoch's solver fills async (the note lands a bit after the intent
      // reports success) and the remote prover is intermittently flaky, so we keep
      // syncing + retrying the consume (prove-retry) under a generous 6-minute
      // deadline until THIS deposit's note is consumed into the vault. Any other
      // consumable notes (e.g. an earlier delivery whose consume had stalled) are
      // swept opportunistically in the same pass, so a stall never strands dUSDC.
      setStage("receiving");
      // Fresh-store self-heal: on a new origin (the Vercel app vs the Mac) the
      // deterministic public account may not be in this browser's store yet, so
      // consume would throw "account data wasn't found". Re-import it from chain
      // before claiming. No-op once tracked. See lib/ensureAccount.ts.
      await ensureSignerAccountLoaded(client, runExclusive, signerAccountId);
      const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
      const wantId = epochNoteId ? norm(epochNoteId as string) : null;
      const claimDeadline = Date.now() + 6 * 60_000;
      let claimed = false;
      let sawNote = false;
      while (Date.now() < claimDeadline && !claimed) {
        try {
          await runExclusive(() => syncState());
        } catch {
          /* mid-sync — retry next tick */
        }
        let inboundIds: string[] = [];
        try {
          const notes = (await waitForConsumableNotes({
            accountId: signerAccountId,
            minCount: 1,
            timeoutMs: 20_000,
            intervalMs: 5_000,
          })) as
            | Array<{ inputNoteRecord?: () => { id?: () => { toString?: () => string } } | null }>
            | undefined;
          inboundIds = (notes ?? [])
            .map((n) => n.inputNoteRecord?.()?.id?.()?.toString?.() ?? "")
            .filter(Boolean);
        } catch {
          inboundIds = [];
        }
        if (inboundIds.length) sawNote = true;
        // Consume THIS deposit's note first, then sweep any other inbound notes.
        // Stray tag-colliding P2ID notes (right tag, wrong target) just throw
        // "target account … do not match" — caught + skipped, harmless.
        const ordered = wantId
          ? [
              ...inboundIds.filter((id) => norm(id) === wantId),
              ...inboundIds.filter((id) => norm(id) !== wantId),
            ]
          : inboundIds;
        setStage("consuming");
        for (const id of ordered) {
          try {
            await withProveRetry(() => consume({ accountId: signerAccountId, notes: [id] }));
            // A successful consume IS the real delivery — stray tag-colliding P2ID
            // notes (right tag, wrong target) throw "target … do not match", so once
            // one consumes we stop and never poke the strays (keeps the console clean).
            claimed = true;
            break;
          } catch (e) {
            console.warn("[para-fund] consume skipped (stray note or prover busy)", id, e);
          }
        }
        if (!claimed) {
          setStage("receiving");
          await sleep(5000);
        }
      }
      if (!claimed) {
        throw new Error(
          sawNote
            ? "Your dUSDC was delivered on-chain but the testnet prover kept stalling — reopen Deposit and it finishes claiming automatically, nothing is lost."
            : "Epoch hasn't delivered the note to your account yet — reopen Deposit in a moment; your funds are safe.",
        );
      }

      setStage("done");
      setAmount(""); // clear the funded amount so it doesn't linger for the next fund
      if (evmAddress) void readSepoliaUsdc(evmAddress); // Sepolia balance dropped
      await refreshBalance(6);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  // Withdraw: the mirror of Fund. From the Para Miden account → USDC back to the
  // user's Sepolia address, via Epoch's redeem. The user signs NO Sepolia tx —
  // they create a P2IDE note on Miden (signed by Para) targeting Epoch's
  // allocator; the solver consumes it and pays USDC on Sepolia.
  async function onWithdraw() {
    if (!signerAccountId || !evmAddress || !client) return;
    setError(null);
    try {
      setWStage("quoting");
      // A walletClient carrying the Miden virtual chain id (no Sepolia tx is
      // signed here — http() transport is only the SDK's sponsor context).
      const sepoliaWC = createWalletClient({ account: evmAddress, chain: sepolia, transport: http() });
      const midenWC = {
        ...sepoliaWC,
        chain: { ...sepoliaWC.chain, id: MIDEN_DESTINATION_CHAIN_ID },
      } as never;
      const sdk = new EpochIntentSDK({ apiBaseUrl: ALLOCATOR_URL, walletClient: midenWC });

      const minSepoliaOut = applySlippageBps(usdcSepoliaBaseUnits(wAmount), EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS);
      const quote = await fetchRedeemQuote(sdk, {
        midenSourceId: signerAccountId,
        evmRecipient: evmAddress,
        minUsdcSepoliaBaseUnits: minSepoliaOut,
      });

      setWStage("signing-note");
      const submit = await submitRedeemIntent(sdk, quote, async (faucetId, amountBase, allocatorId) => {
        try {
          // Never send more dUSDC than the vault holds — the reverse quote can
          // ask for a hair more than the balance (rate/rounding), which
          // underflows the vault ("subtracting X from Y would underflow").
          let sendAmount = BigInt(amountBase);
          if (dusdc != null && sendAmount > dusdc) sendAmount = dusdc;
          const out = await sendNote({
            from: signerAccountId,
            to: allocatorId,
            assetId: faucetId,
            amount: sendAmount,
            noteType: "public",
            returnNote: true,
          });
          if (out?.txId) {
            try {
              await waitForCommit(out.txId, { timeoutMs: 120_000, intervalMs: 4_000 });
            } catch {
              /* the SDK still polls the fill; commit-wait is best-effort */
            }
          }
          const noteId = out?.note?.id?.()?.toString?.();
          return { success: true, noteId };
        } catch (e) {
          console.warn("[para-withdraw] sendNote failed", e);
          return { success: false };
        }
      });

      const nonce = extractNonce(submit);
      setWStage("awaiting-fill");
      let filled = false;
      if (nonce) {
        const url = `${ALLOCATOR_URL}/intentStatus/${encodeURIComponent(evmAddress)}/${encodeURIComponent(nonce)}`;
        const start = Date.now();
        while (Date.now() - start < 150_000) {
          try {
            const r = await fetch(url).then((res) => res.json());
            if (Array.isArray(r) && r[0]) {
              if (r[0].status === "success") {
                filled = true;
                break;
              }
              if (r[0].status === "failed") {
                throw new Error(`Epoch redeem failed: ${JSON.stringify(r[0]).slice(0, 150)}`);
              }
            }
          } catch (e) {
            if (String(e).includes("Epoch redeem failed")) throw e;
          }
          await sleep(5000);
        }
      }

      // The dUSDC already left the vault (the payout note was created when Para
      // signed it). If Epoch confirmed the fill it's done; otherwise it's still
      // settling — DON'T claim success. Surface a distinct "pending" state so the
      // user knows the payout is in flight (Epoch keeps processing it), never a
      // false "Withdrawn ✓" that reads as a silent loss.
      setWStage(filled ? "done" : "pending");
      setWAmount("");
      await refreshBalance(6);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWStage("error");
    }
  }

  if (!isReady || !signerAccountId) {
    return (
      <div className="mx-auto mt-4 w-full max-w-[460px] rounded-2xl border border-black/10 bg-black/[0.03] p-6 text-sm text-black/50">
        Connect with Para above to fund your Miden account.
      </div>
    );
  }

  const dusdcHuman = dusdc != null ? formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals) : "—";
  // Withdraw is capped at the vault balance — requesting more underflows.
  const wMax = dusdc != null ? formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals) : "0";
  const wOverBalance = !!wAmount && Number(wAmount) > Number(wMax);

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--ink)" }}>Fund your Miden account</h2>
      <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
        Bridge Sepolia USDC from your own MetaMask / Rabby into your Miden account (via Epoch).
      </p>

      <div style={sty.balanceRow}>
        <span style={{ color: "var(--ink-3)" }}>Your dUSDC on Miden</span>
        <span style={{ fontFamily: "var(--font-mono-stack)", color: "var(--ink)" }}>{dusdcHuman}</span>
      </div>

      {!evmAddress ? (
        <button type="button" onClick={connectEvm} className="nav-cta" style={sty.fullBtn}>
          Connect MetaMask / Rabby (Sepolia)
        </button>
      ) : (
        <>
          <label style={{ ...sty.fieldLabel, display: "flex", justifyContent: "space-between" }}>
            <span>USDC amount (Sepolia)</span>
            {sepoliaUsdc != null && (
              <span style={{ textTransform: "none" }}>
                Balance: {formatUnits(sepoliaUsdc, EPOCH_USDC_SEPOLIA.decimals)} USDC
              </span>
            )}
          </label>
          <div style={sty.inputRow}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={busy}
              style={sty.input}
              placeholder="1.0"
            />
            <button type="button" onClick={onMaxFund} disabled={busy} style={sty.maxBtn}>
              Max
            </button>
            <span style={{ fontSize: 14, color: "var(--ink-3)" }}>USDC</span>
          </div>
          <button
            type="button"
            onClick={onFund}
            disabled={busy || !amount || Number(amount) <= 0}
            className="nav-cta"
            style={{ ...sty.fullBtn, opacity: busy || !amount || Number(amount) <= 0 ? 0.5 : 1 }}
          >
            {busy ? STAGE_LABEL[stage] : "Fund"}
          </button>
          <p style={sty.hint}>
            Source wallet <span style={{ fontFamily: "var(--font-mono-stack)" }}>{evmAddress.slice(0, 6)}…{evmAddress.slice(-4)}</span> · sends on Sepolia, delivers dUSDC to your Miden account.
          </p>
          {(stage === "bridging" || stage === "receiving" || stage === "consuming") && (
            <p style={sty.progressMsg}>
              Bridging in progress — Epoch is delivering your dUSDC (~1–2 min). This finishes on its own: you can
              close this window and your balance updates automatically when it lands. (It&apos;s not spendable until
              then.)
            </p>
          )}
        </>
      )}

      {stage === "done" && <p style={sty.doneMsg}>Funded ✓ — your dUSDC is now on your Miden account.</p>}

      {/* Withdraw — the mirror of Fund. Shown once the account holds dUSDC. */}
      {evmAddress && dusdc != null && dusdc > 0n && (
        <div style={{ marginTop: 24, borderTop: "1px solid var(--rule)", paddingTop: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--ink)" }}>Withdraw to Sepolia</h3>
          <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
            Redeem dUSDC from your Miden account back to USDC on your Sepolia address (via Epoch).
          </p>
          <label style={{ ...sty.fieldLabel, display: "flex", justifyContent: "space-between" }}>
            <span>dUSDC amount</span>
            <span style={{ textTransform: "none" }}>Balance: {dusdcHuman}</span>
          </label>
          <div style={sty.inputRow}>
            <input
              value={wAmount}
              onChange={(e) => setWAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={wBusy}
              style={sty.input}
              placeholder="1.0"
            />
            <button type="button" onClick={() => setWAmount(wMax)} disabled={wBusy} style={sty.maxBtn}>
              Max
            </button>
            <span style={{ fontSize: 14, color: "var(--ink-3)" }}>dUSDC</span>
          </div>
          {wOverBalance && (
            <p style={{ marginTop: 8, fontSize: 12, color: "#b91c1c" }}>
              Amount exceeds your balance ({dusdcHuman} dUSDC).
            </p>
          )}
          <button
            type="button"
            onClick={onWithdraw}
            disabled={wBusy || !wAmount || Number(wAmount) <= 0 || wOverBalance}
            className="nav-cta"
            style={{ ...sty.fullBtn, opacity: wBusy || !wAmount || Number(wAmount) <= 0 || wOverBalance ? 0.5 : 1 }}
          >
            {wBusy ? WSTAGE_LABEL[wStage] : "Withdraw to Sepolia"}
          </button>
          <p style={sty.hint}>
            Payout to <span style={{ fontFamily: "var(--font-mono-stack)" }}>{evmAddress.slice(0, 6)}…{evmAddress.slice(-4)}</span> on Sepolia. No Sepolia tx to sign — Para signs the payout note.
          </p>
          {wStage === "done" && <p style={sty.doneMsg}>Withdrawn ✓ — USDC is on its way to your Sepolia address.</p>}
          {wStage === "pending" && (
            <p style={sty.hint}>
              Payout submitted — Epoch is still settling it on Sepolia. Your USDC is in flight (the redeem
              note is reclaimable if it doesn&apos;t land); check your Sepolia wallet in a few minutes.
            </p>
          )}
        </div>
      )}

      {error && <p style={sty.errMsg}>{error}</p>}
    </div>
  );
}

const sty: Record<string, CSSProperties> = {
  balanceRow: {
    marginTop: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid var(--rule)",
    paddingBottom: 8,
    fontSize: 14,
  },
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
  // In-flight but positive — a calm blue, same language as the trade panel's
  // optimistic "settling" state, so the wait reads as progress not a stall.
  progressMsg: {
    marginTop: 12,
    borderRadius: 8,
    border: "1px solid rgba(59,130,246,0.4)",
    background: "rgba(59,130,246,0.10)",
    padding: "8px 12px",
    fontSize: 12,
    color: "#1d4ed8",
  },
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
