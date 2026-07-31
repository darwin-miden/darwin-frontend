"use client";

/**
 * Native-Miden-wallet providers for the /para shell — the sibling of
 * ParaProviders. Wraps `MidenProvider` (@miden-sdk/react) with
 * `MidenFiSignerProvider`, which delegates signing + STARK proving to the
 * MidenFi browser extension. Mirrors the app's MidenDynamicProviders MidenFi
 * setup, but pinned to a REMOTE prover so /para stays no-COEP (the extension
 * proves anyway; this is just the fallback context).
 *
 * The Fund/Withdraw panels are signer-agnostic (unified useMiden/useSend/
 * useConsume), so they work under this provider exactly as under ParaProviders.
 * Requires the MidenFi extension installed; without it, connect will surface the
 * adapter's "not ready" state.
 */

import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import {
  AllowedPrivateData,
  PrivateDataPermission,
  WalletAdapterNetwork,
} from "@miden-sdk/miden-wallet-adapter-base";
import type { ReactNode } from "react";

export default function MidenNativeProviders({ children }: { children: ReactNode }) {
  return (
    <MidenProvider config={{ rpcUrl: "testnet", prover: "testnet" }}>
      <MidenFiSignerProvider
        appName="Darwin"
        network={WalletAdapterNetwork.Testnet}
        autoConnect={false}
        privateDataPermission={PrivateDataPermission.Auto}
        allowedPrivateData={AllowedPrivateData.Assets}
        onError={(error) => {
          const msg = String((error as Error)?.message ?? error);
          if (/not found/i.test(msg)) return;
          console.warn("[MidenFi adapter]", msg);
        }}
      >
        {children}
      </MidenFiSignerProvider>
    </MidenProvider>
  );
}
