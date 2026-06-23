"use client";

/**
 * Browser-side self-custody wallet creation flow.
 *
 * Pure mode: the user generates a Falcon-512 keypair directly in the
 * page via `useCreateWallet`, the secret persists in IndexedDB
 * through the Miden Web SDK's `createMidenStorage` layer, and every
 * subsequent tx is proved fully in-browser. No reliance on the
 * MidenFi browser extension or any server-side signing.
 *
 * Exposed via the `NEXT_PUBLIC_MIDEN_SELF_CUSTODY=1` env flag —
 * when that flag is on, `MidenDynamicProviders` skips the
 * MidenFiSignerProvider wrapper, and this panel renders inside
 * /portfolio so the user can mint a wallet on first visit.
 */

import { useAccounts, useCreateWallet } from "@miden-sdk/react";
import { useState } from "react";

const SELF_CUSTODY =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_MIDEN_SELF_CUSTODY === "1";

export function SelfCustodyWalletPanel() {
  const { accounts, isLoading } = useAccounts();
  const { createWallet, wallet, isCreating, error } = useCreateWallet();
  const [createdId, setCreatedId] = useState<string | null>(null);

  if (!SELF_CUSTODY) return null;

  // Already have a self-custody wallet — surface it.
  const existing = accounts[0];
  if (existing) {
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
          Self-custody wallet (pure in-browser)
        </h2>
        <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
          <strong>Active</strong>. Wallet ID:{" "}
          <code>{existing.id().toString()}</code>. Secret key stored in
          IndexedDB on this device — no server, no extension. STARK proofs
          generated locally for every tx.
        </p>
      </section>
    );
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
        Self-custody wallet (pure in-browser)
      </h2>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          lineHeight: 1.55,
          marginTop: 0,
          marginBottom: 14,
        }}
      >
        Generate a fresh Falcon-512 keypair right here in your browser.
        The secret never leaves IndexedDB on this device — no MidenFi
        extension, no Para custody, no server. The Miden Web SDK proves
        every transaction locally and submits the proof to the testnet
        node.
      </p>
      <button
        onClick={async () => {
          try {
            // v0.15 dropped the `mutable` flag from CreateWalletOptions
            // (the field was a no-op since mutability is now a property
            // of the account components, not the wallet creation call).
            const w = await createWallet({
              storageMode: "private",
            });
            setCreatedId(w.id().toString());
          } catch (e) {
            console.error("createWallet failed", e);
          }
        }}
        disabled={isCreating || isLoading}
        style={{
          padding: "10px 18px",
          background: isCreating ? "var(--ink-3)" : "var(--ink)",
          color: "var(--paper)",
          border: 0,
          cursor: isCreating ? "not-allowed" : "pointer",
          fontSize: 14,
        }}
      >
        {isCreating ? "Generating Falcon-512 keypair…" : "Create wallet"}
      </button>

      {wallet && createdId && (
        <p
          style={{
            marginTop: 12,
            fontSize: 12,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono-stack)",
          }}
        >
          ready: <code>{createdId}</code>
        </p>
      )}
      {error && (
        <pre
          style={{
            marginTop: 10,
            padding: 10,
            background: "#fff0f0",
            fontSize: 11,
            overflowX: "auto",
            color: "#a01a1a",
          }}
        >
          {String(error.message ?? error)}
        </pre>
      )}
    </section>
  );
}
