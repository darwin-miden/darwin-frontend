"use client";

/**
 * Client-only wrapper around the Miden dUSDC faucet panel. It reads
 * useMidenFiWallet() which only resolves in the browser (the SDK's wallet
 * adapter has no node entry point) — going through next/dynamic with ssr:false
 * keeps it out of the prerender path.
 */

import dynamic from "next/dynamic";

export const FaucetPanelClient = dynamic(
  () => import("./MidenDusdcFaucetPanel").then((m) => m.MidenDusdcFaucetPanel),
  {
    ssr: false,
    loading: () => <p style={{ color: "var(--ink-3)", fontSize: 12 }}>loading…</p>,
  },
);
