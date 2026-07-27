"use client";

/**
 * Para wallet providers — an ADDITIVE, isolated onboarding path.
 *
 * `ParaSignerProvider` (from @miden-sdk/use-miden-para-react) bundles Para's
 * own `ParaProvider` + React-Query context and bridges Para signing into the
 * unified Miden signer interface. It wraps `MidenProvider` (@miden-sdk/react),
 * which boots its OWN WASM client + IndexedDB store.
 *
 * IMPORTANT: this must never coexist with the app's default
 * `MidenContextProvider` on the same route — two Miden clients over the same
 * IndexedDB corrupt sync. The /para route is therefore excluded from the root
 * `MidenContextProvider` in Providers.tsx, and this whole subtree is only ever
 * mounted via `next/dynamic({ ssr: false })` so the WASM blob stays out of the
 * server bundle.
 *
 * The signer here is a Para EMBEDDED (MPC) wallet, not the user's MetaMask /
 * Rabby key — that is Para's model. This path is added alongside the existing
 * MetaMask-derived flow, not as a replacement.
 */

import "@getpara/react-sdk-lite/styles.css";

import { MidenProvider } from "@miden-sdk/react";
import { ParaSignerProvider } from "@miden-sdk/use-miden-para-react";
import type { ReactNode } from "react";
import { mainnet, sepolia } from "wagmi/chains";

// Client-side Para API key. Set NEXT_PUBLIC_PARA_API_KEY in .env.local (a
// non-prod / BETA key for local + beta.darwin.market). Empty string keeps the
// tree renderable; the Para modal simply fails to authenticate without a key.
const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? "";

// A REAL WalletConnect Cloud id is needed for QR/mobile wallets. The app treats
// the placeholder as "no WC" (see lib/wagmi.ts) — an unset/placeholder id makes
// WC spin forever. MetaMask/Rabby as browser extensions are INJECTED (EIP-6963)
// and need no WC id, so we only wire walletConnect when a real id is present.
const RAW_WC_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const WC_PROJECT_ID =
  RAW_WC_ID && RAW_WC_ID !== "darwin-protocol-demo" ? RAW_WC_ID : "";

// External-wallet login for the Para modal. MetaMask + Rabby are offered as
// login methods (Para's external-wallet auth). NOTE the signer that actually
// drives Miden stays the Para EMBEDDED wallet — MetaMask/Rabby here authenticate
// the Para session, they are not the Miden signing key. Injected extensions work
// under the app's COOP:same-origin (no popups); Coinbase is intentionally absent
// because its SDK needs COOP≠same-origin, which conflicts with Miden's
// SharedArrayBuffer requirement (same reason lib/wagmi.ts drops it).
const externalWalletConfig = {
  wallets: ["METAMASK", "RABBY"],
  evmConnector: { config: { chains: [mainnet, sepolia] } },
  ...(WC_PROJECT_ID ? { walletConnect: { projectId: WC_PROJECT_ID } } : {}),
};

export default function ParaProviders({ children }: { children: ReactNode }) {
  return (
    <ParaSignerProvider
      apiKey={PARA_API_KEY}
      environment="BETA"
      appName="Darwin"
      paraProviderConfig={{
        // Show the email/OAuth auth block AND the external wallets block.
        paraModalConfig: { authLayout: ["AUTH:FULL", "EXTERNAL:FULL"] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        externalWalletConfig: externalWalletConfig as any,
      }}
    >
      <MidenProvider config={{ rpcUrl: "testnet" }}>{children}</MidenProvider>
    </ParaSignerProvider>
  );
}
