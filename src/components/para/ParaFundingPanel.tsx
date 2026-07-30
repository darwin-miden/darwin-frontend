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

import { useConsume, useMiden, useSyncState, useWaitForNotes } from "@miden-sdk/react";
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, formatUnits, parseUnits } from "viem";
import { sepolia } from "viem/chains";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";

import {
  ALLOCATOR_URL,
  applySlippageBps,
  EPOCH_USDC_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  dusdcMidenBaseUnits,
  extractNonce,
  fetchQuote,
  submitIntent,
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

  const [evmAddress, setEvmAddress] = useState<`0x${string}` | null>(null);
  const [amount, setAmount] = useState("1");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dusdc, setDusdc] = useState<bigint | null>(null);

  const busy = stage !== "idle" && stage !== "done" && stage !== "error";

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

      setStage("consuming");
      let consumedAny = false;
      for (const id of inboundIds) {
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

  if (!isReady || !signerAccountId) {
    return (
      <div className="mx-auto mt-4 w-full max-w-[460px] rounded-2xl border border-black/10 bg-black/[0.03] p-6 text-sm text-black/50">
        Connect with Para above to fund your Miden account.
      </div>
    );
  }

  const dusdcHuman = dusdc != null ? formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals) : "—";

  return (
    <div className="mx-auto mt-4 w-full max-w-[460px] rounded-2xl border border-black/10 bg-black/[0.03] p-6">
      <h2 className="text-lg font-semibold text-black">Fund your Miden account</h2>
      <p className="mt-1 text-sm text-black/50">
        Bridge Sepolia USDC from your own MetaMask / Rabby into your Para Miden account (via Epoch).
      </p>

      <div className="mt-4 flex items-center justify-between border-b border-black/10 py-2 text-sm">
        <span className="text-black/50">Your dUSDC on Miden</span>
        <span className="font-mono text-black/90">{dusdcHuman}</span>
      </div>

      {!evmAddress ? (
        <button type="button" onClick={connectEvm} className="nav-cta mt-5 w-full" style={{ textAlign: "center" }}>
          Connect MetaMask / Rabby (Sepolia)
        </button>
      ) : (
        <>
          <label className="mt-5 block text-xs uppercase tracking-wide text-black/40">USDC amount (Sepolia)</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              disabled={busy}
              className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 font-mono text-black outline-none focus:border-black/40"
              placeholder="1.0"
            />
            <span className="text-sm text-black/40">USDC</span>
          </div>

          <button
            type="button"
            onClick={onFund}
            disabled={busy || !amount || Number(amount) <= 0}
            className="nav-cta mt-4 w-full disabled:opacity-50"
            style={{ textAlign: "center" }}
          >
            {busy ? STAGE_LABEL[stage] : "Fund"}
          </button>

          <p className="mt-3 text-xs text-black/40">
            Source wallet: <span className="font-mono">{evmAddress.slice(0, 6)}…{evmAddress.slice(-4)}</span> · sends on
            Sepolia, delivers dUSDC to your Para Miden account.
          </p>
        </>
      )}

      {stage === "done" && (
        <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          Funded ✓ — your dUSDC is now on your Para Miden account.
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}
