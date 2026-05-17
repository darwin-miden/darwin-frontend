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

const SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_HTTP ||
  "https://ethereum-sepolia-rpc.publicnode.com";

// Mainnet is used exclusively for ENS resolution by ConnectKit; the
// Darwin protocol itself never reads or writes there.
const MAINNET_RPC =
  process.env.NEXT_PUBLIC_MAINNET_RPC_HTTP ||
  "https://ethereum-rpc.publicnode.com";

const WALLET_CONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "darwin-protocol-demo";

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [sepolia, mainnet],
    transports: {
      [sepolia.id]: http(SEPOLIA_RPC),
      [mainnet.id]: http(MAINNET_RPC),
    },
    walletConnectProjectId: WALLET_CONNECT_PROJECT_ID,
    appName: "Darwin Protocol",
    appDescription: "Confidential basket protocol on Miden.",
    appUrl: "https://darwin.xyz",
  }),
);
