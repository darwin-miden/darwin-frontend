"use client";

/**
 * /para entry. The user first picks a connection method (ConnectGate, no
 * provider mounted). That choice decides which signer provider wraps the shared
 * app shell:
 *   - "para"  → ParaProviders (ParaSignerProvider → Para-managed Miden account)
 *   - "miden" → MidenNativeProviders (MidenFiSignerProvider → native wallet)
 * The shell + funding/withdraw are signer-agnostic, so they work under either.
 * Imported only via next/dynamic({ ssr: false }) so the WASM client stays off
 * the server.
 */

import { useState } from "react";

import ParaProviders from "./ParaProviders";
import MidenNativeProviders from "./MidenNativeProviders";
import { ParaAppShell } from "./ParaAppShell";
import { ConnectGate, type ConnectMethod } from "./ConnectGate";

export default function ParaApp() {
  const [method, setMethod] = useState<ConnectMethod | null>(null);

  if (!method) return <ConnectGate onChoose={setMethod} />;

  const shell = <ParaAppShell onExit={() => setMethod(null)} />;
  return method === "para" ? (
    <ParaProviders>{shell}</ParaProviders>
  ) : (
    <MidenNativeProviders>{shell}</MidenNativeProviders>
  );
}
