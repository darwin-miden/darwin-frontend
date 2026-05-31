"use client";

import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import type { ReactNode } from "react";

import { MidenAutoReconnect } from "./MidenAutoReconnect";

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
          // The provider's built-in autoConnect auto-sets the wallet
          // 'name' to the only available adapter (MidenFi) the moment
          // it loads, which means autoConnect=true would open the
          // extension popup on EVERY first visit — including users
          // who have never clicked Connect. MidenAutoReconnect (below)
          // implements the right behaviour: read our own
          // 'darwin:miden:consented' localStorage flag (set by the
          // MidenConnectButton after a successful manual connect)
          // and only call connect() then. For users who have already
          // approved Darwin in MidenFi, the extension responds
          // silently and the address comes back without UI; for
          // first-time visitors nothing fires.
          autoConnect={false}
        >
          <MidenAutoReconnect />
          {children}
        </MidenFiSignerProvider>
      )}
    </MidenProvider>
  );
}
