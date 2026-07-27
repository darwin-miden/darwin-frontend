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

// Client-side Para API key. Set NEXT_PUBLIC_PARA_API_KEY in .env.local (a
// non-prod / BETA key for local + beta.darwin.market). Empty string keeps the
// tree renderable; the Para modal simply fails to authenticate without a key.
const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? "";

export default function ParaProviders({ children }: { children: ReactNode }) {
  return (
    <ParaSignerProvider apiKey={PARA_API_KEY} environment="BETA" appName="Darwin">
      <MidenProvider config={{ rpcUrl: "testnet" }}>{children}</MidenProvider>
    </ParaSignerProvider>
  );
}
