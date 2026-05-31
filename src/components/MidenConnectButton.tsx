"use client";

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { useEffect, useState } from "react";

import { midenConsent } from "./MidenAutoReconnect";

/**
 * Compact "Connect Miden wallet" button. Lives next to the ETH-side
 * ConnectKit button in the nav. Hides on SSR to avoid hitting the
 * Miden React hooks before WASM is loaded.
 */
export function MidenConnectButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Hooks must be called unconditionally even before mount; the
  // value is just ignored on the first render.
  const wallet = useMidenFiWallet();

  if (!mounted) {
    return (
      <button
        className="nav-cta"
        type="button"
        style={{ minWidth: 140, opacity: 0.5, textAlign: "center" }}
      >
        Miden…
      </button>
    );
  }

  const { connected, connecting, connect, disconnect, address, wallets, select } =
    wallet;

  if (connected && address) {
    return (
      <button
        onClick={() => {
          // Drop our auto-reconnect flag so the next visit doesn't
          // silently re-establish the session the user just chose
          // to drop.
          midenConsent.clear();
          disconnect();
        }}
        className="nav-cta"
        type="button"
        title={address}
        style={{ minWidth: 140, textAlign: "center" }}
      >
        {`${address.slice(0, 6)}…${address.slice(-4)}`} ⏼
      </button>
    );
  }

  async function onClick() {
    // The MidenFiSignerProvider defaults to a single MidenWalletAdapter,
    // so the first (and only) entry in `wallets` is what we select.
    const first = wallets[0];
    if (first && !wallet.wallet) {
      select(first.adapter.name);
      // Give React a tick to apply the selection before calling connect.
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await connect();
      // Connect succeeded → record consent so MidenAutoReconnect
      // silently restores the session on future visits without ever
      // popping the extension on a fresh browser.
      midenConsent.set();
    } catch (e) {
      // connect() throws WalletNotReadyError if the browser extension
      // isn't installed — the provider already opens adapter.url for
      // the user, so nothing to do here.
      console.warn("miden connect failed", e);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={connecting}
      className="nav-cta"
      type="button"
      style={{ minWidth: 140, textAlign: "center" }}
    >
      {connecting ? "Connecting…" : "Connect Miden"}
    </button>
  );
}
