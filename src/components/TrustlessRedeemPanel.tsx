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
import { useCallback, useRef, useState } from "react";
import { createWalletClient, custom, keccak256, toBytes } from "viem";
import { sepolia } from "viem/chains";
import { useAccount, useSignMessage, useSwitchChain } from "wagmi";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";

import {
  ALLOCATOR_URL,
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
  MIDEN_DESTINATION_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  applySlippageBps,
  fetchRedeemQuote,
  submitRedeemIntent,
  usdcSepoliaBaseUnits,
} from "../lib/epoch";

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
  const detailColor = state === "idle" ? "var(--ink-3)" : "var(--ink)";
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
      setVaultSyncMsg("scanning for pending P2ID notes (up to 60s)…");
      let pendingNotes: unknown[] = [];
      try {
        pendingNotes =
          (await runExclusive(() =>
            waitForConsumableNotes({
              accountId: walletId,
              minCount: 1,
              timeoutMs: 60_000,
              intervalMs: 5_000,
            }),
          )) ?? [];
      } catch (_) {
        pendingNotes = [];
      }
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
      const quote = await fetchRedeemQuote(sdkRef.current, {
        midenSourceId: walletId,
        evmRecipient: evmAddress as `0x${string}`,
        minUsdcSepoliaBaseUnits: minSepoliaOut,
      });

      setStage("sending-note");
      const submit = await submitRedeemIntent(
        sdkRef.current,
        quote,
        buildCreateNoteCallback(walletId),
      );

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
    <section style={{ marginTop: 48 }}>
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
        Trustless redeem · Miden → Sepolia
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Reverse path — burn dUSDC from your derived Miden wallet into a
        P2IDE note targeting Epoch&apos;s allocator; the Epoch solver
        consumes it and pays USDC to your Sepolia address. No Sepolia tx
        on your side, no Darwin backend.
      </p>

      {!ethConnected && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          Connect your ETH wallet above to begin.
        </p>
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
                : "vault ready (pending notes drained)"
            }
          />
          <StageRow
            label="quote"
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
                : "quote ready"
            }
          />
          <StageRow
            label="p2ide note"
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
