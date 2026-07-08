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
import { useAccount, useSignMessage } from "wagmi";
import { useEffect, useMemo, useRef, useState } from "react";
import { keccak256, parseUnits, toBytes } from "viem";

import { EPOCH_DUSDC_FAUCET_ID } from "../lib/midenConstants";
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
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
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

const HUMAN_AMOUNT_DEFAULT = "1";

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
  const { signMessageAsync } = useSignMessage();
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
  // bypassing MetaMask + wagmi + ConnectKit. Safe to keep in prod: the
  // caller supplies the seed / user address, no secret leaks.
  useEffect(() => {
    if (typeof window === "undefined") return;
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
      let resolvedWalletId: string | null = null;
      try {
        // Explicit authScheme is load-bearing: @miden-sdk/react
        // hard-codes `DEFAULTS.AUTH_SCHEME = AuthScheme.AuthRpoFalcon512`
        // but the runtime `AuthScheme` from @miden-sdk/miden-sdk is
        // `{Falcon:"falcon", ECDSA:"ecdsa"}` — no `AuthRpoFalcon512`
        // key. So the default evaluates to `undefined` and wasm_bindgen
        // throws "invalid enum value passed".
        // storageMode "private" mirrors SelfCustodyWalletPanel; the
        // Falcon key is deterministic from initSeed so the same
        // signature reproduces the same wallet id.
        try {
          const account = await createWallet({
            initSeed: seedBytes,
            storageMode: "private",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as any,
          });
          resolvedWalletId = account.id().toString();
        } catch (e) {
          // On refresh, the previously-derived wallet is still in
          // IndexedDB (private-mode wallets persist). `createWallet`
          // detects the collision and throws "account with id 0x… is
          // already being tracked" — pull the id out of the error
          // message and treat it as success.
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
      // Consume everything pending (a stuck prior delivery may be queued
      // alongside this deposit's note — drain them all into the vault).
      const consumeResult = await consume({
        accountId: walletId,
        notes: inboundIds,
      });
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
        setStage("crediting");
        // Emit what the solver guaranteed to deliver (minTokenOut =
        // 95% of the target) — the vault is certain to hold it, and
        // the position credits exactly what the note moves. Any
        // delivery surplus stays in the user's own wallet.
        const amountBaseNet =
          (parseUnits(humanAmount, EPOCH_USDC_SEPOLIA.midenDecimals) * 95n) / 100n;
        const r = await fetch("/api/network-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: walletId,
            userEvm: evmAddress,
            basket: basket?.symbol ?? "DCC",
            amount: amountBaseNet.toString(),
          }),
        });
        const built = (await r.json()) as {
          noteId?: string;
          noteB64?: string;
          error?: string;
        };
        if (!r.ok || !built.noteB64) {
          throw new Error(built.error ?? `network-note API ${r.status}`);
        }
        const { Note, NoteArray } = await import("@miden-sdk/miden-sdk");
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
          Self-custody rail{basket ? ` for ${basket.symbol}` : ""} — your
          browser derives a Miden key from one MetaMask signature, bridges
          via Epoch, and writes your position itself. No Darwin server
          ever touches your funds.
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
                ? "Compiling set_user_position script + submitting against v8-noauth…"
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
              ✅ Position credited on <code>{TRUSTLESS_CONTROLLER_HEX.slice(0, 12)}…</code> by
              a tx script the browser compiled + submitted with no signing key.
              v8-noauth accepts any tx bundle. Zero server touches from step 1 to step 4.
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
