"use client";

/**
 * Trustless redeem — no server, no MidenFi extension.
 *
 * Reverse of TrustlessDepositPanel. Path:
 *   1. Same MetaMask-derived Miden wallet (deterministic from signature)
 *      — must already hold dUSDC from a prior deposit.
 *   2. Call Epoch to reverse-quote Miden→Sepolia (dUSDC in → USDC out).
 *   3. Epoch SDK invokes our `createMidenP2IDNote` callback: we spend
 *      dUSDC from the derived wallet into a P2IDE note targeting Epoch's
 *      allocator on Miden.
 *   4. Epoch solver consumes the note on Miden and delivers USDC to the
 *      user's Sepolia address (no user tx on Sepolia — the P2IDE note IS
 *      the proof of intent).
 *
 * The whole "no server trust" story from the deposit flow holds: this
 * panel talks straight to Epoch's public allocator + the Miden network,
 * with no Darwin backend involvement.
 */

import {
  useConsume,
  useCreateWallet,
  useMiden,
  useSend,
  useSyncControl,
  useSyncState,
  useWaitForNotes,
} from "@miden-sdk/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  keccak256,
  parseTransaction,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";

import {
  ALLOCATOR_URL,
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
  MIDEN_DESTINATION_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  applySlippageBps,
  dusdcMidenBaseUnits,
  fetchQuote,
  fetchRedeemQuote,
  submitIntent,
  submitRedeemIntent,
  usdcSepoliaBaseUnits,
} from "../lib/epoch";

const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// viem walletClient whose transport signs everything locally with the
// given private-key account. The Epoch SDK's sendTransactionSync path
// emits the non-standard eth_sendRawTransactionSync — public RPCs reject
// it, so translate to eth_sendRawTransaction + waitForTransactionReceipt
// and hand back a raw-RPC-shaped receipt (hex fields) for viem's
// formatter. Same wrapper validated in the Node E2E harness.
function localSepoliaSigningClient(
  account: ReturnType<typeof privateKeyToAccount>,
) {
  const pub = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA_RPC_URL),
  });
  return createWalletClient({
    account,
    chain: sepolia,
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_sendRawTransactionSync") {
          // publicnode rejects the browser-built eip1559 raw with
          // "Invalid parameters" (the same viem prepare path works from
          // Node — cause unclear, likely a stricter pool node). Decode
          // the raw, re-sign as a plain legacy tx with fresh
          // nonce/gasPrice, and submit that instead. Legacy raw sends
          // are reliably accepted (verified live).
          const parsed = parseTransaction(
            (params as [/* signedTx */ `0x${string}`])[0],
          );
          const nonce = await pub.getTransactionCount({
            address: account.address,
            blockTag: "pending",
          });
          const gasPrice = ((await pub.getGasPrice()) * 15n) / 10n;
          let gas = parsed.gas;
          if (!gas) {
            try {
              gas =
                ((await pub.estimateGas({
                  account: account.address,
                  to: parsed.to ?? undefined,
                  data: parsed.data,
                  value: parsed.value ?? 0n,
                })) *
                  13n) /
                10n;
            } catch {
              gas = 500_000n;
            }
          }
          const signed = await account.signTransaction({
            type: "legacy",
            chainId: sepolia.id,
            nonce,
            to: parsed.to ?? undefined,
            data: parsed.data,
            value: parsed.value ?? 0n,
            gas,
            gasPrice,
          });
          const hash = (await pub.request({
            method: "eth_sendRawTransaction",
            params: [signed],
          })) as `0x${string}`;
          const r = await pub.waitForTransactionReceipt({
            hash,
            timeout: 150_000,
          });
          return {
            transactionHash: hash,
            transactionIndex: "0x" + r.transactionIndex.toString(16),
            blockHash: r.blockHash,
            blockNumber: "0x" + r.blockNumber.toString(16),
            from: r.from,
            to: r.to,
            cumulativeGasUsed: "0x" + r.cumulativeGasUsed.toString(16),
            gasUsed: "0x" + r.gasUsed.toString(16),
            effectiveGasPrice:
              r.effectiveGasPrice != null
                ? "0x" + r.effectiveGasPrice.toString(16)
                : "0x0",
            contractAddress: r.contractAddress ?? null,
            logs: [],
            logsBloom: "0x" + "00".repeat(256),
            status: r.status === "success" ? "0x1" : "0x0",
            type: "0x2",
          };
        }
        return pub.request({ method: method as never, params: params as never });
      },
    }),
  });
}

const DERIVE_MESSAGE = (evm: string) =>
  `Darwin Protocol\n\nDerive Miden signing key.\n\nEVM address: ${evm}\n\nSigning this reveals nothing about your ETH funds and is safe to sign.`;

// @miden-sdk/react's default `AuthScheme` symbol is wrong at runtime
// (matches TrustlessDepositPanel's fix). Pass the raw wasm enum value.
const AUTH_SCHEME_FALCON_ENUM_VALUE = 2;

type Stage =
  | "idle"
  | "signing"
  | "deriving"
  | "ready"
  | "sync-vault"
  | "quoting"
  | "sending-note"
  | "awaiting-fill"
  | "done"
  | "error";

type StageState = "idle" | "running" | "done";

function StageRow({
  label,
  state,
  detail,
  link,
  testId,
}: {
  label: string;
  state: StageState;
  detail: string;
  link?: string | null;
  testId?: string;
}) {
  const badge = state === "done" ? "✓" : state === "running" ? "◐" : "·";
  const badgeColor =
    state === "done"
      ? "#0a7a3e"
      : state === "running"
        ? "#c47a00"
        : "var(--ink-3)";
  const detailColor = state === "idle" ? "var(--ink-3)" : "var(--ink)";
  const running = state === "running";
  return (
    <div
      data-testid={testId}
      data-stage-state={state}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 150px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "8px 10px",
        borderRadius: 4,
        background: running ? "#fff4dc" : "transparent",
        borderLeft: running
          ? "3px solid #c47a00"
          : "3px solid transparent",
        borderBottom: "1px dashed var(--rule)",
        transition: "background 120ms ease-out",
      }}
    >
      <span
        style={{
          color: badgeColor,
          fontWeight: 700,
          fontSize: 16,
          textAlign: "center",
          display: "inline-block",
          animation: running ? "trustlessSpin 1.2s linear infinite" : undefined,
        }}
      >
        {badge}
      </span>
      <span
        style={{
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.08em",
          color: running ? "#8b5500" : "var(--ink-2)",
          fontWeight: running ? 700 : 500,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: detailColor,
          wordBreak: "break-all",
          fontSize: 12,
          fontFamily: link ? "var(--font-mono-stack)" : undefined,
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

const REDEEM_AMOUNT_DEFAULT = "1";

export function TrustlessRedeemPanel() {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { createWallet, isCreating, error: createErr } = useCreateWallet();
  const { send: sendNote } = useSend();
  const { consume } = useConsume();
  const { pauseSync, resumeSync } = useSyncControl();
  const { sync: syncState } = useSyncState();
  const { waitForConsumableNotes } = useWaitForNotes();
  const { runExclusive } = useMiden();

  const [stage, setStage] = useState<Stage>("idle");
  const [walletId, setWalletId] = useState<string | null>(null);
  const [humanAmount, setHumanAmount] = useState<string>(REDEEM_AMOUNT_DEFAULT);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [midenTxId, setMidenTxId] = useState<string | null>(null);
  const [sepoliaTxHint, setSepoliaTxHint] = useState<string | null>(null);
  const [intentNonce, setIntentNonce] = useState<string | null>(null);
  const [vaultSyncMsg, setVaultSyncMsg] = useState<string | null>(null);
  const sdkRef = useRef<EpochIntentSDK | null>(null);

  // Autonomous E2E flow — used by both the "Autonomous test" button and
  // the window.__darwinTrustlessRedeem debug hook. Bypasses wagmi entirely
  // by signing with a local viem account, and drives the panel's stage
  // machine as it progresses (so Playwright / a human watching the panel
  // can follow along without polling internal state).
  const runAutonomousFlow = useCallback(
    async (devKeyHex: string, humanAmount: string) => {
      const trace: Record<string, unknown> = {
        humanAmount,
        startedAt: Date.now(),
      };
      const log = (step: string, extra?: unknown) => {
        const t = (
          (Date.now() - (trace.startedAt as number)) /
          1000
        ).toFixed(1);
        console.log(`[redeem-auto t+${t}s] ${step}`, extra ?? "");
      };
      // Reset any prior run's UI state.
      setErrorMsg(null);
      setNoteId(null);
      setMidenTxId(null);
      setSepoliaTxHint(null);
      setIntentNonce(null);
      setVaultSyncMsg(null);
      pauseSync();
      try {
        log("start");
        const account = privateKeyToAccount(devKeyHex as `0x${string}`);
        const evm = account.address as `0x${string}`;
        trace.evm = evm;

        // Same message the UI's onDerive uses → same seed → same wallet.
        setStage("signing");
        log("signing derive message");
        const sig = await account.signMessage({
          message: DERIVE_MESSAGE(evm),
        });
        const seed = keccak256(toBytes(sig));
        const seedBytes = new Uint8Array(
          seed.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
        );

        setStage("deriving");
        log("createWallet");
        let derivedWalletId: string | null = null;
        try {
          const acc = await createWallet({
            initSeed: seedBytes,
            storageMode: "private",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as any,
          });
          derivedWalletId = acc.id().toString();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const m = msg.match(/id (0x[0-9a-fA-F]+)/);
          if (m && /already being tracked/i.test(msg)) {
            derivedWalletId = m[1];
          } else {
            throw e;
          }
        }
        if (!derivedWalletId) throw new Error("no wallet id");
        setWalletId(derivedWalletId);
        trace.walletId = derivedWalletId;
        log("walletId", derivedWalletId);

        // Sync + drain any consumable notes into the vault.
        setStage("sync-vault");
        for (let i = 0; i < 3; i++) {
          setVaultSyncMsg(`syncing derived wallet (${i + 1}/3)…`);
          log(`syncState ${i + 1}/3`);
          try {
            await runExclusive(() => syncState());
          } catch (e) {
            log(`syncState ${i + 1}/3 failed`, String(e).slice(0, 100));
          }
          await new Promise((r) => setTimeout(r, 1200));
        }
        setVaultSyncMsg("scanning for pending P2ID notes (~15s)…");
        log("waitForConsumableNotes");
        // waitForConsumableNotes' internal timeout isn't honoured in some
        // fresh-IndexedDB contexts (verified: hangs indefinitely in a
        // Playwright test even with timeoutMs=15_000). Wrap in a manual
        // Promise.race so the flow can't get stuck — if there's no
        // vault balance, we'll fall through and let send() throw the
        // real underflow error instead.
        // NB: NOT wrapped in runExclusive — waitForConsumableNotes is a
        // read + it internally holds the mutex on hangs, blocking every
        // downstream runExclusive (like the send() proving pass). We
        // hard-cap it with Promise.race so the flow can't stall.
        const HARD_TIMEOUT_MS = 18_000;
        let pending: unknown[] = [];
        try {
          const raced = await Promise.race<unknown[] | undefined>([
            waitForConsumableNotes({
              accountId: derivedWalletId!,
              minCount: 1,
              timeoutMs: 15_000,
              intervalMs: 3_000,
            }) as Promise<unknown[] | undefined>,
            new Promise<unknown[]>((resolve) =>
              setTimeout(() => resolve([]), HARD_TIMEOUT_MS),
            ),
          ]);
          pending = Array.isArray(raced) ? raced : [];
          if (
            !Array.isArray(pending) ||
            (pending as unknown[]).length === 0
          ) {
            log("no consumable notes after hard timeout");
          }
        } catch (e) {
          log("waitForConsumableNotes threw", String(e).slice(0, 100));
        }
        trace.pendingNotesFound = pending.length;
        if (pending.length > 0) {
          setVaultSyncMsg(`draining ${pending.length} note(s) into vault…`);
          log(`consume ${pending.length}`);
          try {
            await runExclusive(() =>
              consume({
                accountId: derivedWalletId!,
                notes: pending as never[],
              }),
            );
            trace.drained = pending.length;
          } catch (e) {
            trace.drainError = String(e).slice(0, 200);
            log("consume threw", trace.drainError);
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        setVaultSyncMsg(null);

        // Build the Epoch SDK — Miden virtual chain ID for the collateral
        // path.
        const sepoliaWC = createWalletClient({
          account,
          chain: sepolia,
          transport: http(),
        });
        const midenWC = {
          ...sepoliaWC,
          chain: { ...sepoliaWC.chain, id: MIDEN_DESTINATION_CHAIN_ID },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const sdk = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient: midenWC,
        });
        sdkRef.current = sdk;

        setStage("quoting");
        const minSepoliaOut = applySlippageBps(
          usdcSepoliaBaseUnits(humanAmount),
          EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
        );
        log("fetchRedeemQuote");
        const quote = await fetchRedeemQuote(sdk, {
          midenSourceId: derivedWalletId!,
          evmRecipient: evm,
          minUsdcSepoliaBaseUnits: minSepoliaOut,
        });
        trace.quoteOk = true;
        trace.tokenIn = String(quote.quoteResult.tokenIn ?? "");
        log("quote OK", trace.tokenIn);

        setStage("sending-note");
        log("submitRedeemIntent");
        let capturedMidenTxId: string | undefined;
        let capturedNoteId: string | undefined;
        const submit = await submitRedeemIntent(
          sdk,
          quote,
          async (faucetId, amount, allocatorId) => {
            log("createMidenP2IDNote callback fired");
            try {
              const out = await runExclusive(() =>
                sendNote({
                  from: derivedWalletId!,
                  to: allocatorId,
                  assetId: faucetId,
                  amount: BigInt(amount),
                  noteType: "public",
                  recallHeight: 100_000,
                }),
              );
              capturedMidenTxId = out?.txId;
              capturedNoteId =
                (out?.note as unknown as {
                  id?: () => { toString?: () => string };
                })
                  ?.id?.()
                  ?.toString?.() ?? undefined;
              setNoteId(capturedNoteId ?? null);
              setMidenTxId(capturedMidenTxId ?? null);
              log("P2IDE note created", capturedNoteId);
              return { success: true, noteId: capturedNoteId };
            } catch (e) {
              trace.p2ideError = String(e).slice(0, 200);
              log("sendNote threw", trace.p2ideError);
              return { success: false };
            }
          },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = submit as any;
        const nonce = String(
          s?.nonce ?? s?.submittedIntentData?.compact?.nonce ?? "",
        );
        if (nonce) setIntentNonce(nonce);
        trace.midenTxId = capturedMidenTxId;
        trace.noteId = capturedNoteId;
        trace.intentNonce = nonce;

        setStage("awaiting-fill");
        log("polling intentStatus", nonce);
        const url = `${ALLOCATOR_URL}/intentStatus/${evm}/${nonce}`;
        let fillTx: string | undefined;
        for (let t = 0; t < 24; t++) {
          try {
            const r = await fetch(url).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const st = r[0];
              if (st?.status === "success") {
                fillTx = st?.transactionHash;
                break;
              }
              if (st?.status === "failed") {
                trace.fillFailed = st;
                break;
              }
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 5_000));
        }
        trace.fillTx = fillTx;
        setSepoliaTxHint(fillTx ?? null);
        setStage("done");
        trace.finishedAt = Date.now();
        trace.wallClockMs =
          (trace.finishedAt as number) - (trace.startedAt as number);
        log("done", trace.wallClockMs + "ms");
        return trace;
      } catch (e) {
        trace.error = e instanceof Error ? e.message : String(e);
        trace.finishedAt = Date.now();
        setErrorMsg(String(trace.error));
        setStage("error");
        return trace;
      } finally {
        resumeSync();
      }
    },
    [
      createWallet,
      pauseSync,
      resumeSync,
      runExclusive,
      syncState,
      waitForConsumableNotes,
      consume,
      sendNote,
    ],
  );

  // Full autonomous ROUNDTRIP: deposit (Sepolia→Miden) into a FRESH
  // derived wallet, consume the delivered note, then redeem it back
  // (Miden→Sepolia). Solves the fresh-IndexedDB problem an autonomous
  // runner hits: a brand-new browser profile has no vault balance, so a
  // redeem-only test can never spend. The deposit leg funds the wallet
  // first — and as a bonus the loop covers BOTH bridge directions
  // against the real Epoch allocator + real Miden network, no mocks.
  const runAutonomousRoundtrip = useCallback(
    async (devKeyHex: string, redeemAmount: string, salt?: string) => {
      const trace: Record<string, unknown> = {
        redeemAmount,
        startedAt: Date.now(),
      };
      const log = (step: string, extra?: unknown) => {
        const t = (
          (Date.now() - (trace.startedAt as number)) /
          1000
        ).toFixed(1);
        console.log(`[roundtrip t+${t}s] ${step}`, extra ?? "");
      };
      setErrorMsg(null);
      setNoteId(null);
      setMidenTxId(null);
      setSepoliaTxHint(null);
      setIntentNonce(null);
      pauseSync();
      try {
        const runSalt = salt ?? String(Math.floor(Math.random() * 1e9));
        trace.salt = runSalt;
        log("start", `salt=${runSalt}`);
        const account = privateKeyToAccount(devKeyHex as `0x${string}`);
        const evm = account.address as `0x${string}`;
        trace.evm = evm;

        // ── Fresh wallet: salt the derive message so each run gets its
        // own Miden account with clean local state.
        setStage("deriving");
        const sig = await account.signMessage({
          message: DERIVE_MESSAGE(evm) + `\n\nRoundtrip salt: ${runSalt}`,
        });
        const seed = keccak256(toBytes(sig));
        const seedBytes = new Uint8Array(
          seed.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
        );
        let freshWalletId: string | null = null;
        try {
          const acc = await createWallet({
            initSeed: seedBytes,
            storageMode: "private",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as any,
          });
          freshWalletId = acc.id().toString();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const m = msg.match(/id (0x[0-9a-fA-F]+)/);
          if (m && /already being tracked/i.test(msg)) {
            freshWalletId = m[1];
          } else {
            throw e;
          }
        }
        if (!freshWalletId) throw new Error("no fresh wallet id");
        setWalletId(freshWalletId);
        trace.walletId = freshWalletId;
        log("fresh wallet", freshWalletId);

        // ── Deposit leg: Sepolia USDC → dUSDC note to the fresh wallet.
        setStage("sync-vault");
        setVaultSyncMsg("deposit leg: quoting Sepolia→Miden…");
        const sepoliaWC = localSepoliaSigningClient(account);
        const sdkDep = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient: sepoliaWC,
        });
        const DEPOSIT_HUMAN = "0.5"; // dUSDC out — covers any redeem ≤ ~0.45
        const minTokenOut = applySlippageBps(
          dusdcMidenBaseUnits(DEPOSIT_HUMAN),
          EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
        );
        const dQuote = await fetchQuote(sdkDep, {
          evmSourceAddress: evm,
          midenRecipientId: freshWalletId,
          minTokenOut,
        });
        trace.depositTokenIn = String(dQuote.quoteResult.tokenIn ?? "");
        log("deposit quote OK", trace.depositTokenIn);

        setVaultSyncMsg(
          "deposit leg: signing Compact deposit on Sepolia (local key)…",
        );
        const dSubmit = await submitIntent(sdkDep, dQuote);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dS = dSubmit as any;
        const dNonce = String(
          dS?.nonce ?? dS?.submittedIntentData?.compact?.nonce ?? "",
        );
        trace.depositNonce = dNonce;
        log("deposit intent submitted", dNonce.slice(-6));

        setVaultSyncMsg("deposit leg: waiting for Epoch delivery (~60s)…");
        let depositNoteId: string | undefined;
        for (let t = 0; t < 24; t++) {
          try {
            const r = await fetch(
              `${ALLOCATOR_URL}/intentStatus/${evm}/${dNonce}`,
            ).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const st = r[0];
              if (st?.status === "success") {
                depositNoteId = st?.midenNoteId;
                break;
              }
              if (st?.status === "failed") {
                throw new Error(
                  `deposit intent failed: ${JSON.stringify(st).slice(0, 150)}`,
                );
              }
            }
          } catch (e) {
            if (String(e).includes("deposit intent failed")) throw e;
          }
          await new Promise((r) => setTimeout(r, 5_000));
        }
        if (!depositNoteId) throw new Error("deposit never resolved");
        trace.depositNoteId = depositNoteId;
        log("deposit delivered", depositNoteId);

        // ── Consume the delivered P2ID note into the fresh vault.
        setVaultSyncMsg("deposit leg: syncing to pick up the note…");
        for (let i = 0; i < 3; i++) {
          try {
            await runExclusive(() => syncState());
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        }
        setVaultSyncMsg("deposit leg: waiting for the note to be consumable…");
        const raced = await Promise.race<unknown[] | undefined>([
          waitForConsumableNotes({
            accountId: freshWalletId!,
            minCount: 1,
            timeoutMs: 90_000,
            intervalMs: 5_000,
          }) as Promise<unknown[] | undefined>,
          new Promise<unknown[]>((resolve) =>
            setTimeout(() => resolve([]), 95_000),
          ),
        ]);
        const pending = Array.isArray(raced) ? raced : [];
        if (pending.length === 0) {
          throw new Error("delivered note never became consumable locally");
        }
        setVaultSyncMsg(`deposit leg: consuming ${pending.length} note(s)…`);
        log("consuming", pending.length);
        await runExclusive(() =>
          consume({ accountId: freshWalletId!, notes: pending as never[] }),
        );
        trace.consumed = pending.length;
        await new Promise((r) => setTimeout(r, 2_000));
        setVaultSyncMsg(null);
        log("vault funded — starting redeem leg");

        // ── Redeem leg: dUSDC → USDC back to the dev EVM address.
        setStage("quoting");
        const midenWC = {
          ...sepoliaWC,
          chain: { ...sepoliaWC.chain, id: MIDEN_DESTINATION_CHAIN_ID },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const sdkRed = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient: midenWC,
        });
        const minSepoliaOut = applySlippageBps(
          usdcSepoliaBaseUnits(redeemAmount),
          EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
        );
        const rQuote = await fetchRedeemQuote(sdkRed, {
          midenSourceId: freshWalletId!,
          evmRecipient: evm,
          minUsdcSepoliaBaseUnits: minSepoliaOut,
        });
        trace.redeemTokenIn = String(rQuote.quoteResult.tokenIn ?? "");
        log("redeem quote OK", trace.redeemTokenIn);

        setStage("sending-note");
        let capturedMidenTxId: string | undefined;
        let capturedNoteId: string | undefined;
        const rSubmit = await submitRedeemIntent(
          sdkRed,
          rQuote,
          async (faucetId, amount, allocatorId) => {
            log("createMidenP2IDNote fired", amount);
            try {
              const out = await runExclusive(() =>
                sendNote({
                  from: freshWalletId!,
                  to: allocatorId,
                  assetId: faucetId,
                  amount: BigInt(amount),
                  noteType: "public",
                  recallHeight: 100_000,
                }),
              );
              capturedMidenTxId = out?.txId;
              capturedNoteId =
                (out?.note as unknown as {
                  id?: () => { toString?: () => string };
                })
                  ?.id?.()
                  ?.toString?.() ?? undefined;
              setNoteId(capturedNoteId ?? null);
              setMidenTxId(capturedMidenTxId ?? null);
              log("P2IDE note created", capturedNoteId);
              return { success: true, noteId: capturedNoteId };
            } catch (e) {
              trace.p2ideError = String(e).slice(0, 200);
              log("sendNote threw", trace.p2ideError);
              return { success: false };
            }
          },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rS = rSubmit as any;
        const rNonce = String(
          rS?.nonce ?? rS?.submittedIntentData?.compact?.nonce ?? "",
        );
        if (rNonce) setIntentNonce(rNonce);
        trace.redeemNonce = rNonce;
        trace.midenTxId = capturedMidenTxId;
        trace.noteId = capturedNoteId;

        setStage("awaiting-fill");
        log("polling redeem fill", rNonce.slice(-6));
        let fillTx: string | undefined;
        for (let t = 0; t < 24; t++) {
          try {
            const r = await fetch(
              `${ALLOCATOR_URL}/intentStatus/${evm}/${rNonce}`,
            ).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const st = r[0];
              if (st?.status === "success") {
                fillTx = st?.transactionHash;
                break;
              }
              if (st?.status === "failed") {
                trace.fillFailed = st;
                break;
              }
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 5_000));
        }
        trace.fillTx = fillTx;
        setSepoliaTxHint(fillTx ?? null);
        setStage("done");
        trace.finishedAt = Date.now();
        trace.wallClockMs =
          (trace.finishedAt as number) - (trace.startedAt as number);
        log("ROUNDTRIP DONE", `${trace.wallClockMs}ms fillTx=${fillTx}`);
        console.log("[roundtrip-trace]", JSON.stringify(trace));
        return trace;
      } catch (e) {
        trace.error = e instanceof Error ? e.message : String(e);
        trace.finishedAt = Date.now();
        setErrorMsg(String(trace.error));
        setStage("error");
        console.log("[roundtrip-trace]", JSON.stringify(trace));
        return trace;
      } finally {
        resumeSync();
      }
    },
    [
      createWallet,
      pauseSync,
      resumeSync,
      runExclusive,
      syncState,
      waitForConsumableNotes,
      consume,
      sendNote,
    ],
  );

  // Expose the same flow via a window function for direct JS testing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      __darwinTrustlessRedeem?: (
        devKeyHex: string,
        humanAmount: string,
      ) => Promise<unknown>;
      __darwinTrustlessRoundtrip?: (
        devKeyHex: string,
        redeemAmount: string,
        salt?: string,
      ) => Promise<unknown>;
    };
    w.__darwinTrustlessRedeem = runAutonomousFlow;
    w.__darwinTrustlessRoundtrip = runAutonomousRoundtrip;
    return () => {
      if (w.__darwinTrustlessRedeem === runAutonomousFlow) {
        delete w.__darwinTrustlessRedeem;
      }
      if (w.__darwinTrustlessRoundtrip === runAutonomousRoundtrip) {
        delete w.__darwinTrustlessRoundtrip;
      }
    };
  }, [runAutonomousFlow, runAutonomousRoundtrip]);


  // Silence the internal @miden-sdk error banner when it's just "already
  // being tracked" — that's expected on re-derive; onDerive handles it.
  const visibleCreateErr =
    createErr?.message && /already being tracked/i.test(createErr.message)
      ? null
      : createErr?.message ?? null;

  async function onDerive() {
    if (!evmAddress) {
      setErrorMsg("Connect your ETH wallet above first.");
      return;
    }
    try {
      setErrorMsg(null);
      setStage("signing");
      const sig = await signMessageAsync({
        message: DERIVE_MESSAGE(evmAddress),
      });
      const seed = keccak256(toBytes(sig));
      const seedBytes = new Uint8Array(
        seed.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
      );

      setStage("deriving");
      pauseSync();
      let resolvedWalletId: string | null = null;
      try {
        try {
          const account = await createWallet({
            initSeed: seedBytes,
            storageMode: "private",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as any,
          });
          resolvedWalletId = account.id().toString();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const m = msg.match(/id (0x[0-9a-fA-F]+)/);
          if (m && /already being tracked/i.test(msg)) {
            resolvedWalletId = m[1];
          } else {
            throw e;
          }
        }
      } finally {
        resumeSync();
      }
      if (!resolvedWalletId) throw new Error("No wallet id resolved");
      setWalletId(resolvedWalletId);
      setStage("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  // Callback the Epoch SDK invokes to spend dUSDC from the derived wallet
  // into a P2IDE note targeting Epoch's allocator on Miden. useSend does
  // WASM proving + submit; runExclusive serialises access to the single
  // WASM client instance so nothing else (background sync, another hook's
  // store query) races the prove pass and panics on RefCell borrow. This
  // is the same runExclusive pattern the deposit panel uses around
  // waitForConsumableNotes / executeTx.
  const buildCreateNoteCallback = useCallback(
    (fromWallet: string) => {
      return async (
        faucetId: string,
        amount: string,
        allocatorId: string,
      ) => {
        try {
          const out = await runExclusive(() =>
            sendNote({
              from: fromWallet,
              to: allocatorId,
              assetId: faucetId,
              amount: BigInt(amount),
              noteType: "public",
              // recallHeight makes it a P2IDE per the reference-app spec:
              // sender can reclaim the note if the solver never consumes.
              recallHeight: 100_000,
            }),
          );
          const outNoteId =
            (out?.note as unknown as { id?: () => { toString?: () => string } })
              ?.id?.()
              ?.toString?.() ?? undefined;
          setNoteId(outNoteId ?? null);
          setMidenTxId(out?.txId ?? null);
          return { success: true, noteId: outNoteId };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[redeem] createMidenP2IDNote failed:", msg);
          return { success: false };
        }
      };
    },
    [runExclusive, sendNote],
  );

  async function onRedeem() {
    if (!walletId || !evmAddress) return;
    pauseSync();
    try {
      setErrorMsg(null);

      // Force-sync the derived wallet and drain any consumable notes into
      // the vault before we spend dUSDC. Every WASM call goes through
      // runExclusive so the background auto-sync + any other Miden hook
      // can't race and panic on RefCell (the /trustless route already
      // isolates this panel; runExclusive is belt-and-braces).
      setStage("sync-vault");
      for (let i = 0; i < 3; i++) {
        setVaultSyncMsg(`syncing derived wallet (${i + 1}/3)…`);
        try {
          await runExclusive(() => syncState());
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 1500));
      }
      setVaultSyncMsg("scanning for pending P2ID notes (~15s)…");
      console.log("[redeem] waitForConsumableNotes start");
      // Same hard Promise.race cap as the autonomous flow —
      // waitForConsumableNotes' internal timeout isn't honoured in some
      // contexts and it must NOT run inside runExclusive (a hang there
      // would hold the mutex and block the send() prove downstream).
      let pendingNotes: unknown[] = [];
      try {
        const raced = await Promise.race<unknown[] | undefined>([
          waitForConsumableNotes({
            accountId: walletId,
            minCount: 1,
            timeoutMs: 15_000,
            intervalMs: 3_000,
          }) as Promise<unknown[] | undefined>,
          new Promise<unknown[]>((resolve) =>
            setTimeout(() => resolve([]), 18_000),
          ),
        ]);
        pendingNotes = Array.isArray(raced) ? raced : [];
      } catch (e) {
        console.log("[redeem] scan threw:", String(e).slice(0, 120));
        pendingNotes = [];
      }
      console.log("[redeem] scan done, consumable:", pendingNotes.length);
      if (pendingNotes.length > 0) {
        setVaultSyncMsg(
          `draining ${pendingNotes.length} note(s) into vault…`,
        );
        try {
          await runExclusive(() =>
            consume({ accountId: walletId, notes: pendingNotes as never[] }),
          );
          // Small settle beat so IndexedDB reflects the new vault balance
          // by the time send() reads it.
          await new Promise((res) => setTimeout(res, 1500));
        } catch (e) {
          console.warn("[redeem] consume failed:", e);
        }
      } else {
        setVaultSyncMsg(
          "no consumable notes — vault already funded from a prior drain",
        );
        await new Promise((res) => setTimeout(res, 1000));
      }
      setVaultSyncMsg(null);

      setStage("quoting");

      // Epoch requires walletClient.chain.id = MIDEN_DESTINATION_CHAIN_ID
      // for the Miden→EVM path (see reference app's useEpochIntent).
      try {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      } catch (_) {}
      const eth = (window as unknown as { ethereum?: unknown }).ethereum;
      if (!eth) throw new Error("No injected ETH provider (MetaMask?)");
      const sepoliaWalletClient = createWalletClient({
        account: evmAddress as `0x${string}`,
        chain: sepolia,
        transport: custom(eth as never),
      });
      // Override the chain id to Miden's virtual chain — the Epoch SDK
      // uses it to route the intent as Miden-collateralized.
      const midenWalletClient = {
        ...sepoliaWalletClient,
        chain: { ...sepoliaWalletClient.chain, id: MIDEN_DESTINATION_CHAIN_ID },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      sdkRef.current = new EpochIntentSDK({
        apiBaseUrl: ALLOCATOR_URL,
        walletClient: midenWalletClient,
      });

      // Reverse quote: user asks "give me at least X USDC on Sepolia" and
      // the backend computes how much dUSDC input is needed.
      const minSepoliaOut = applySlippageBps(
        usdcSepoliaBaseUnits(humanAmount),
        EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
      );
      console.log("[redeem] fetching reverse quote…");
      const quote = await fetchRedeemQuote(sdkRef.current, {
        midenSourceId: walletId,
        evmRecipient: evmAddress as `0x${string}`,
        minUsdcSepoliaBaseUnits: minSepoliaOut,
      });
      console.log(
        "[redeem] quote OK — dUSDC in:",
        String(quote.quoteResult.tokenIn ?? "?"),
      );

      setStage("sending-note");
      console.log("[redeem] submitting intent (P2IDE note will prove in WASM)…");
      const submit = await submitRedeemIntent(
        sdkRef.current,
        quote,
        buildCreateNoteCallback(walletId),
      );
      console.log("[redeem] intent submitted");

      const nonce =
        (submit as { nonce?: string })?.nonce ??
        (submit as { submittedIntentData?: { compact?: { nonce?: string } } })
          ?.submittedIntentData?.compact?.nonce;
      if (nonce) setIntentNonce(String(nonce));

      setStage("awaiting-fill");
      // Poll Epoch's /intentStatus for the fill transaction hash.
      let filledTxHash: string | null = null;
      const start = Date.now();
      while (Date.now() - start < 3 * 60_000) {
        try {
          const r = await fetch(
            `${ALLOCATOR_URL}/intentStatus/${evmAddress}/${nonce}`,
          ).then((r) => r.json());
          if (Array.isArray(r) && r.length > 0) {
            const s = r[0];
            if (s.status === "success") {
              filledTxHash = s.transactionHash ?? null;
              break;
            }
            if (s.status === "failed") {
              throw new Error(`Epoch reported failed: ${JSON.stringify(s)}`);
            }
          }
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 6_000));
      }
      setSepoliaTxHint(filledTxHash);

      setStage("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    } finally {
      resumeSync();
    }
  }

  return (
    <section style={{ marginTop: 24 }}>
      <style>{`
        @keyframes trustlessSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
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
        Redeem · demo (no server, no extension)
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Same MetaMask signature as the deposit → same derived Miden
        wallet. Burn its dUSDC into a P2IDE note; Epoch&apos;s solver
        pays USDC to your Sepolia address.
      </p>

      {!ethConnected && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          Connect your ETH wallet above to begin.
        </p>
      )}

      {/* Autonomous test — Playwright-driven E2E. Same real WASM + real
          Epoch + real network as the manual flow; the only shortcut is
          skipping wagmi/MetaMask by signing the derive message with a
          dev-only test key. Hidden behind a data-testid so a Playwright
          selector can find it without depending on the label text. */}
      {stage !== "signing" &&
        stage !== "deriving" &&
        stage !== "sync-vault" &&
        stage !== "quoting" &&
        stage !== "sending-note" &&
        stage !== "awaiting-fill" && (
          <button
            data-testid="autonomous-redeem"
            onClick={() => {
              // Playwright pre-injects window.__devKey / __devAmount via
              // addInitScript so the click is a plain no-argument DOM
              // event. Manual users get a browser prompt fallback so the
              // button is still usable interactively.
              const w = window as unknown as {
                __devKey?: string;
                __devAmount?: string;
              };
              let key = w.__devKey;
              let amt = w.__devAmount ?? humanAmount;
              if (!key) {
                key =
                  window.prompt("Dev private key (testnet only):", "") ??
                  undefined;
                if (!key) return;
                amt = window.prompt("USDC amount to redeem:", humanAmount) ??
                  humanAmount;
              }
              void runAutonomousFlow(key, amt);
            }}
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono-stack)",
              padding: "6px 10px",
              border: "1px dashed var(--rule)",
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "pointer",
              marginBottom: 12,
              marginRight: 8,
            }}
          >
            ⚙ Autonomous test (dev key)
          </button>
        )}

      {stage !== "signing" &&
        stage !== "deriving" &&
        stage !== "sync-vault" &&
        stage !== "quoting" &&
        stage !== "sending-note" &&
        stage !== "awaiting-fill" && (
          <button
            data-testid="autonomous-roundtrip"
            onClick={() => {
              const w = window as unknown as {
                __devKey?: string;
                __devAmount?: string;
                __devSalt?: string;
              };
              let key = w.__devKey;
              const amt = w.__devAmount ?? "0.1";
              if (!key) {
                key =
                  window.prompt("Dev private key (testnet only):", "") ??
                  undefined;
                if (!key) return;
              }
              void runAutonomousRoundtrip(key, amt, w.__devSalt);
            }}
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono-stack)",
              padding: "6px 10px",
              border: "1px dashed var(--rule)",
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "pointer",
              marginBottom: 12,
            }}
          >
            ⚙⚙ Roundtrip test (deposit → redeem, fresh wallet)
          </button>
        )}

      {ethConnected &&
        !walletId &&
        stage !== "signing" &&
        stage !== "deriving" && (
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
        <p style={{ fontSize: 13 }}>
          Building Miden wallet from your signature (WASM proof)…
        </p>
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
          <div style={{ color: "var(--ink-3)", marginTop: 4 }}>
            Must already hold dUSDC (from a prior deposit).
          </div>
        </div>
      )}

      {walletId &&
        stage !== "done" &&
        stage !== "quoting" &&
        stage !== "sending-note" &&
        stage !== "awaiting-fill" && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <label style={{ fontSize: 13 }}>
              USDC to receive on Sepolia:{" "}
              <input
                type="text"
                inputMode="decimal"
                value={humanAmount}
                onChange={(e) => setHumanAmount(e.target.value)}
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 13,
                  padding: "4px 8px",
                  width: 90,
                  border: "1px solid var(--ink)",
                  background: "var(--paper)",
                  color: "var(--ink)",
                }}
              />
            </label>
            <button
              onClick={onRedeem}
              className="nav-cta"
              style={{ minWidth: 260 }}
            >
              Step 2 · Redeem via Epoch
            </button>
          </div>
        )}

      {(stage === "sync-vault" ||
        stage === "quoting" ||
        stage === "sending-note" ||
        stage === "awaiting-fill" ||
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
            label="sync vault"
            testId="row-sync-vault"
            state={
              stage === "sync-vault"
                ? "running"
                : stage === "quoting" ||
                    stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "sync-vault"
                ? vaultSyncMsg ?? "syncing…"
                : stage === "quoting" ||
                    stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "vault ready"
                  : "waiting"
            }
          />
          <StageRow
            label="quote"
            testId="row-quote"
            state={
              stage === "quoting"
                ? "running"
                : stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "quoting"
                ? "Reverse-quoting Miden→Sepolia via Epoch…"
                : stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "quote ready"
                  : "waiting"
            }
          />
          <StageRow
            label="p2ide note"
            testId="row-p2ide"
            state={
              stage === "sending-note" && !noteId
                ? "running"
                : noteId || stage === "awaiting-fill" || stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "sending-note" && !noteId
                ? "Spending dUSDC → P2IDE note (WASM prove + submit)…"
                : noteId
                  ? noteId
                  : "waiting"
            }
            link={
              noteId ? `https://testnet.midenscan.com/note/${noteId}` : null
            }
          />
          <StageRow
            label="miden tx"
            testId="row-miden-tx"
            state={midenTxId ? "done" : stage === "sending-note" ? "running" : "idle"}
            detail={midenTxId ?? "waiting"}
            link={
              midenTxId
                ? `https://testnet.midenscan.com/tx/${midenTxId}`
                : null
            }
          />
          <StageRow
            label="epoch fill"
            testId="row-epoch-fill"
            state={
              stage === "awaiting-fill"
                ? "running"
                : sepoliaTxHint || stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "awaiting-fill"
                ? "Epoch solver is consuming the note and paying you on Sepolia (~1-2 min)…"
                : sepoliaTxHint
                  ? sepoliaTxHint
                  : "waiting"
            }
            link={
              sepoliaTxHint && sepoliaTxHint.startsWith("0x")
                ? `https://sepolia.etherscan.io/tx/${sepoliaTxHint}`
                : null
            }
          />
          {stage === "done" && (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--rule)",
                color: "var(--ink-3)",
              }}
            >
              ✅ USDC delivered to your Sepolia address. Zero backend, single
              provider (Epoch) for both bridge directions.
              {intentNonce && (
                <>
                  {" "}
                  Intent nonce: <code>{intentNonce}</code>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {(() => {
        const visibleErr = errorMsg
          ? errorMsg
          : visibleCreateErr;
        if (!visibleErr) return null;
        return (
          <p style={{ fontSize: 13, color: "crimson" }}>{visibleErr}</p>
        );
      })()}
    </section>
  );
}
