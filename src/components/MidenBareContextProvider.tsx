"use client";

/**
 * Bare Miden provider — only MidenProvider, no MidenFiSignerProvider.
 *
 * Used exclusively for /trustless, where the page derives its own
 * Miden key from a MetaMask signature via `useCreateWallet({
 * initSeed })`. Wrapping that flow in MidenFiSignerProvider switches
 * the SDK to external-keystore mode (routing insertKey through the
 * MidenFi extension callback), which rejects our synthetic keys with
 * "invalid enum value passed" — the whole point of this component is
 * to avoid that path.
 *
 * Loaded via next/dynamic so the WASM bundle isn't required from
 * the Node SSR entry — matches MidenContextProvider's shape.
 */

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

const MidenBareProviders = dynamic(
  () => import("./MidenBareProviders").then((m) => m.MidenBareProviders),
  { ssr: false },
);

export function MidenBareContextProvider({ children }: { children: ReactNode }) {
  return <MidenBareProviders>{children}</MidenBareProviders>;
}
