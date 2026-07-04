"use client";

/**
 * Trustless deposit — no server, no MidenFi extension.
 *
 * The user signs a single deterministic message with MetaMask; the
 * signature bytes are hashed into a 32-byte seed that we feed to
 * `useCreateWallet({ initSeed })` (Miden Web SDK). The resulting
 * Miden wallet is fully derived from the ETH signature and lives
 * in IndexedDB via the SDK's storage layer — no server holds any
 * secret, and losing browser state doesn't lose access because the
 * same signature always re-derives the same key.
 *
 * The receive-side controller is the v8-noauth account
 * (`TRUSTLESS_CONTROLLER_HEX`), a NoAuth Miden account: anyone can
 * submit a tx against it without any signing key. So the browser
 * itself can post the `atomic_deposit_note` consume tx that credits
 * slot-10 for this user — no backend touches anything.
 *
 * Demo-grade for now (v8-noauth's admin procs are also unguarded),
 * but the pattern is real and lives on testnet 0.15 today. Prod
 * migration path is Solution B (AuthNetworkAccount v8 with
 * allowlist) once Miden activates ntx-builder for arbitrary
 * accounts — see darwin-protocol@256579b and @9c5456b.
 */

import { useCreateWallet } from "@miden-sdk/react";
import { useAccount, useSignMessage } from "wagmi";
import { keccak256, toBytes } from "viem";
import { useState } from "react";

import { TRUSTLESS_CONTROLLER_HEX } from "../lib/midenConstants";

const DERIVE_MESSAGE_TEMPLATE = (evm: string) =>
  `Darwin Protocol\n\nDerive Miden signing key.\n\nEVM address: ${evm}\n\nSigning this reveals nothing about your ETH funds and is safe to sign.`;

type Stage =
  | "idle"
  | "deriving-seed"
  | "creating-wallet"
  | "ready"
  | "error";

export function TrustlessDepositPanel() {
  const { address: evmAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { createWallet, isCreating, error: createErr } = useCreateWallet();
  const [stage, setStage] = useState<Stage>("idle");
  const [walletId, setWalletId] = useState<string | null>(null);
  const [seedHex, setSeedHex] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onDerive() {
    if (!evmAddress) {
      setErrorMsg("Connect your ETH wallet first.");
      return;
    }
    setErrorMsg(null);
    try {
      setStage("deriving-seed");
      const message = DERIVE_MESSAGE_TEMPLATE(evmAddress);
      const sig = await signMessageAsync({ message });
      // Hash the signature bytes to a 32-byte seed. Same signature ⇒
      // same seed ⇒ same Miden wallet, every time.
      const seed = keccak256(toBytes(sig));
      const seedBytes = new Uint8Array(
        seed
          .slice(2)
          .match(/.{2}/g)!
          .map((h) => parseInt(h, 16)),
      );
      setSeedHex(seed);

      setStage("creating-wallet");
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
        from that signature. Deposits credit position slot-10 on a{" "}
        <code>NoAuth</code> Darwin controller
        (<code>{TRUSTLESS_CONTROLLER_HEX.slice(0, 12)}…</code>) that anyone
        can submit txs against without holding a private key. No Darwin
        backend involved.
      </p>

      {!evmAddress && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          Connect your ETH wallet above to begin.
        </p>
      )}

      {evmAddress && stage === "idle" && (
        <button
          onClick={onDerive}
          className="nav-cta"
          style={{ minWidth: 260 }}
        >
          Derive Miden key from MetaMask
        </button>
      )}

      {stage === "deriving-seed" && (
        <p style={{ fontSize: 13 }}>Waiting for MetaMask signature…</p>
      )}

      {stage === "creating-wallet" && (
        <p style={{ fontSize: 13 }}>
          Building Miden wallet from your signature (proof runs in-browser)…
        </p>
      )}

      {stage === "ready" && walletId && (
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            border: "1px solid var(--rule)",
            padding: 12,
            background: "var(--paper-2)",
          }}
        >
          <div>
            <strong>EVM address</strong>: <code>{evmAddress}</code>
          </div>
          <div>
            <strong>Derived seed (keccak256)</strong>: <code>{seedHex}</code>
          </div>
          <div>
            <strong>Derived Miden wallet id</strong>: <code>{walletId}</code>
          </div>
          <div style={{ marginTop: 8, color: "var(--ink-3)" }}>
            Sign the same message from any browser → same seed → same wallet.
            No secret stored anywhere Darwin controls.
          </div>
        </div>
      )}

      {(errorMsg || createErr) && (
        <p style={{ fontSize: 13, color: "var(--danger)" }}>
          {errorMsg ?? createErr?.message}
        </p>
      )}

      {stage === "ready" && (
        <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 12 }}>
          Next step (wiring in progress): deposit dUSDC via Epoch to this
          wallet, then browser-side submit an atomic_deposit consume tx
          against the NoAuth controller. Live-tested end-to-end via
          <code> test_noauth_consume</code> in darwin-protocol (block 324496).
        </p>
      )}
    </section>
  );
}
