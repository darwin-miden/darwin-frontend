"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitProvider } from "connectkit";
import { usePathname } from "next/navigation";
import { ReactNode, useState } from "react";
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
  const isTrustless = pathname?.startsWith("/trustless") ?? false;
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
