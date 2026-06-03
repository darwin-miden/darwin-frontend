"use client";

/**
 * wagmi config — Sepolia is the live chain; mainnet is included
 * only so ConnectKit's ENS lookups don't crash against the default
 * `eth.merkle.io` transport (which doesn't allow CORS from
 * localhost). Both legs use publicnode HTTP RPCs which are
 * CORS-friendly.
 */

import { getDefaultConfig } from "connectkit";
import { createConfig, http } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_HTTP ||
  "https://ethereum-sepolia-rpc.publicnode.com";

// Mainnet is used exclusively for ENS resolution by ConnectKit; the
// Darwin protocol itself never reads or writes there.
const MAINNET_RPC =
  process.env.NEXT_PUBLIC_MAINNET_RPC_HTTP ||
  "https://ethereum-rpc.publicnode.com";

// Only a *real* WalletConnect Cloud project id works — the relay
// network rejects the placeholder, which makes WC spin forever
// retrying its subscription ("Connection interrupted while trying
// to subscribe" / "Subscribing … failed") and floods the console.
// Treat unset / placeholder as "no WC" so we don't load a connector
// that can never connect. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
// to a real id (cloud.reown.com) to re-enable mobile wallets.
const RAW_WC_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const WALLET_CONNECT_PROJECT_ID =
  RAW_WC_ID && RAW_WC_ID !== "darwin-protocol-demo" ? RAW_WC_ID : "";

// Explicit connector list — overrides ConnectKit's default set, which
// hardcodes coinbaseWallet + an @aave/account smart-wallet connector.
// We drop both:
//   - @aave/account lazy-connects on mount and throws an unhandled
//     pageerror ("Aave Account is not connected") that crashed the
//     whole React tree.
//   - Coinbase Wallet SDK demands COOP ≠ same-origin so it can open
//     popups, but the Miden Web SDK *requires* COOP same-origin +
//     COEP require-corp for SharedArrayBuffer (its multi-threaded
//     STARK prover). The two are mutually exclusive — Miden wins.
//     Loading Coinbase is then pure downside: console warnings, a
//     dead wallet option in the picker, and blocked analytics
//     fetches to cca-lite.coinbase.com. Dropped.
// getDefaultConfig uses `props.connectors` verbatim when provided
// (see connectkit/build defaultConfig: `props?.connectors ?? defaultConnectors(...)`).
const connectors = [
  injected({ target: "metaMask" }),
  ...(WALLET_CONNECT_PROJECT_ID
    ? [
        walletConnect({
          showQrModal: false, // ConnectKit renders its own modal
          projectId: WALLET_CONNECT_PROJECT_ID,
          metadata: {
            name: "Darwin Protocol",
            description: "Confidential basket protocol on Miden.",
            url: "https://darwin.market",
            icons: [],
          },
        }),
      ]
    : []),
];

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [sepolia, mainnet],
    transports: {
      [sepolia.id]: http(SEPOLIA_RPC),
      [mainnet.id]: http(MAINNET_RPC),
    },
    connectors,
    walletConnectProjectId: WALLET_CONNECT_PROJECT_ID,
    appName: "Darwin Protocol",
    appDescription: "Confidential basket protocol on Miden.",
    appUrl: "https://darwin.market",
  }),
);
