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
  const [hashBare, setHashBare] = useState(
    () =>
      typeof window !== "undefined" &&
      window.location.hash === "#selfcustody",
  );
  useEffect(() => {
    const check = () =>
      setHashBare(window.location.hash === "#selfcustody");
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  const isTrustless =
    (pathname?.startsWith("/trustless") ?? false) || hashBare;
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
