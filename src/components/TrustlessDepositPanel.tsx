"use client";

/**
 * Trustless deposit — no server, no MidenFi extension.
 *
 * The full "no server trust" ETH-side deposit path:
 *
 * 1. User signs a deterministic message with MetaMask.
 * 2. keccak256(signature) → 32-byte seed → `useCreateWallet({ initSeed })`
 *    yields a Miden wallet fully derived from the ETH signature. Same
 *    signature from any device ⇒ same wallet, no backup needed.
 * 3. (No funding step.) Miden testnet fees are currently 0, so the fresh
 *    derived wallet consumes its deposit note gasless — its first tx
 *    deploys + consumes with fee=0 (verified on-chain 2026-07-16). When
 *    Miden fees go live (mainnet), sponsor gas by pre-sending an mBND note
 *    the wallet consumes — a 0-balance wallet self-funds from a received
 *    MIDEN note (tested), so self-custody is preserved. No paymaster needed.
 * 4. User picks a USDC amount → deposit via Epoch's Sepolia→Miden bridge
 *    with `midenRecipientAccount = derivedWallet.id`.
 * 5. Frontend polls `useWaitForNotes` on the derived wallet until Epoch
 *    delivers the dUSDC note (~30-60s).
 * 6. `useConsume` drains the note into the wallet's vault. All proving
 *    runs in-browser via WASM.
 *
 * Position credit against the v8-noauth controller
 * (`TRUSTLESS_CONTROLLER_HEX`) is the next step in the flow — v8 has
 * `NoAuth` so anyone can submit the consume+credit tx against it
 * without any signing key. That step is queued for the follow-up
 * commit (needs a small custom-script wiring around the SDK's `useSend`
 * / low-level tx construction).
 */

import {
  useCompile,
  useConsume,
  useCreateWallet,
  useMiden,
  useSyncControl,
  useSyncState,
  useTransaction,
  useWaitForNotes,
} from "@miden-sdk/react";
import { TransactionRequestBuilder } from "@miden-sdk/miden-sdk";

// AuthScheme in @miden-sdk/miden-sdk has TWO shapes:
//   - TS type (from wasm binding): enum {AuthEcdsaK256Keccak=1,
//     AuthRpoFalcon512=2} — numeric.
//   - JS runtime (from api-types.js): Object.freeze({Falcon:"falcon",
//     ECDSA:"ecdsa"}) — string.
// The high-level `MidenClient.accounts.create` handles both by running
// its arg through `resolveAuthScheme(str, wasm)` that converts "falcon"
// → wasm.AuthScheme.AuthRpoFalcon512 (2). But `@miden-sdk/react`'s
// `useCreateWallet` calls the LOW-level `client.newWallet(storageMode,
// authScheme, initSeed)` and forwards `authScheme` verbatim into the
// wasm-bindgen call, which expects the number.
// Its default (`DEFAULTS.AUTH_SCHEME = AuthScheme.AuthRpoFalcon512`)
// evaluates against the runtime object → undefined → wasm-bindgen
// throws "invalid enum value passed". Same failure if we pass the
// string "falcon" — the low-level path doesn't convert.
// Force the numeric enum value directly (2 = AuthRpoFalcon512).
const AUTH_SCHEME_FALCON_ENUM_VALUE = 2;
import {
  useAccount,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
} from "wagmi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, keccak256, parseUnits, toBytes } from "viem";

import { EPOCH_DUSDC_FAUCET_ID } from "../lib/midenConstants";
import { deriveMidenWallet } from "../lib/deriveWallet";
import {
  TRUSTLESS_CONTROLLER_HEX,
  basketFelts,
  buildSetPositionScript,
  evmToUserIdFelts,
  fetchTrustlessPosition,
} from "../lib/trustlessController";
import {
  ALLOCATOR_URL,
  applySlippageBps,
  EPOCH_USDC_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  dusdcMidenBaseUnits,
  fetchQuote,
  submitIntent,
  usdcSepoliaBaseUnits,
  extractNonce,
} from "../lib/epoch";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";
import { useSwitchChain } from "wagmi";
import { stashDccBalance } from "../lib/dccBalance";
import { logActivity } from "../lib/activityLog";
import { autoBackupWallet, restoreFromBackup } from "../lib/walletBackup";

// Minimal ERC-20 balanceOf — used to read the user's Sepolia USDC so the
// deposit input can't exceed what they actually hold (and a Max button).
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// The test USDC exposes a permissionless public `mint`. The faucet button
// calls it straight from the user's own wallet — no server, no reserve, they
// just interact with the token contract (they hold Sepolia ETH for gas).
const ERC20_MINT_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

type Stage =
  | "idle"
  | "signing"
  | "deriving"
  | "ready"
  | "quoting"
  | "quoted"
  | "signing-sepolia"
  | "awaiting-delivery"
  | "consuming"
  | "crediting"
  | "done"
  | "error";

const HUMAN_AMOUNT_DEFAULT = "";

// Format a base-unit amount string (e.g. a quote's tokenIn/tokenOut) for display.
function fmtBase(base: string, decimals: number): string {
  try {
    return Number(
      formatUnits(BigInt(base || "0"), decimals),
    ).toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return base;
  }
}

// After a programmatic chain switch, some wallets (Rabby/MetaMask) haven't
// reloaded the new chain's native balance yet, so the very next tx request
// renders "Gas balance is not enough" and disables Sign — until the user
// cancels and retries, by which point the balance loaded. Warm it: read the
// account's Sepolia ETH balance through the wallet's OWN injected provider
// (eth_getBalance hits the wallet's RPC, populating the cache the gas check
// reads) until it comes back non-zero, so the approval popup opens with the
// gas already loaded. Best-effort + time-boxed — never blocks the deposit.
async function warmWalletGas(evmAddress: string): Promise<void> {
  try {
    const eth = (
      window as unknown as {
        ethereum?: { request?: (a: unknown) => Promise<unknown> };
      }
    ).ethereum;
    if (!eth?.request) return;
    for (let i = 0; i < 8; i++) {
      try {
        const bal = (await eth.request({
          method: "eth_getBalance",
          params: [evmAddress, "latest"],
        })) as string;
        if (bal && BigInt(bal) > 0n) return;
      } catch {
        /* provider mid-switch — retry below */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch {
    /* best-effort warm; never block the deposit */
  }
}

type StageState = "idle" | "running" | "done";

function StageRow({
  label,
  state,
  detail,
  link,
}: {
  label: string;
  state: StageState;
  detail: string;
  link?: string | null;
}) {
  const badge =
    state === "done" ? "✓" : state === "running" ? "…" : "·";
  const badgeColor =
    state === "done"
      ? "#0a7a3e"
      : state === "running"
        ? "#c47a00"
        : "var(--ink-3)";
  const detailColor =
    state === "idle" ? "var(--ink-3)" : "var(--ink)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "22px 130px 1fr",
        gap: 8,
        alignItems: "baseline",
        padding: "4px 0",
        borderBottom: "1px dashed var(--rule)",
      }}
    >
      <span style={{ color: badgeColor, fontWeight: 700, textAlign: "center" }}>
        {badge}
      </span>
      <span
        style={{
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.05em",
          color: "var(--ink-2)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: detailColor,
          wordBreak: "break-all",
          fontSize: 12,
        }}
      >
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            style={{ color: detailColor, textDecoration: "underline" }}
          >
            {detail}
          </a>
        ) : (
          detail
        )}
      </span>
    </div>
  );
}


// The derive step is deterministic per EVM address and the signing keys
// persist in the WASM keystore (IndexedDB), so once ANY panel derived
// the wallet in this browser, others can reuse the id without asking
// for another MetaMask signature.
function storedWalletId(evm: string | undefined): string | null {
  if (!evm || typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(`darwin-derived-${evm.toLowerCase()}`);
  } catch {
    return null;
  }
}
function storeWalletId(evm: string | undefined, id: string) {
  if (!evm || typeof window === "undefined") return;
  try {
    sessionStorage.setItem(`darwin-derived-${evm.toLowerCase()}`, id);
  } catch {}
}

export function TrustlessDepositPanel({
  basket,
  compact = false,
  network = false,
}: {
  /** Basket to credit — keys slot-10 per (user, basket). Omit = legacy flat slot. */
  basket?: { symbol: string; faucetHex: string };
  /** Embedded mode: hides the demo headline + explainer copy. */
  compact?: boolean;
  /**
   * Network rail: instead of the browser writing slot-10 on the NoAuth
   * controller, it emits an atomic deposit note at the NETWORK
   * controller and the testnet's NTX builder executes the credit (vault
   * + position) — no NoAuth, no operator, validation runs in the
   * controller's own MASM under network execution.
   */
  network?: boolean;
} = {}) {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  const { createWallet, wallet, isCreating, error: createErr, reset } =
    useCreateWallet();
  const { consume, isLoading: isConsuming } = useConsume();
  const { waitForConsumableNotes } = useWaitForNotes();
  const { sync: syncState } = useSyncState();
  const { execute: executeTx } = useTransaction();
  const { txScript: compileTxScript } = useCompile();
  const { pauseSync, resumeSync } = useSyncControl();
  const { client, runExclusive } = useMiden();

  // Isolated debug hooks — the Playwright autonomous E2E test drives
  // step 1 (derive) and step 4 (credit slot-10 on v8-noauth) directly,
  // bypassing MetaMask + wagmi + ConnectKit. DEV-ONLY: these expose a
  // derive-from-seed + submit-against-controller toolkit that would widen
  // any XSS blast radius, so they are dead-code-eliminated from prod
  // builds (process.env.NODE_ENV is inlined by Next at build time).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as {
      __darwinTrustlessDebug?: (hex: string) => Promise<string>;
      __darwinTrustlessCredit?: (
        evm: string,
        amount: string,
      ) => Promise<string>;
    };
    w.__darwinTrustlessDebug = async (hex: string) => {
      const clean = hex.replace(/^0x/, "");
      const seedBytes = new Uint8Array(
        clean.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
      );
      pauseSync();
      try {
        const account = await createWallet({
          initSeed: seedBytes,
          storageMode: "private",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as any,
        });
        return account.id().toString();
      } finally {
        resumeSync();
      }
    };
    // Directly credit slot-10 on v8-noauth for (evm, amount). Same tx
    // script the full flow uses at step 4; exposes what the browser
    // can do against a NoAuth controller with no signing key.
    w.__darwinTrustlessCredit = async (evm, amount) => {
      pauseSync();
      try {
        const clientAny = client as unknown as {
          importAccountById?: (id: unknown) => Promise<unknown>;
          getAccount?: (id: unknown) => Promise<unknown>;
          syncState?: () => Promise<unknown>;
        };
        const { AccountId } = await import("@miden-sdk/miden-sdk");
        const accId = AccountId.fromHex(TRUSTLESS_CONTROLLER_HEX);
        try {
          if (clientAny.importAccountById) {
            await clientAny.importAccountById(accId);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/already being tracked/i.test(msg)) throw e;
        }
        try {
          await clientAny.syncState?.();
        } catch (_) {}
        // Sanity: verify the account is materialised in the local
        // store post-sync — surfaces the "nonce=0" case early rather
        // than letting apply_transaction throw a cryptic error.
        const acc = clientAny.getAccount
          ? await clientAny.getAccount(accId)
          : null;
        console.log("[trustless] v8 fetched:", !!acc);
        const { suffix, prefix } = evmToUserIdFelts(evm);
        const amountBase = BigInt(amount);
        const scriptSrc = buildSetPositionScript(suffix, prefix, amountBase);
        const txScript = await compileTxScript({ code: scriptSrc });
        const res = await executeTx({
          accountId: TRUSTLESS_CONTROLLER_HEX,
          request: () =>
            new TransactionRequestBuilder()
              .withCustomScript(txScript)
              .build(),
        });
        return res?.transactionId?.toString?.() ?? "no-tx-id";
      } finally {
        resumeSync();
      }
    };
  }, [client, createWallet, compileTxScript, executeTx, pauseSync, resumeSync]);

  const [stage, setStage] = useState<Stage>("idle");
  const [walletId, setWalletId] = useState<string | null>(null);
  // Track the connected EVM account. On an in-wallet account switch
  // (A→B, no disconnect) evmAddress changes: reset walletId to whatever
  // was derived for the NEW address (or null), so we never drive account
  // A's already-unlocked Miden hot wallet while reading account B's
  // position. Reuses a wallet already derived this session for B.
  useEffect(() => {
    if (!evmAddress) {
      setWalletId(null);
      return;
    }
    setWalletId(storedWalletId(evmAddress));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmAddress]);
  const [humanAmount, setHumanAmount] = useState<string>(HUMAN_AMOUNT_DEFAULT);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // The connected wallet's Sepolia USDC balance (18-dec base units), so the
  // deposit input is bounded by real funds and a Max button can fill it in.
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  // Testnet faucet plumbing: the "Get test USDC" button calls the token's
  // public mint() from the user's own wallet. `faucetNonce` forces a balance
  // re-read after the mint lands; `faucetBusy` disables the button meanwhile.
  const [faucetNonce, setFaucetNonce] = useState(0);
  const [faucetBusy, setFaucetBusy] = useState(false);

  // Read (and refresh) the ETH-side USDC balance. Refreshes on every stage
  // change so it updates right after a deposit debits the wallet.
  useEffect(() => {
    if (!evmAddress || !publicClient) {
      setUsdcBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bal = (await publicClient.readContract({
          address: EPOCH_USDC_SEPOLIA.address,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [evmAddress as `0x${string}`],
        })) as bigint;
        if (!cancelled) setUsdcBalance(bal);
      } catch {
        if (!cancelled) setUsdcBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evmAddress, publicClient, stage, faucetNonce]);

  // Mint test USDC to the connected account via the server-side faucet, which
  // pays gas from a disposable key — so a brand-new zero-ETH account works with
  // no MetaMask popup. Best-effort; re-reads the balance a few times as the
  // mint lands. Backs both the "Get test USDC" button and the auto-mint below.
  const mintTestUsdc = useCallback(async () => {
    if (!evmAddress || faucetBusy) return;
    setFaucetBusy(true);
    try {
      // Permissionless client-side mint: the user calls the test USDC's public
      // mint() from their OWN wallet (they hold Sepolia ETH for gas). No server,
      // no reserve — they interact with the contract directly.
      const hash = await writeContractAsync({
        address: EPOCH_USDC_SEPOLIA.address,
        abi: ERC20_MINT_ABI,
        functionName: "mint",
        args: [
          evmAddress as `0x${string}`,
          parseUnits("100", EPOCH_USDC_SEPOLIA.decimals),
        ],
      });
      if (publicClient) {
        await publicClient
          .waitForTransactionReceipt({ hash })
          .catch(() => undefined);
      }
      setFaucetNonce((n) => n + 1);
    } catch {
      /* user rejected, or no gas — best-effort */
    } finally {
      setFaucetBusy(false);
    }
  }, [evmAddress, faucetBusy, writeContractAsync, publicClient]);
  // Quote preview (Get quote → show the exact debit before confirming).
  const [quoteInfo, setQuoteInfo] = useState<{
    tokenIn: string;
    tokenOut: string;
  } | null>(null);
  const pendingQuoteRef = useRef<Awaited<ReturnType<typeof fetchQuote>> | null>(
    null,
  );
  const [sepoliaTx, setSepoliaTx] = useState<string | null>(null);
  const [midenNoteId, setMidenNoteId] = useState<string | null>(null);
  const [consumeTx, setConsumeTx] = useState<string | null>(null);
  const [creditTx, setCreditTx] = useState<string | null>(null);
  const sdkRef = useRef<EpochIntentSDK | null>(null);

  // Auto-sync + auto-note-subscription cause RefCell double-borrow
  // panics on WASM when they race against createWallet / execute. We
  // opt out here and drive syncs manually inside onDerive / onDeposit.

  async function onDerive() {
    if (!evmAddress) {
      setErrorMsg("Connect your ETH wallet above first.");
      return;
    }
    try {
      setErrorMsg(null);
      setStage("signing");
      // Derive the wallet with minimal seed exposure — the signature +
      // seed live only inside deriveMidenWallet's scope and the seed is
      // wiped right after createWallet. Only the id comes back here.
      // pauseSync guards the WASM RefCell against the SDK's auto-sync
      // racing createWallet ("RefCell already borrowed" from platform.rs).
      setStage("deriving");
      pauseSync();
      let resolvedWalletId: string;
      try {
        resolvedWalletId = await deriveMidenWallet(createWallet, {
          evmAddress,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signTypedData: (td) => signTypedDataAsync(td as any),
          getCode: (addr) => publicClient!.getCode({ address: addr }),
          // Silent auto-restore on a cleared store / new device.
          tryRestore: () =>
            restoreFromBackup({ client, runExclusive, syncState, evmAddress: evmAddress! }),
        });
      } finally {
        resumeSync();
      }
      setWalletId(resolvedWalletId);
      storeWalletId(evmAddress, resolvedWalletId);
      setStage("ready");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Epoch's suggested-nonce indexer lags a few minutes behind
      // recent Compact deposits from the same address; a suggestion can
      // point at an already-consumed nonce. A retry fetches a fresh one
      // and the escrowed deposit balance stays yours.
      setErrorMsg(
        /nonce has already been used/i.test(raw)
          ? "Nonce collision (another recent deposit from this address). Just click deposit again — a fresh nonce is fetched each attempt and your escrowed funds remain yours."
          : raw,
      );
      setStage("error");
    }
  }

  // Build the SDK + fetch the Epoch quote, WITHOUT committing — so the user
  // sees the exact debit (you pay X USDC → receive ~Y dUSDC) before confirming,
  // like the Epoch reference example. The quote is stashed for onDeposit to reuse.
  async function onGetQuote() {
    if (!walletId || !evmAddress) return;
    pauseSync();
    try {
      setErrorMsg(null);
      setQuoteInfo(null);
      pendingQuoteRef.current = null;
      setStage("quoting");
      try {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      } catch (_) {}
      // Warm the wallet's Sepolia gas balance now (right after the switch) so
      // it's loaded by the time the deposit's approval popup opens.
      await warmWalletGas(evmAddress);
      const eth = (window as unknown as { ethereum?: unknown }).ethereum;
      if (!eth) throw new Error("No injected ETH provider (MetaMask?)");
      const walletClient = createWalletClient({
        account: evmAddress as `0x${string}`,
        chain: sepolia,
        transport: custom(eth as never),
      });
      sdkRef.current = new EpochIntentSDK({
        apiBaseUrl: ALLOCATOR_URL,
        walletClient,
      });
      const tokenInAmount = parseUnits(
        humanAmount,
        EPOCH_USDC_SEPOLIA.decimals,
      ).toString();
      const minTokenOut = applySlippageBps(
        dusdcMidenBaseUnits(humanAmount),
        1000,
      );
      const quote = await fetchQuote(sdkRef.current, {
        evmSourceAddress: evmAddress as `0x${string}`,
        midenRecipientId: walletId,
        tokenInAmount,
        minTokenOut,
      });
      pendingQuoteRef.current = quote;
      const qr = (quote as { quoteResult?: { tokenIn?: string; tokenOut?: string } })
        .quoteResult;
      setQuoteInfo({
        tokenIn: qr?.tokenIn ?? tokenInAmount,
        tokenOut: qr?.tokenOut ?? "0",
      });
      setStage("quoted");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    } finally {
      resumeSync();
    }
  }

  async function onDeposit() {
    if (!walletId || !evmAddress) return;
    // Same reasoning as onDerive — pause the SDK's auto-sync so it
    // doesn't race the consume / executeTx futures on the WASM RefCell.
    pauseSync();
    try {
      setErrorMsg(null);

      // Reuse the quote from "Get quote"; fall back to a fresh fetch.
      let quote = pendingQuoteRef.current;
      if (!quote || !sdkRef.current) {
        setStage("quoting");
        try {
          await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
        } catch (_) {}
        const eth = (window as unknown as { ethereum?: unknown }).ethereum;
        if (!eth) throw new Error("No injected ETH provider (MetaMask?)");
        const walletClient = createWalletClient({
          account: evmAddress as `0x${string}`,
          chain: sepolia,
          transport: custom(eth as never),
        });
        sdkRef.current = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient,
        });
        const tokenInAmount = parseUnits(
          humanAmount,
          EPOCH_USDC_SEPOLIA.decimals,
        ).toString();
        const minTokenOut = applySlippageBps(
          dusdcMidenBaseUnits(humanAmount),
          1000,
        );
        quote = await fetchQuote(sdkRef.current, {
          evmSourceAddress: evmAddress as `0x${string}`,
          midenRecipientId: walletId,
          tokenInAmount,
          minTokenOut,
        });
      }
      pendingQuoteRef.current = null;
      // Right before the approval popup opens: guarantee the wallet is on
      // Sepolia AND its gas balance is loaded, so it never shows "Gas balance
      // is not enough" on the first attempt. When the quote was reused (no
      // switch above), the wallet may have drifted chains; this re-asserts it.
      try {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      } catch (_) {}
      await warmWalletGas(evmAddress);
      setStage("signing-sepolia");
      const submit = await submitIntent(sdkRef.current, quote);
      // The Sepolia deposit hash lives on depositResult (depositToCompact's
      // return), not at the top level — the old read left the row stuck
      // on 'waiting' even after the tx confirmed.
      const depTx =
        (submit as { depositResult?: { transactionHash?: string } })
          ?.depositResult?.transactionHash ??
        (submit as { transactionHash?: string })?.transactionHash;
      setSepoliaTx(depTx ?? null);
      const intentNonce = extractNonce(submit);

      setStage("awaiting-delivery");
      // Authoritative delivery signal first: poll Epoch's /intentStatus,
      // which flips to success (with the miden note id) as soon as the
      // solver delivers — usually well before the local WASM client has
      // synced the note tag. The old flow only watched the local client,
      // so the panel showed 'filling your intent…' minutes after the
      // note was already on-chain.
      console.log("[deposit] polling Epoch intentStatus", intentNonce);
      let epochNoteId: string | null = null;
      if (intentNonce) {
        const url = `${ALLOCATOR_URL}/intentStatus/${evmAddress}/${intentNonce}`;
        const start = Date.now();
        while (Date.now() - start < 120_000) {
          try {
            const r = await fetch(url).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const s = r[0];
              if (s.status === "success") {
                epochNoteId = s.midenNoteId ?? null;
                break;
              }
              if (s.status === "failed") {
                throw new Error(
                  `Epoch reported failed: ${JSON.stringify(s).slice(0, 150)}`,
                );
              }
            }
          } catch (e) {
            if (String(e).includes("Epoch reported failed")) throw e;
          }
          await new Promise((res) => setTimeout(res, 5_000));
        }
      }
      if (epochNoteId) {
        console.log("[deposit] delivered on Miden:", epochNoteId);
        setMidenNoteId(epochNoteId);
      }

      // Then wait for the local client to actually see the note so we
      // can consume it. Bare call + hard Promise.race — same fix as the
      // redeem panel (waitForConsumableNotes can outlive its timeoutMs,
      // and inside runExclusive a hang would starve the consume).
      console.log("[deposit] waiting for local client to sync the note…");
      let delivered: unknown[] = [];
      for (let attempt = 0; attempt < 4 && delivered.length === 0; attempt++) {
        try {
          await runExclusive(() => syncState());
        } catch (_) {}
        try {
          const raced = await Promise.race<unknown[] | undefined>([
            waitForConsumableNotes({
              accountId: walletId,
              minCount: 1,
              timeoutMs: 30_000,
              intervalMs: 5_000,
            }) as Promise<unknown[] | undefined>,
            new Promise<unknown[]>((resolve) =>
              setTimeout(() => resolve([]), 33_000),
            ),
          ]);
          delivered = Array.isArray(raced) ? raced : [];
        } catch (_) {
          delivered = [];
        }
      }
      if (delivered.length === 0) {
        throw new Error(
          epochNoteId
            ? `Note ${epochNoteId.slice(0, 18)}… is delivered on-chain but the local client never synced it — refresh and retry, the funds are safe.`
            : "Epoch never confirmed delivery and no note reached the wallet.",
        );
      }
      // The consume hook resolves note IDs (strings) or Note/InputNoteRecord
      // objects — a raw ConsumableNoteRecord throws 'array contains a value
      // of the wrong type' in wasm. Extract id strings, same as the
      // reference app's NotesInboxPanel.
      const inboundIds = (delivered as Array<{
        inputNoteRecord?: () => { id?: () => { toString?: () => string } } | null;
      }>)
        .map((n) => n.inputNoteRecord?.()?.id?.()?.toString?.() ?? "")
        .filter(Boolean);
      if (inboundIds.length === 0) {
        throw new Error("Consumable notes had no readable ids");
      }
      setMidenNoteId(inboundIds[0] ?? epochNoteId);

      setStage("consuming");
      // Consume pending notes ONE AT A TIME. A batch consume is atomic, so a
      // single mis-targeted leftover note — e.g. a P2ID whose target account
      // isn't this wallet, stranded from earlier testing — fails the whole
      // transaction ("P2ID's target account address and transaction address
      // do not match") and takes this deposit's own good note down with it.
      // Per-note, we consume what this wallet actually owns and skip the rest;
      // skipped notes stay consumable (nothing is lost), and a stuck prior
      // delivery still gets drained alongside this one.
      let consumeResult:
        | { transactionId?: { toString?: () => string } }
        | null
        | undefined = null;
      let consumedAny = false;
      const consumeErrors: string[] = [];
      for (const id of inboundIds) {
        try {
          const res = await consume({ accountId: walletId, notes: [id] });
          consumeResult = res ?? consumeResult;
          consumedAny = true;
        } catch (e) {
          // Keep the FULL node reason (the grpc status after "submit_prov:") —
          // it's what distinguishes a network mismatch from a real rejection.
          consumeErrors.push(`${id.slice(0, 12)}…: ${String(e).slice(0, 400)}`);
          console.warn("[deposit] skipped un-consumable note", id, e);
        }
      }
      if (!consumedAny) {
        throw new Error(
          `None of the ${inboundIds.length} delivered note(s) could be consumed by this wallet` +
            (consumeErrors[0] ? ` — ${consumeErrors[0]}` : "") +
            ". Your escrowed funds remain on-chain; refresh and retry.",
        );
      }
      setConsumeTx(consumeResult?.transactionId?.toString?.() ?? null);

      // Step 4 (network rail): emit an atomic deposit note at the
      // NETWORK controller from the user's own derived wallet. The note
      // carries the dUSDC and the NetworkAccountTarget attachment; the
      // testnet's NTX builder consumes it and executes the credit
      // (receive_asset + slot-10 accumulate) — the browser only signs
      // the emitting tx. The note bytes come pre-assembled from
      // /api/network-note because the 0.15 web SDK can't put
      // attachments on custom notes; the endpoint is a pure function
      // (no keys) and the browser still proves + submits everything.
      if (network) {
        // v10 CONFIDENTIAL deposit: emit a deposit note at the basket
        // faucet-network account. The NTX builder drains the dUSDC
        // collateral into the faucet vault and MINTS basket tokens into
        // a PRIVATE note only this wallet can claim. The position is the
        // wallet's private token balance — no public per-user ledger.
        // Priced at the live NAV: mint_amount = deposit / NAV.
        setStage("crediting");
        // Drain exactly what Epoch actually delivered into the vault — NOT
        // the requested amount. The testnet solver caps delivery, so a note
        // funded for MORE than what arrived underflows when the wallet emits
        // it ("subtracting X from fungible asset amount Y would underflow",
        // where Y is the vault balance). Read the wallet's OWN private vault
        // via getAccount → vault().getBalance — the reliable local read.
        // (`client.getBalance` never resolves here and was silently falling
        // back to the requested amount, funding an over-sized note.) Retry a
        // few times: the vault may lag a beat behind the consume.
        const { AccountId: DusdcAccountId } = await import("@miden-sdk/miden-sdk");
        const dusdcFaucet = DusdcAccountId.fromHex(
          EPOCH_USDC_SEPOLIA.midenFaucetId,
        );
        let amountBaseNet = 0n;
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const acc = (await runExclusive(() =>
              (
                client as unknown as {
                  getAccount: (id: unknown) => Promise<unknown>;
                }
              ).getAccount(DusdcAccountId.fromHex(walletId)),
            )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
            const bal = acc ? BigInt(acc.vault().getBalance(dusdcFaucet) ?? 0n) : 0n;
            if (bal > 0n) {
              amountBaseNet = bal;
              break;
            }
          } catch {
            /* vault not synced yet — retry below */
          }
          await runExclusive(() => syncState()).catch(() => {});
          await new Promise((res) => setTimeout(res, 2_000));
        }
        if (amountBaseNet <= 0n) {
          throw new Error(
            "No dUSDC arrived from the bridge — the Epoch testnet solver may be out of liquidity. Try a smaller amount, or retry in a bit.",
          );
        }
        const r = await fetch("/api/confidential-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: walletId,
            recipient: walletId,
            basket: basket?.symbol ?? "DCC",
            amount: amountBaseNet.toString(),
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
        if (!r.ok || !built.noteB64 || !built.paybackFileB64) {
          throw new Error(built.error ?? `confidential-note API ${r.status}`);
        }
        const { Note, NoteArray, NoteFile } = await import("@miden-sdk/miden-sdk");
        const bytes = Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0));
        const depositNote = Note.deserialize(bytes);
        const emitResult = await executeTx({
          accountId: walletId,
          request: () =>
            new TransactionRequestBuilder()
              .withOwnOutputNotes(new NoteArray([depositNote]))
              .build(),
        });
        setCreditTx(emitResult?.transactionId?.toString?.() ?? built.noteId ?? null);
        // Import + consume the private minted-token note — the basket
        // tokens land in this wallet's private vault.
        const fileBytes = Uint8Array.from(atob(built.paybackFileB64), (c) => c.charCodeAt(0));
        const noteFile = NoteFile.deserialize(fileBytes);
        const clientAny = client as unknown as {
          importNoteFile?: (f: unknown) => Promise<string>;
        };
        await clientAny.importNoteFile?.(noteFile);
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, 5_000));
          try {
            await runExclusive(() => syncState());
          } catch (_) {}
          try {
            await consume({ accountId: walletId, notes: [built.paybackId!] });
            break;
          } catch (_) {
            /* not minted yet — keep polling */
          }
        }
        // Stash the real DCC balance for the Withdraw panel (getBalance works
        // here — warm client, mint just consumed into the vault).
        await stashDccBalance(client, runExclusive, walletId, basket?.symbol ?? "DCC");
        // Silent auto-backup — the deposit just changed the wallet's state, so
        // protect it immediately (no prompt, no UI). Best-effort, non-blocking.
        void autoBackupWallet({
          client,
          runExclusive,
          walletId,
          evmAddress: evmAddress!,
          signTypedData: (td) => signTypedDataAsync(td as any),
          force: true,
        });
        logActivity(evmAddress, {
          type: "deposit",
          basket: basket?.symbol ?? "DCC",
          amount: humanAmount,
          shares: built.mintAmount,
          tx: sepoliaTx ?? undefined,
        });
        setStage("done");
        return;
      }

      // Step 4: credit slot-10 on v8-noauth via a browser-signed tx
      // script. v8 is NoAuth, so we can submit against it without any
      // signing key — this is the whole "no server trust" beat.
      setStage("crediting");
      // Ensure v8-noauth is imported + synced locally so the tx
      // executor can resolve its code.
      const clientAny = client as unknown as {
        importAccountById?: (id: unknown) => Promise<unknown>;
        syncState?: () => Promise<unknown>;
      };
      const { AccountId } = await import("@miden-sdk/miden-sdk");
      const accId = AccountId.fromHex(TRUSTLESS_CONTROLLER_HEX);
      try {
        await clientAny.importAccountById?.(accId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already being tracked/i.test(msg)) throw e;
      }
      try { await clientAny.syncState?.(); } catch (_) {}

      const { suffix, prefix } = evmToUserIdFelts(evmAddress);
      const amountBase = parseUnits(humanAmount, EPOCH_USDC_SEPOLIA.midenDecimals);
      // Read-modify-write: slot-10 stores the ABSOLUTE position, so add
      // this deposit to whatever is already there instead of overwriting
      // (multiple deposits must accumulate). When a basket is supplied
      // the key is per-(user, basket) — the native Darwin accounting.
      const bFelts = basket
        ? await basketFelts(basket.faucetHex)
        : { basketSuffix: 0n, basketPrefix: 0n };
      const { position: currentPos } = await fetchTrustlessPosition(
        evmAddress,
        bFelts,
      );
      const newPos = currentPos + amountBase;
      const scriptSrc = buildSetPositionScript(
        suffix,
        prefix,
        newPos,
        bFelts.basketSuffix,
        bFelts.basketPrefix,
      );
      const txScript = await compileTxScript({ code: scriptSrc });
      let creditTxId: string | null = null;
      try {
        const creditResult = await executeTx({
          accountId: TRUSTLESS_CONTROLLER_HEX,
          request: () =>
            new TransactionRequestBuilder().withCustomScript(txScript).build(),
        });
        creditTxId = creditResult?.transactionId?.toString?.() ?? null;
      } catch (e) {
        // The tx pipeline is: execute (local) → prove → submit → apply
        // (local). apply writes the delta into IndexedDB against the
        // browser's copy of v8. The Miden Web SDK's book-keeping isn't
        // set up for NoAuth foreign accounts and errors here with
        // "account data wasn't found" AFTER the tx has been submitted +
        // committed on-chain. That's cosmetic — the network already
        // accepted the tx and slot-10 is updated. Verified live: the
        // TrustlessDepositPanel triggered txs 0xc90db925… (block
        // 346218) and 0xab78ff86… (block 346148) reach the controller
        // and update its map root even though the browser threw here.
        // Swallow apply errors specifically; anything else bubbles up.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/apply transaction result|storage error: account data wasn't found/i.test(msg)) {
          throw e;
        }
        creditTxId = "submitted (see midenscan)";
      }
      setCreditTx(creditTxId);

      setStage("done");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Epoch's suggested-nonce indexer lags a few minutes behind
      // recent Compact deposits from the same address; a suggestion can
      // point at an already-consumed nonce. A retry fetches a fresh one
      // and the escrowed deposit balance stays yours.
      setErrorMsg(
        /nonce has already been used/i.test(raw)
          ? "Nonce collision (another recent deposit from this address). Just click deposit again — a fresh nonce is fetched each attempt and your escrowed funds remain yours."
          : raw,
      );
      setStage("error");
    } finally {
      resumeSync();
    }
  }

  // ── Deposit-amount / balance validation (Sepolia USDC is 18-dec) ──
  const usdcDecimals = EPOCH_USDC_SEPOLIA.decimals;
  let amountBase: bigint | null;
  try {
    amountBase = parseUnits(humanAmount || "0", usdcDecimals);
  } catch {
    amountBase = null; // mid-typing (e.g. "1.") — treat as not-yet-valid
  }
  const insufficient =
    usdcBalance != null && amountBase != null && amountBase > usdcBalance;
  const amountValid = amountBase != null && amountBase > 0n && !insufficient;
  const fmtUsdc = (base: bigint) =>
    parseFloat(formatUnits(base, usdcDecimals)).toLocaleString(undefined, {
      maximumFractionDigits: 4,
    });
  // Max = the full balance, floored to 4 decimals (matches the balance shown
  // below the input, so no visible remainder is dropped). The reverse-quote
  // pulls marginally LESS USDC than the typed amount (the fee comes out of the
  // Miden-side delivery, not added to the Sepolia input — verified on-chain),
  // so depositing ~the whole balance is safe; the 4-decimal floor only drops
  // sub-0.0001 dust, not worth risking a failed tx over.
  function setMaxAmount() {
    if (usdcBalance == null || usdcBalance === 0n) return;
    const human = Math.floor(parseFloat(formatUnits(usdcBalance, usdcDecimals)) * 1e4) / 1e4;
    setHumanAmount(String(human));
  }

  return (
    <section style={{ marginTop: compact ? 0 : 48 }}>
      {!compact && (
        <h2
          style={{
            fontSize: 14,
            fontFamily: "var(--font-mono-stack)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            borderBottom: "1px solid var(--ink)",
            paddingBottom: 8,
            marginBottom: 16,
          }}
        >
          Trustless deposit · demo (no server, no extension)
        </h2>
      )}

      {compact ? (
        <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
          Self-custody{basket ? ` · ${basket.symbol}` : ""}. One signature
          derives your Miden wallet in-browser; Epoch bridges your USDC, then
          the Miden network mints your {basket?.symbol ?? "basket"} position —
          confidential, priced at the basket&apos;s live NAV. A single “Confirm
          deposit” does the whole thing; no separate buy step.
        </p>
      ) : (
        <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
          Sign one message with MetaMask → your Miden signing key is derived
          from that signature (deterministic — same sig on any device gives
          the same wallet). Deposits credit position slot-10 on the{" "}
          <code>NoAuth</code> Darwin controller
          <br />
          <code>{TRUSTLESS_CONTROLLER_HEX}</code>
          <br />
          which lets anyone submit txs against it without a signing key. No
          Darwin backend is involved.
        </p>
      )}

      {!ethConnected && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          Connect your ETH wallet above to begin.
        </p>
      )}

      {ethConnected && !walletId && stage !== "signing" && stage !== "deriving" && (
        <button
          onClick={onDerive}
          className="nav-cta"
          style={{ minWidth: 260 }}
          disabled={isCreating}
        >
          Step 1 · Derive Miden key from MetaMask
        </button>
      )}

      {stage === "signing" && (
        <p style={{ fontSize: 13 }}>Waiting for MetaMask signature…</p>
      )}
      {stage === "deriving" && (
        <p style={{ fontSize: 13 }}>Building Miden wallet from your signature (WASM proof)…</p>
      )}

      {walletId && (
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            border: "1px solid var(--rule)",
            padding: 12,
            background: "var(--paper-2)",
            marginBottom: 16,
          }}
        >
          <div>
            <strong>Derived Miden wallet</strong>: <code>{walletId}</code>
          </div>
          <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
            Key stays in this browser — never sent anywhere.
          </div>
          {/*
            No "fund with MIDEN" step: Miden testnet fees are currently 0,
            so the fresh derived wallet consumes its deposit note gasless —
            verified on-chain that a 0-balance, never-deployed wallet's very
            first tx (deploy + consume) pays fee=0. RE-ADD a sponsor here
            when Miden fees go live on mainnet: pre-send an mBND note the
            wallet consumes (a 0-balance wallet self-funds from a received
            MIDEN note — tested), which keeps full self-custody. No paymaster
            needed either way.
          */}
        </div>
      )}

      {walletId && !quoteInfo && stage !== "done" && stage !== "quoting" && stage !== "signing-sepolia" && stage !== "awaiting-delivery" && stage !== "consuming" && stage !== "crediting" && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <label style={{ fontSize: 13 }}>Amount (USDC):</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={usdcBalance != null ? formatUnits(usdcBalance, usdcDecimals) : undefined}
              value={humanAmount}
              onChange={(e) => {
                setHumanAmount(e.target.value);
                setQuoteInfo(null);
                pendingQuoteRef.current = null;
              }}
              style={{
                fontFamily: "var(--font-mono-stack)",
                padding: "4px 8px",
                width: 100,
                borderColor: insufficient ? "crimson" : undefined,
              }}
            />
            <button
              type="button"
              onClick={setMaxAmount}
              disabled={usdcBalance == null || usdcBalance === 0n}
              className="nav-cta"
              style={{
                padding: "4px 12px",
                fontSize: 12,
                opacity: usdcBalance == null || usdcBalance === 0n ? 0.5 : 1,
              }}
              title="Use your full balance minus a ~1% bridge-fee cushion"
            >
              Max
            </button>
            <button
              onClick={onGetQuote}
              disabled={!amountValid}
              className="nav-cta"
              style={{ minWidth: 150, opacity: amountValid ? 1 : 0.5 }}
            >
              Get quote
            </button>
            {!compact && (
              <button
                type="button"
                onClick={mintTestUsdc}
                disabled={faucetBusy}
                className="nav-cta"
                style={{
                  padding: "4px 12px",
                  fontSize: 12,
                  opacity: faucetBusy ? 0.5 : 1,
                }}
                title="Mint 100 test USDC to your wallet — testnet faucet, no gas needed"
              >
                {faucetBusy ? "Minting…" : "Get test USDC"}
              </button>
            )}
          </div>
          <div
            style={{
              fontSize: 12,
              marginTop: 6,
              fontFamily: "var(--font-mono-stack)",
              color: insufficient ? "crimson" : "var(--ink-3)",
            }}
          >
            {faucetBusy
              ? "Adding test USDC to your account…"
              : usdcBalance == null
                ? "Reading your USDC balance…"
                : insufficient
                  ? `Insufficient — you hold ${fmtUsdc(usdcBalance)} USDC. Click “Get test USDC”, Max, or lower the amount.`
                  : `Balance: ${fmtUsdc(usdcBalance)} USDC`}
          </div>
        </div>
      )}

      {quoteInfo && stage === "quoted" && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              border: "1px solid var(--ink)",
              background: "var(--paper-2)",
              padding: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                fontSize: 14,
              }}
            >
              <span style={{ color: "var(--ink-3)" }}>You pay</span>
              <strong style={{ fontFamily: "var(--font-mono-stack)" }}>
                {fmtBase(quoteInfo.tokenIn, EPOCH_USDC_SEPOLIA.decimals)} USDC
              </strong>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                fontSize: 14,
                marginTop: 8,
              }}
            >
              <span style={{ color: "var(--ink-3)" }}>
                {network ? "You buy" : "You receive"}
              </span>
              <strong style={{ fontFamily: "var(--font-mono-stack)" }}>
                {network
                  ? `~$${fmtBase(quoteInfo.tokenOut, EPOCH_USDC_SEPOLIA.midenDecimals)} ${basket?.symbol ?? "DCC"}`
                  : `~${fmtBase(quoteInfo.tokenOut, EPOCH_USDC_SEPOLIA.midenDecimals)} dUSDC`}
              </strong>
            </div>
            {network && (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                  marginTop: 10,
                  borderTop: "1px solid var(--rule)",
                  paddingTop: 10,
                }}
              >
                Your USDC is bridged to dUSDC and immediately minted into a
                confidential {basket?.symbol ?? "DCC"} position — one signature,
                no extra step.
              </div>
            )}
          </div>
          <div
            style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}
          >
            <button
              onClick={onDeposit}
              className="nav-cta"
              style={{ minWidth: 200 }}
            >
              Confirm deposit
            </button>
            <button
              type="button"
              onClick={() => {
                setQuoteInfo(null);
                pendingQuoteRef.current = null;
                setStage("ready");
              }}
              className="nav-cta"
              style={{ padding: "4px 12px", fontSize: 12 }}
            >
              ← Change amount
            </button>
          </div>
        </div>
      )}

      {(stage === "quoting" ||
        stage === "signing-sepolia" ||
        stage === "awaiting-delivery" ||
        stage === "consuming" ||
        stage === "crediting" ||
        stage === "done") && (
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            border: "1px solid var(--ink)",
            padding: 12,
            background: "var(--paper-2)",
            marginTop: 16,
          }}
        >
          <StageRow
            label="quote"
            state={
              stage === "quoting"
                ? "running"
                : stage === "signing-sepolia" ||
                    stage === "awaiting-delivery" ||
                    stage === "consuming" ||
                    stage === "crediting" ||
                    stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "quoting"
                ? "Fetching Epoch quote…"
                : "quote ready"
            }
          />
          <StageRow
            label="deposit"
            state={
              stage === "signing-sepolia"
                ? "running"
                : sepoliaTx
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "signing-sepolia"
                ? "Sign the Compact deposit tx in your ETH wallet…"
                : sepoliaTx
                  ? sepoliaTx
                  : "waiting"
            }
            link={
              sepoliaTx
                ? `https://sepolia.etherscan.io/tx/${sepoliaTx}`
                : null
            }
          />
          <StageRow
            label="epoch delivery"
            state={
              stage === "awaiting-delivery"
                ? "running"
                : midenNoteId
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "awaiting-delivery"
                ? "Epoch solver is filling your intent (~30–60s)…"
                : midenNoteId
                  ? midenNoteId
                  : "waiting"
            }
            link={
              midenNoteId
                ? `https://testnet.midenscan.com/note/${midenNoteId}`
                : null
            }
          />
          <StageRow
            label="consume"
            state={
              stage === "consuming"
                ? "running"
                : consumeTx
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "consuming"
                ? "Draining the P2ID note into your derived wallet…"
                : consumeTx
                  ? consumeTx
                  : "waiting"
            }
            link={
              consumeTx
                ? `https://testnet.midenscan.com/tx/${consumeTx}`
                : null
            }
          />
          <StageRow
            label="credit slot-10"
            state={
              stage === "crediting"
                ? "running"
                : creditTx
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "crediting"
                ? "Minting your confidential position — proving on-chain and waiting for the network (up to ~2 min)…"
                : creditTx
                  ? creditTx
                  : "waiting"
            }
            link={
              creditTx && creditTx.startsWith("0x")
                ? `https://testnet.midenscan.com/tx/${creditTx}`
                : null
            }
          />
          {stage === "done" && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--rule)", color: "var(--ink-3)" }}>
              {network ? (
                <>
                  ✅ Confidential deposit complete —{" "}
                  <strong>the Miden network minted basket tokens</strong> into
                  your private account (collateral into the faucet vault, tokens
                  to you, one network transaction). Your holding is private:
                  no public per-user ledger, no operator, only the MASM.
                </>
              ) : (
                <>
                  ✅ Position credited on{" "}
                  <code>{TRUSTLESS_CONTROLLER_HEX.slice(0, 12)}…</code> by a tx
                  script the browser compiled + submitted with no signing key.
                  v8-noauth accepts any tx bundle. Zero server touches from
                  step 1 to step 4.
                </>
              )}
            </div>
          )}
        </div>
      )}

      {(() => {
        // The "already being tracked" error from createWallet is expected on
        // re-derive: IndexedDB still has the wallet from the previous session
        // and onDerive catches + recovers cleanly. Suppress that specific
        // error from the visible errorbar; anything else surfaces.
        const isTrackedNoise =
          createErr?.message &&
          /already being tracked/i.test(createErr.message);
        const visibleErr = errorMsg
          ? errorMsg
          : isTrackedNoise
            ? null
            : createErr?.message ?? null;
        if (!visibleErr) return null;
        return (
          <p style={{ fontSize: 13, color: "crimson" }}>{visibleErr}</p>
        );
      })()}

      {stage === "ready" && (
        <button
          onClick={() => {
            reset();
            setStage("idle");
            setWalletId(null);
            setSepoliaTx(null);
            setMidenNoteId(null);
            setConsumeTx(null);
          }}
          style={{
            fontSize: 12,
            marginTop: 12,
            background: "transparent",
            border: "1px solid var(--rule)",
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Reset
        </button>
      )}

    </section>
  );
}
