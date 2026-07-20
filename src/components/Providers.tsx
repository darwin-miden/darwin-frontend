"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider } from "connectkit";
import { usePathname } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "../lib/wagmi";
import { MidenContextProvider } from "./MidenContextProvider";
import { MidenBareContextProvider } from "./MidenBareContextProvider";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const pathname = usePathname();
  // /trustless owns its own key derivation and needs the internal WASM
  // keystore path. If we wrap it in the default MidenContextProvider
  // (which includes MidenFiSignerProvider) the SDK boots in external-
  // keystore mode and every createWallet call routes insertKey through
  // MidenFi → "invalid enum value passed" panic. Route it to a bare
  // provider that only wires MidenProvider (no signer wrapper).
  // Cover /trustless and every subroute (/trustless/redeem, etc.). Exact
  // match missed the redeem page and boot it into MidenContextProvider,
  // which wraps MidenFiSignerProvider → createWallet routes through the
  // MidenFi keystore path and the wrong DB name (mdev not mtst) is
  // opened. Verified live via a Playwright run that hit
  // "MidenClientDB_mdev" on /trustless/redeem despite the parent route
  // being locked to testnet.
  // The basket pages' Self-custody tab needs the same bare provider as
  // /trustless (internal WASM keystore) — but tab state isn't part of
  // the pathname. The tab reflects itself into the URL hash, and the
  // provider follows: #selfcustody → bare. Only one Miden client ever
  // runs at a time this way; nesting a second provider over the same
  // IndexedDB corrupts sync (a delivered note never became consumable
  // — verified live).
  // A hashchange-only listener goes STALE on route changes: a Link nav from
  // /baskets/dcc#selfcustody → /portfolio clears the hash but fires NO
  // hashchange event, so the bare provider would persist and pages that need
  // MidenFiSignerProvider (Portfolio) crash on the first render
  // ("useMidenFiWallet must be used within MidenFiSignerProvider"). Read the
  // LIVE hash on every render instead: usePathname re-renders this on route
  // changes, and bumpOnHash re-renders it when the deposit tab toggles the hash
  // on the same route. First client render matches the old useState-init read,
  // so hydration is unchanged.
  const [, bumpOnHash] = useState(0);
  useEffect(() => {
    const onHash = () => bumpOnHash((n) => n + 1);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Bare mode ONLY on the basket detail pages (where the Self-custody deposit
  // tab lives). Scoping by route means a leaked #selfcustody hash can never put
  // Portfolio/Faucet/etc. into bare mode and crash their useMidenFiWallet.
  const isTrustless =
    pathname != null &&
    pathname.startsWith("/baskets/") &&
    typeof window !== "undefined" &&
    window.location.hash === "#selfcustody";
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider
          theme="midnight"
          customTheme={{
            "--ck-accent-color": "#ff6a3d",
            "--ck-accent-text-color": "#0b0b0c",
          }}
        >
          {isTrustless ? (
            <MidenBareContextProvider>{children}</MidenBareContextProvider>
          ) : (
            <MidenContextProvider>{children}</MidenContextProvider>
          )}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
