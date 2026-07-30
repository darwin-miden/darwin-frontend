"use client";

/**
 * Self-contained Para experience: the Para/Miden providers wrapping the connect
 * panel + the funding panel. Imported only via next/dynamic({ ssr: false }) from
 * /para so the WASM client never loads on the server.
 */

import ParaProviders from "./ParaProviders";
import { ParaFundingPanel } from "./ParaFundingPanel";
import { ParaWalletPanel } from "./ParaWalletPanel";

export default function ParaApp() {
  return (
    <main className="flex min-h-[80vh] flex-col items-center justify-center px-6 py-16">
      <ParaProviders>
        <ParaWalletPanel />
        <ParaFundingPanel />
      </ParaProviders>
    </main>
  );
}
