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

// Network switch — flips the entire SDK runtime over to Miden Devnet
// when NEXT_PUBLIC_MIDEN_V015=1 is set in .env.local. The matching
// AccountId hexes and MAST roots come from `midenConstants.ts` and
// `midenController.ts` which read the same flag. Default stays
// "testnet" so production deploys are unaffected.
const MIDEN_RPC_URL: "testnet" | "devnet" =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_MIDEN_V015 === "1"
    ? "devnet"
    : "testnet";

export function MidenDynamicProviders({ children }: { children: ReactNode }) {
  return (
    <MidenProvider
      config={{
        rpcUrl: MIDEN_RPC_URL,
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
          autoConnect={false}
          // Default error handler does `console.error(error)`, which
          // Next 15's dev overlay scrapes — including 'Note not found'
          // failures from the faucet claim retry loop that we already
          // recover from (the next attempt succeeds once the wallet
          // syncs). Filter those + emit a quieter warn for everything
          // else so production breakage still surfaces.
          onError={(error) => {
            const msg = String((error as Error)?.message ?? error);
            if (/not found/i.test(msg)) return;
            console.warn("[MidenFi adapter]", msg);
          }}
        >
          {children}
        </MidenFiSignerProvider>
      )}
    </MidenProvider>
  );
}
