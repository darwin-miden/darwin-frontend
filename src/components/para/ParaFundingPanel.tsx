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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEPOLIA_HEX = "0xaa36a7"; // 11155111

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

type WStage = "idle" | "quoting" | "signing-note" | "awaiting-fill" | "done" | "error";

const WSTAGE_LABEL: Record<WStage, string> = {
  idle: "",
  quoting: "Getting a redeem quote…",
  "signing-note": "Sign the payout note in Para…",
  "awaiting-fill": "Epoch is paying out on Sepolia…",
  done: "Withdrawn ✓",
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
  const [wAmount, setWAmount] = useState("1");
  const [wStage, setWStage] = useState<WStage>("idle");

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";
  const wBusy = wStage !== "idle" && wStage !== "done" && wStage !== "error";

  const refreshBalance = useCallback(
    async (retries = 1) => {
      if (!client || !signerAccountId) return;
      const { AccountId } = await import("@miden-sdk/miden-sdk");
      const dusdcFaucet = AccountId.fromHex(EPOCH_USDC_SEPOLIA.midenFaucetId);
      for (let i = 0; i < retries; i++) {
        try {
          const acc = (await runExclusive(() =>
            (client as { getAccount: (id: unknown) => Promise<unknown> }).getAccount(
              AccountId.fromHex(signerAccountId),
            ),
          )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
          const bal = acc ? BigInt(acc.vault().getBalance(dusdcFaucet) ?? 0n) : 0n;
          setDusdc(bal);
          if (bal > 0n || retries === 1) return;
        } catch {
          /* vault not synced yet */
        }
        await runExclusive(() => syncState()).catch(() => {});
        await sleep(2000);
      }
    },
    [client, signerAccountId, runExclusive, syncState],
  );

  useEffect(() => {
    if (isReady && signerAccountId) refreshBalance(1);
  }, [isReady, signerAccountId, refreshBalance]);

  async function connectEvm() {
    setError(null);
    const eth = getEth();
    if (!eth) {
      setError("No injected wallet found. Install MetaMask or Rabby.");
      return;
    }
    try {
      const accs = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (accs?.[0]) setEvmAddress(accs[0] as `0x${string}`);
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
      const submit = await submitIntent(sdk, quote);
      const intentNonce = extractNonce(submit);

      setStage("bridging");
      let epochNoteId: string | null = null;
      if (intentNonce) {
        const url = `${ALLOCATOR_URL}/intentStatus/${evmAddress}/${intentNonce}`;
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

      setStage("receiving");
      let delivered: unknown[] = [];
      for (let attempt = 0; attempt < 4 && delivered.length === 0; attempt++) {
        try {
          await runExclusive(() => syncState());
        } catch {
          /* retry */
        }
        try {
          const raced = await Promise.race<unknown[] | undefined>([
            waitForConsumableNotes({
              accountId: signerAccountId,
              minCount: 1,
              timeoutMs: 30_000,
              intervalMs: 5_000,
            }) as Promise<unknown[] | undefined>,
            new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), 33_000)),
          ]);
          delivered = Array.isArray(raced) ? raced : [];
        } catch {
          delivered = [];
        }
      }
      if (delivered.length === 0) {
        throw new Error(
          epochNoteId
            ? `Note ${epochNoteId.slice(0, 18)}… is delivered on-chain but the client hasn't synced it — refresh and retry, your funds are safe.`
            : "Epoch never confirmed delivery and no note reached the account.",
        );
      }

      const inboundIds = (
        delivered as Array<{ inputNoteRecord?: () => { id?: () => { toString?: () => string } } | null }>
      )
        .map((n) => n.inputNoteRecord?.()?.id?.()?.toString?.() ?? "")
        .filter(Boolean);

      // Consume ONLY the note Epoch actually delivered — never a stray
      // tag-colliding P2ID note (right tag, wrong target account) left over from
      // earlier tests, which throws "P2ID's target account address and
      // transaction address do not match" inside the WASM (harmless but noisy).
      // Fall back to all inbound notes only when Epoch didn't report a note id.
      const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
      const targetIds =
        epochNoteId && inboundIds.some((id) => norm(id) === norm(epochNoteId as string))
          ? inboundIds.filter((id) => norm(id) === norm(epochNoteId as string))
          : inboundIds;

      setStage("consuming");
      let consumedAny = false;
      for (const id of targetIds) {
        try {
          await consume({ accountId: signerAccountId, notes: [id] });
          consumedAny = true;
        } catch (e) {
          console.warn("[para-fund] skipped un-consumable note", id, e);
        }
      }
      if (!consumedAny) {
        throw new Error("The delivered note couldn't be consumed — refresh and retry, funds are safe.");
      }

      setStage("done");
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
      if (nonce) {
        const url = `${ALLOCATOR_URL}/intentStatus/${evmAddress}/${nonce}`;
        const start = Date.now();
        while (Date.now() - start < 150_000) {
          try {
            const r = await fetch(url).then((res) => res.json());
            if (Array.isArray(r) && r[0]) {
              if (r[0].status === "success") break;
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

      setWStage("done");
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
          <label style={sty.fieldLabel}>USDC amount (Sepolia)</label>
          <div style={sty.inputRow}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={busy}
              style={sty.input}
              placeholder="1.0"
            />
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
