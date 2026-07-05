"use client";

import { MidenProvider } from "@miden-sdk/react";
import type { ReactNode } from "react";

// v8-noauth lives on Miden testnet (0x2cc265c…), so the /trustless
// route always talks to testnet regardless of the NEXT_PUBLIC_MIDEN_V015
// env flag that the rest of the app uses to switch to devnet. Without
// this hard-lock the browser boots against rpc.devnet.miden.io, the
// SDK writes to MidenClientDB_mdev, useCreateWallet round-trips into
// devnet-shaped Rust enums, and the whole path panics with
// "invalid enum value passed".
export function MidenBareProviders({ children }: { children: ReactNode }) {
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
      {children}
    </MidenProvider>
  );
}
