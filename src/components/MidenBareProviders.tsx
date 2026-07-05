"use client";

import { MidenProvider } from "@miden-sdk/react";
import type { ReactNode } from "react";

const MIDEN_RPC_URL: "testnet" | "devnet" =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_MIDEN_V015 === "1"
    ? "devnet"
    : "testnet";

export function MidenBareProviders({ children }: { children: ReactNode }) {
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
      {children}
    </MidenProvider>
  );
}
