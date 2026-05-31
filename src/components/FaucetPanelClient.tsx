"use client";

/**
 * Client-only wrapper around FaucetPanel. The panel reads
 * useMidenFiWallet() which only resolves in the browser (the SDK's
 * wallet adapter has no node entry point) — going through next/dynamic
 * with ssr:false keeps it out of the prerender path.
 */

import dynamic from "next/dynamic";

export const FaucetPanelClient = dynamic(
  () => import("./FaucetPanel").then((m) => m.FaucetPanel),
  {
    ssr: false,
    loading: () => <p style={{ color: "var(--ink-3)", fontSize: 12 }}>loading…</p>,
  },
);
