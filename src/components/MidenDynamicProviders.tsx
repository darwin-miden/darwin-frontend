"use client";

import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import type { ReactNode } from "react";

/**
 * Concrete browser-side Miden stack. Always loaded via next/dynamic
 * from `MidenContextProvider` so SSR doesn't see the WASM bundle.
 *
 * Custody mode:
 *   - default (MidenFi)     — wraps children in MidenFiSignerProvider,
 *                             which delegates signing + STARK proving
 *                             to the MidenFi browser extension. UX-
 *                             smooth, "client-side" from the user's
 *                             perspective (proving happens in their
 *                             browser via the extension).
 *   - NEXT_PUBLIC_MIDEN_SELF_CUSTODY=1 — skip MidenFiSignerProvider so
 *                             children can use `useCreateWallet` /
 *                             `useSessionAccount` to generate a fresh
 *                             key in IndexedDB and prove fully in-
 *                             page. Pure self-custody. UX requires
 *                             one-time wallet creation; nothing
 *                             custodial. Not yet exposed in the UI —
 *                             the toggle is in place for a future iteration.
 */
const SELF_CUSTODY =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_MIDEN_SELF_CUSTODY === "1";

export function MidenDynamicProviders({ children }: { children: ReactNode }) {
  return (
    <MidenProvider
      config={{
        rpcUrl: "testnet",
      }}
      loadingComponent={
        <div
          style={{
            position: "fixed",
            bottom: 12,
            right: 12,
            background: "var(--paper-2)",
            border: "1px solid var(--rule)",
            padding: "6px 10px",
            fontSize: 11,
            fontFamily: "var(--font-mono-stack)",
            color: "var(--ink-3)",
            zIndex: 50,
          }}
        >
          loading Miden SDK…
        </div>
      }
    >
      {SELF_CUSTODY ? (
        children
      ) : (
        <MidenFiSignerProvider
          appName="Darwin Protocol"
          network={WalletAdapterNetwork.Testnet}
          // Keep false: when true the MidenFi extension popup opens
          // every page load even on routes the user just navigates
          // to read-only. The persistence trade-off (have to click
          // 'Connect Miden' once per visit) is the right call — the
          // popup-on-arrival UX is hostile.
          autoConnect={false}
        >
          {children}
        </MidenFiSignerProvider>
      )}
    </MidenProvider>
  );
}
