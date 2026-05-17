"use client";

import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import type { ReactNode } from "react";

/**
 * Concrete browser-side Miden stack. Always loaded via next/dynamic
 * from `MidenContextProvider` so SSR doesn't see the WASM bundle.
 */
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
      <MidenFiSignerProvider
        appName="Darwin Protocol"
        network={WalletAdapterNetwork.Testnet}
        autoConnect={false}
      >
        {children}
      </MidenFiSignerProvider>
    </MidenProvider>
  );
}
