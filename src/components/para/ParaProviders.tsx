"use client";

/**
 * Para wallet providers — the identity layer.
 *
 * `ParaSignerProvider` (from @miden-sdk/use-miden-para-react) bundles Para's
 * own `ParaProvider` + React-Query context and bridges Para signing into the
 * unified Miden signer interface. It wraps `MidenProvider` (@miden-sdk/react),
 * which boots its OWN WASM client + IndexedDB store.
 *
 * Login methods: email / Google / X / passkey AND MetaMask / Rabby — all are
 * treated as equal ways to sign in. Whatever the method, the Miden SIGNER stays
 * a Para EMBEDDED wallet (Para manages the key); the login only authenticates.
 * For an external-wallet login to actually yield a Miden account, the Para
 * signer reads `embedded.wallets`, so we set `createLinkedEmbeddedForExternalWallets`
 * → logging in with MetaMask/Rabby also provisions a linked embedded wallet
 * (with a one-time ownership-verification signature).
 *
 * NB: MetaMask/Rabby here is a LOGIN method. FUNDING is separate — the funding
 * panel bridges Sepolia USDC from the user's injected wallet via `window.ethereum`
 * (NOT wagmi), so Para's own nested wagmi context can't interfere with it.
 *
 * IMPORTANT: never coexist with the app's default `MidenContextProvider` on the
 * same route — two Miden clients over one IndexedDB corrupt sync. /para is
 * excluded from the root provider in Providers.tsx, and this subtree only ever
 * mounts via next/dynamic({ ssr: false }) so the WASM blob stays off the server.
 *
 * Remote testnet prover (not the local multi-threaded one) so /para needs NO
 * SharedArrayBuffer → NO cross-origin isolation → COOP/COEP are dropped on this
 * route (next.config), which is what lets Para's cross-origin auth iframe load.
 */

import "@getpara/react-sdk-lite/styles.css";

import { MidenProvider } from "@miden-sdk/react";
import { ParaSignerProvider } from "@miden-sdk/use-miden-para-react";
import type { ReactNode } from "react";
import { http } from "viem";
import { mainnet, sepolia } from "wagmi/chains";

const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? "";

// CORS-friendly RPCs (publicnode), same as the app's lib/wagmi.ts. Para's
// evmConnector otherwise defaults mainnet → eth.merkle.io, which (a) isn't in
// our CSP connect-src and (b) blocks CORS from localhost → a retry flood that
// churns Para's wagmi state and re-inits the Miden client in a loop ("Miden
// ready: Initializing…" forever). Pinning both chains at publicnode fixes it.
const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC_HTTP || "https://ethereum-rpc.publicnode.com";
const SEPOLIA_RPC = process.env.NEXT_PUBLIC_SEPOLIA_RPC_HTTP || "https://ethereum-sepolia-rpc.publicnode.com";

// A real WalletConnect id is needed only for QR/mobile wallets; the app treats
// the placeholder as "no WC". MetaMask/Rabby are injected (EIP-6963) and need
// none, so we only wire walletConnect when a real id is present.
const RAW_WC_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const WC_PROJECT_ID = RAW_WC_ID && RAW_WC_ID !== "darwin-protocol-demo" ? RAW_WC_ID : "";

// External-wallet login for the Para modal. MetaMask + Rabby are offered as
// login methods alongside email/Google/X/passkey. `createLinkedEmbeddedForExternalWallets`
// makes an external-wallet login also provision a linked embedded wallet, so
// the Miden signer (which reads `embedded.wallets`) gets an account.
const externalWalletConfig = {
  wallets: ["METAMASK", "RABBY"],
  evmConnector: {
    config: {
      chains: [mainnet, sepolia],
      transports: {
        [mainnet.id]: http(MAINNET_RPC),
        [sepolia.id]: http(SEPOLIA_RPC),
      },
    },
  },
  createLinkedEmbeddedForExternalWallets: ["METAMASK", "RABBY"],
  ...(WC_PROJECT_ID ? { walletConnect: { projectId: WC_PROJECT_ID } } : {}),
};

export default function ParaProviders({ children }: { children: ReactNode }) {
  return (
    <ParaSignerProvider
      apiKey={PARA_API_KEY}
      environment="BETA"
      appName="Darwin"
      paraProviderConfig={{
        // Show the email/OAuth auth block AND the external wallets block.
        paraModalConfig: { authLayout: ["AUTH:FULL", "EXTERNAL:FULL"] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        externalWalletConfig: externalWalletConfig as any,
      }}
    >
      <MidenProvider config={{ rpcUrl: "testnet", prover: "testnet" }}>
        {children}
      </MidenProvider>
    </ParaSignerProvider>
  );
}
