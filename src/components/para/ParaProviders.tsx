"use client";

/**
 * Para wallet providers — the ALL-PARA identity layer.
 *
 * `ParaSignerProvider` (from @miden-sdk/use-miden-para-react) bundles Para's
 * own `ParaProvider` + React-Query context and bridges Para signing into the
 * unified Miden signer interface. It wraps `MidenProvider` (@miden-sdk/react),
 * which boots its OWN WASM client + IndexedDB store.
 *
 * Login methods are Para's defaults ONLY: email / Google / X / passkey. We do
 * NOT wire MetaMask/Rabby as Para login methods — a user who already has a
 * wallet is better served by self-custody, and (crucially here) enabling Para's
 * `externalWalletConfig.evmConnector` makes Para spin up its OWN nested wagmi
 * context, which shadows the app's root WagmiProvider and breaks the funding
 * panel's `useAccount()`/ConnectKit. MetaMask/Rabby belong to FUNDING (the
 * Sepolia source in ParaFundingPanel), not identity.
 *
 * IMPORTANT: never coexist with the app's default `MidenContextProvider` on the
 * same route — two Miden clients over one IndexedDB corrupt sync. /para is
 * excluded from the root provider in Providers.tsx, and this subtree only ever
 * mounts via next/dynamic({ ssr: false }) so the WASM blob stays off the server.
 *
 * Remote testnet prover (not the local multi-threaded one) so /para needs NO
 * SharedArrayBuffer → NO cross-origin isolation → COOP/COEP are dropped on this
 * route (next.config), which is what lets Para's cross-origin auth iframe load.
 */

import "@getpara/react-sdk-lite/styles.css";

import { MidenProvider } from "@miden-sdk/react";
import { ParaSignerProvider } from "@miden-sdk/use-miden-para-react";
import type { ReactNode } from "react";

// Client-side Para API key. Set NEXT_PUBLIC_PARA_API_KEY in .env.local (a
// non-prod / BETA key for local + beta.darwin.market). Empty string keeps the
// tree renderable; the Para modal simply fails to authenticate without a key.
const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? "";

export default function ParaProviders({ children }: { children: ReactNode }) {
  return (
    <ParaSignerProvider apiKey={PARA_API_KEY} environment="BETA" appName="Darwin">
      <MidenProvider config={{ rpcUrl: "testnet", prover: "testnet" }}>
        {children}
      </MidenProvider>
    </ParaSignerProvider>
  );
}
