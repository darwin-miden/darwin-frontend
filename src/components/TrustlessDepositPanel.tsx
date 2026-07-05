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
  useCompile,
  useConsume,
  useCreateWallet,
  useMiden,
  useSyncControl,
  useTransaction,
  useWaitForNotes,
} from "@miden-sdk/react";
import { TransactionRequestBuilder } from "@miden-sdk/miden-sdk";

// The @miden-sdk/miden-sdk module ships TWO exports named `AuthScheme`:
//   1. `AuthScheme` as a TS-`enum` from the WASM binding
//      (AuthEcdsaK256Keccak=1, AuthRpoFalcon512=2)
//   2. `AuthScheme` as a `const { Falcon: "falcon", ECDSA: "ecdsa" }`
//      from api-types.d.ts — the one the runtime actually uses.
// TypeScript resolves the import to #1 (enum wins over const in
// export-shadow order), which doesn't have `.Falcon`. Meanwhile
// @miden-sdk/react's `DEFAULTS.AUTH_SCHEME = AuthScheme.AuthRpoFalcon512`
// evaluates against the runtime #2 and returns `undefined`, so any
// createWallet call that inherits the default throws
// "invalid enum value passed" in wasm_bindgen.
// Hard-code the runtime string here to bypass both traps.
const AUTH_SCHEME_FALCON = "falcon" as const;
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
  | "crediting"
  | "done"
  | "error";

// MAST root of `set_user_position` on the v6/v7/v8 controller. Same MASM
// deployed under all three; the root is stable across auth-component
// variants (v7 SingleSig, v8 NoAuth, v8-network).
const SET_USER_POSITION_MAST =
  "0xea652ac9aa1b6ee468da0845b52008ffa4639d112f356534ba608bc00d7b6f5f";

// EVM address → (user_id_suffix, user_id_prefix) — same encoding the
// worker uses (bytes 12..20 = suffix, bytes 4..12 = prefix, both LE u64
// masked to 63 bits so they fit inside a Miden Felt).
function evmToUserIdFelts(evmAddr: string): { suffix: bigint; prefix: bigint } {
  const hex = evmAddr.replace(/^0x/, "").toLowerCase();
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const readLE = (start: number) => {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(bytes[start + i]) << BigInt(8 * i);
    return v & ((1n << 63n) - 1n);
  };
  return { suffix: readLE(12), prefix: readLE(4) };
}

// The tx script that runs against v8-noauth to write slot-10 for a
// specific (user_id, amount). Direct `set_user_position` call — no
// asset receive, no NAV math. That short-circuit is the whole point
// of the demo: with NoAuth on the controller anyone can submit this
// tx bundle without holding any signing key. Production would wrap
// this in the full `receive_and_credit` flow that also drains the
// dUSDC into the controller vault — that path is queued behind the
// same wiring but needs a bit more MASM plumbing (asset key/value on
// stack).
function buildCreditScript(suffix: bigint, prefix: bigint, amount: bigint): string {
  return `use.miden::core::sys

begin
    # VALUE word first (goes to bottom):
    #   [0, 0, 0, amount]
    push.${amount.toString()} push.0 push.0 push.0

    # KEY word on top:
    #   [0, 0, user_prefix, user_suffix]
    push.${suffix.toString()} push.${prefix.toString()} push.0 push.0

    call.${SET_USER_POSITION_MAST}

    exec.sys::truncate_stack
end
`;
}

const HUMAN_AMOUNT_DEFAULT = "1";

export function TrustlessDepositPanel() {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();

  const { createWallet, wallet, isCreating, error: createErr, reset } =
    useCreateWallet();
  const { consume, isLoading: isConsuming } = useConsume();
  const { waitForConsumableNotes } = useWaitForNotes();
  const { execute: executeTx } = useTransaction();
  const { txScript: compileTxScript } = useCompile();
  const { pauseSync, resumeSync } = useSyncControl();
  const { runExclusive } = useMiden();

  const [stage, setStage] = useState<Stage>("idle");
  const [seedHex, setSeedHex] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [humanAmount, setHumanAmount] = useState<string>(HUMAN_AMOUNT_DEFAULT);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
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
      const sig = await signMessageAsync({ message: DERIVE_MESSAGE(evmAddress) });
      const seed = keccak256(toBytes(sig));
      setSeedHex(seed);
      const seedBytes = new Uint8Array(
        seed.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
      );

      setStage("deriving");
      // Pause the SDK's internal auto-sync loop for the whole
      // createWallet call. Without this, sync races the createWallet
      // future on the WASM RefCell and panics ("RefCell already
      // borrowed" from platform.rs).
      pauseSync();
      let account;
      try {
        // Explicit authScheme is load-bearing: @miden-sdk/react
        // hard-codes `DEFAULTS.AUTH_SCHEME = AuthScheme.AuthRpoFalcon512`
        // but the runtime `AuthScheme` from @miden-sdk/miden-sdk is
        // `{Falcon:"falcon", ECDSA:"ecdsa"}` — no `AuthRpoFalcon512`
        // key. So the default evaluates to `undefined` and wasm_bindgen
        // throws "invalid enum value passed". Pass `AuthScheme.Falcon`
        // explicitly to bypass the broken default.
        // storageMode "private" mirrors SelfCustodyWalletPanel; the
        // Falcon key is deterministic from initSeed so the same
        // signature reproduces the same wallet id.
        account = await createWallet({
          initSeed: seedBytes,
          storageMode: "private",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authScheme: AUTH_SCHEME_FALCON as any,
        });
      } finally {
        resumeSync();
      }
      setWalletId(account.id().toString());
      setStage("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  async function onDeposit() {
    if (!walletId || !evmAddress) return;
    // Same reasoning as onDerive — pause the SDK's auto-sync so it
    // doesn't race the consume / executeTx futures on the WASM RefCell.
    pauseSync();
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
      // Poll for the incoming dUSDC note. Wrap in runExclusive so its
      // internal sync loop doesn't collide with anything else.
      const delivered = await runExclusive(() =>
        waitForConsumableNotes({
          accountId: walletId,
          minCount: 1,
          timeoutMs: 180_000,
          intervalMs: 5_000,
        }),
      );
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

      // Step 4: credit slot-10 on v8-noauth via a browser-signed tx
      // script. v8 is NoAuth, so we can submit against it without any
      // signing key — this is the whole "no server trust" beat.
      setStage("crediting");
      const { suffix, prefix } = evmToUserIdFelts(evmAddress);
      const amountBase = parseUnits(humanAmount, EPOCH_USDC_SEPOLIA.midenDecimals);
      const scriptSrc = buildCreditScript(suffix, prefix, amountBase);
      const txScript = await compileTxScript({ code: scriptSrc });
      const creditResult = await executeTx({
        accountId: TRUSTLESS_CONTROLLER_HEX,
        request: () =>
          new TransactionRequestBuilder().withCustomScript(txScript).build(),
      });
      setCreditTx(creditResult?.transactionId?.toString?.() ?? null);

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
      {stage === "crediting" && (
        <p style={{ fontSize: 13 }}>
          Compiling <code>set_user_position</code> tx script and submitting
          against v8-noauth (no key required — NoAuth account)…
        </p>
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
          <div>
            <strong>slot-10 credit tx (v8-noauth)</strong>:{" "}
            <code>{creditTx ?? "—"}</code>
          </div>
          <div style={{ marginTop: 8, color: "var(--ink-3)" }}>
            The position is credited on the trustless controller
            (<code>{TRUSTLESS_CONTROLLER_HEX.slice(0, 12)}…</code>) by a tx
            script that the browser compiled + submitted with no signing
            key — v8-noauth accepts any tx bundle. Zero server touches
            anything from step 1 to step 4.
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

    </section>
  );
}
