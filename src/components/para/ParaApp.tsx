"use client";

/**
 * Self-contained Para experience: the Para/Miden providers wrapping the
 * Polymarket-style app shell (header + funding/withdraw modal). Imported only
 * via next/dynamic({ ssr: false }) from /para so the WASM client never loads on
 * the server.
 */

import ParaProviders from "./ParaProviders";
import { ParaAppShell } from "./ParaAppShell";

export default function ParaApp() {
  return (
    <ParaProviders>
      <ParaAppShell />
    </ParaProviders>
  );
}
