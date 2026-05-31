"use client";

/**
 * Silent eager-reconnect for the Miden wallet — bridges the gap
 * between the adapter's `autoConnect` (which pops the extension on
 * EVERY visit including the first, because `name` is auto-set as
 * soon as MidenFi is the only adapter present) and the desired UX
 * (no popup until the user has explicitly consented to connect at
 * least once).
 *
 * Mechanism: we track our own flag in localStorage
 * (`darwin:miden:consented`). MidenConnectButton sets it to "1" after
 * a successful connect, and clears it on disconnect. This component
 * reads it on mount; only if "1" do we call `connect()` once. For
 * already-consented users the extension responds silently (cached
 * session). For fresh visitors nothing fires and no popup appears.
 *
 * The component renders nothing.
 */

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { useEffect, useRef } from "react";

const CONSENT_KEY = "darwin:miden:consented";

export const midenConsent = {
  get(): boolean {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(CONSENT_KEY) === "1";
    } catch {
      return false;
    }
  },
  set(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CONSENT_KEY, "1");
    } catch {
      /* private mode etc — silently ignore */
    }
  },
  clear(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(CONSENT_KEY);
    } catch {
      /* ignore */
    }
  },
};

export function MidenAutoReconnect() {
  const wallet = useMidenFiWallet();
  const triedRef = useRef(false);

  useEffect(() => {
    if (triedRef.current) return;
    if (!midenConsent.get()) return;
    // Wait until the adapter is actually present (the dynamic SDK
    // import may not have settled on the first tick).
    if (!wallet.wallet || wallet.connected || wallet.connecting) return;
    triedRef.current = true;
    wallet.connect().catch((e) => {
      // If the silent reconnect fails (extension revoked the session,
      // user removed the wallet from their browser, etc.) drop the
      // consent flag so a future visit doesn't keep retrying.
      console.warn("[MidenAutoReconnect] silent connect failed", e);
      midenConsent.clear();
    });
  }, [wallet]);

  return null;
}
