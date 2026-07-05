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
 * 3. User funds the wallet with mBND once (via faucet.testnet.miden.io
 *    or an in-page drip). Needed because Miden 0.15 has no paymaster —
 *    the wallet pays its own tx fees. Bootstrap-only.
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
  useConsume,
  useCreateWallet,
  useNotes,
  useSyncControl,
  useSyncState,
  useWaitForNotes,
} from "@miden-sdk/react";
import { useAccount, useSignMessage } from "wagmi";
import { useEffect, useMemo, useRef, useState } from "react";
import { keccak256, parseUnits, toBytes } from "viem";

import { EPOCH_DUSDC_FAUCET_ID, TRUSTLESS_CONTROLLER_HEX } from "../lib/midenConstants";
import {
  ALLOCATOR_URL,
  applySlippageBps,
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
  EPOCH_USDC_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  dusdcMidenBaseUnits,
  fetchQuote,
  submitIntent,
  usdcSepoliaBaseUnits,
} from "../lib/epoch";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";
import { createWalletClient, custom } from "viem";
import { sepolia } from "viem/chains";
import { useSwitchChain } from "wagmi";

const DERIVE_MESSAGE = (evm: string) =>
  `Darwin Protocol\n\nDerive Miden signing key.\n\nEVM address: ${evm}\n\nSigning this reveals nothing about your ETH funds and is safe to sign.`;

type Stage =
  | "idle"
  | "signing"
  | "deriving"
  | "ready"
  | "quoting"
  | "signing-sepolia"
  | "awaiting-delivery"
  | "consuming"
  | "done"
  | "error";

const HUMAN_AMOUNT_DEFAULT = "1";

export function TrustlessDepositPanel() {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const { createWallet, wallet, isCreating, error: createErr, reset } =
    useCreateWallet();
  const { consume, isLoading: isConsuming } = useConsume();
  const { waitForConsumableNotes } = useWaitForNotes();
  useSyncControl();

  const [stage, setStage] = useState<Stage>("idle");
  const [seedHex, setSeedHex] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [humanAmount, setHumanAmount] = useState<string>(HUMAN_AMOUNT_DEFAULT);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sepoliaTx, setSepoliaTx] = useState<string | null>(null);
  const [midenNoteId, setMidenNoteId] = useState<string | null>(null);
  const [consumeTx, setConsumeTx] = useState<string | null>(null);
  const sdkRef = useRef<EpochIntentSDK | null>(null);

  useSyncState();
  const notesResult = useNotes({ accountId: walletId ?? undefined });

  const inboundNotesCount = useMemo(() => {
    if (!notesResult || !walletId) return null;
    return notesResult.notes?.length ?? 0;
  }, [notesResult, walletId]);

  async function onDerive() {
    if (!evmAddress) {
      setErrorMsg("Connect your ETH wallet above first.");
      return;
    }
    try {
      setErrorMsg(null);
      setStage("signing");
      const sig = await signMessageAsync({ message: DERIVE_MESSAGE(evmAddress) });
      const seed = keccak256(toBytes(sig));
      setSeedHex(seed);
      const seedBytes = new Uint8Array(
        seed.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
      );

      setStage("deriving");
      const account = await createWallet({
        initSeed: seedBytes,
        storageMode: "public",
      });
      setWalletId(account.id().toString());
      setStage("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  async function onDeposit() {
    if (!walletId || !evmAddress) return;
    try {
      setErrorMsg(null);
      setStage("quoting");

      // Ensure user is on Sepolia for the Compact deposit tx.
      try {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      } catch (_) {}

      // Build the Epoch SDK on top of the injected provider so the
      // user's own MetaMask signs the Sepolia deposit tx.
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

      const minTokenOut = applySlippageBps(
        dusdcMidenBaseUnits(humanAmount),
        EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
      );
      const quote = await fetchQuote(sdkRef.current, {
        evmSourceAddress: evmAddress as `0x${string}`,
        midenRecipientId: walletId,
        minTokenOut,
      });
      setStage("signing-sepolia");
      const submit = await submitIntent(sdkRef.current, quote);
      // solveIntent's shape varies — extract what we can.
      const depTx = (submit as { transactionHash?: string })?.transactionHash;
      setSepoliaTx(depTx ?? null);

      setStage("awaiting-delivery");
      // Poll for the incoming dUSDC note.
      const delivered = await waitForConsumableNotes({
        accountId: walletId,
        minCount: 1,
        timeoutMs: 180_000,
        intervalMs: 5_000,
      });
      const inbound = delivered?.[0];
      const noteId =
        (inbound as unknown as { id?: () => { toString?: () => string } })
          ?.id?.()
          ?.toString?.() ?? null;
      setMidenNoteId(noteId);

      setStage("consuming");
      const consumeResult = await consume({
        accountId: walletId,
        notes: inbound ? [inbound] : [],
      });
      setConsumeTx(consumeResult?.transactionId?.toString?.() ?? null);

      setStage("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
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
        Trustless deposit · demo (no server, no extension)
      </h2>

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
            <strong>Derived seed</strong>: <code>{seedHex}</code>
          </div>
          <div>
            <strong>Derived Miden wallet</strong>: <code>{walletId}</code>
          </div>
          <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
            Fund it with a bit of MIDEN once (bootstrap gas) via{" "}
            <a href="https://faucet.testnet.miden.io/" target="_blank" rel="noreferrer">
              faucet.testnet.miden.io
            </a>{" "}
            then deposit below.
          </div>
        </div>
      )}

      {walletId && stage !== "done" && stage !== "quoting" && stage !== "signing-sepolia" && stage !== "awaiting-delivery" && stage !== "consuming" && (
        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, marginRight: 12 }}>Amount (USDC):</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={humanAmount}
            onChange={(e) => setHumanAmount(e.target.value)}
            style={{
              fontFamily: "var(--font-mono-stack)",
              padding: "4px 8px",
              width: 100,
              marginRight: 12,
            }}
          />
          <button onClick={onDeposit} className="nav-cta" style={{ minWidth: 220 }}>
            Step 2 · Deposit via Epoch
          </button>
        </div>
      )}

      {stage === "quoting" && <p style={{ fontSize: 13 }}>Getting Epoch quote…</p>}
      {stage === "signing-sepolia" && (
        <p style={{ fontSize: 13 }}>Sign the Compact deposit tx on Sepolia in your ETH wallet…</p>
      )}
      {stage === "awaiting-delivery" && (
        <p style={{ fontSize: 13 }}>
          Waiting for Epoch to deliver dUSDC on Miden (~30–60s)…
        </p>
      )}
      {stage === "consuming" && (
        <p style={{ fontSize: 13 }}>Consuming the inbound note into your derived wallet (in-browser proof)…</p>
      )}

      {stage === "done" && (
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
          <div>
            <strong>Sepolia deposit tx</strong>: <code>{sepoliaTx}</code>
          </div>
          <div>
            <strong>Miden note delivered</strong>: <code>{midenNoteId}</code>
          </div>
          <div>
            <strong>Consumed at tx</strong>: <code>{consumeTx}</code>
          </div>
          <div style={{ marginTop: 8, color: "var(--ink-3)" }}>
            dUSDC now lives in your derived wallet vault, in-browser. No
            server holds anything. Next step (position credit on v8-noauth)
            posts a note-consume tx against the trustless controller — that
            controller accepts unsigned txs (NoAuth), so the browser can
            submit it directly.
          </div>
        </div>
      )}

      {(errorMsg || createErr) && (
        <p style={{ fontSize: 13, color: "crimson" }}>
          {errorMsg ?? createErr?.message}
        </p>
      )}

      {stage === "ready" && (
        <button
          onClick={() => {
            reset();
            setStage("idle");
            setSeedHex(null);
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

      {process.env.NODE_ENV !== "production" && inboundNotesCount !== null && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 12 }}>
          [debug] notes tracked on wallet: {inboundNotesCount}
        </p>
      )}
    </section>
  );
}
