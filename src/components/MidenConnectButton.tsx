"use client";

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { useEffect, useState } from "react";

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

  // Trace state at every render so DevTools can pinpoint where a
  // connect stalls (extension detection, wallets[] empty, connect()
  // resolves without an address, etc). Must run BEFORE any early
  // return — React counts hooks by call order.
  useEffect(() => {
    console.info("[miden-connect] state", {
      connected: wallet.connected,
      connecting: wallet.connecting,
      address: wallet.address,
      hasCurrentWallet: !!wallet.wallet,
      currentWalletName: wallet.wallet?.adapter?.name,
      currentReadyState: wallet.wallet?.readyState,
      wallets: wallet.wallets.map((w) => ({
        name: w.adapter.name,
        readyState: w.readyState,
      })),
      windowMidenWallet:
        typeof window !== "undefined" &&
        !!(
          (window as unknown as { midenWallet?: unknown }).midenWallet ||
          (window as unknown as { miden?: unknown }).miden
        ),
    });
  }, [wallet.connected, wallet.connecting, wallet.address, wallet.wallet, wallet.wallets]);

  if (!mounted) {
    return (
      <button
        className="nav-cta"
        type="button"
        style={{ minWidth: 140, opacity: 0.5, textAlign: "center" }}
      >
        Wallet…
      </button>
    );
  }

  const { connected, connecting, connect, disconnect, address, wallets, select } =
    wallet;

  if (connected && address) {
    return (
      <button
        onClick={() => disconnect()}
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
    console.info("[miden-connect] onClick — wallets=", wallets.length, "hasWallet=", !!wallet.wallet);
    // The MidenFiSignerProvider defaults to a single MidenWalletAdapter,
    // so the first (and only) entry in `wallets` is what we select.
    const first = wallets[0];
    if (first && !wallet.wallet) {
      console.info("[miden-connect] selecting", first.adapter.name);
      select(first.adapter.name);
      // Give React a tick to apply the selection before calling connect.
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      console.info("[miden-connect] calling connect()");
      await connect();
      console.info("[miden-connect] connect() resolved");
    } catch (e) {
      // connect() throws WalletNotReadyError if the browser extension
      // isn't installed — the provider already opens adapter.url for
      // the user, so nothing to do here.
      console.warn("[miden-connect] connect failed", e);
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
      {connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}
