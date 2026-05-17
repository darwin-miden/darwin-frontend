"use client";

/**
 * Browser-only Miden wallet + signer providers.
 *
 * - `MidenProvider` from `@miden-sdk/react` wires the WASM client +
 *   IndexedDB store + Pragma RPC endpoints.
 * - `MidenFiSignerProvider` is the unified wallet adapter context;
 *   reads `window.midenWallet` exposed by the MidenFi browser
 *   extension and forwards every signed request through it.
 *
 * Both are imported through `next/dynamic` with `ssr: false` so the
 * WASM blob is never required from the Node.js server bundle.
 */

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

const MidenDynamicProviders = dynamic(
  () => import("./MidenDynamicProviders").then((m) => m.MidenDynamicProviders),
  { ssr: false },
);

export function MidenContextProvider({ children }: { children: ReactNode }) {
  return <MidenDynamicProviders>{children}</MidenDynamicProviders>;
}
