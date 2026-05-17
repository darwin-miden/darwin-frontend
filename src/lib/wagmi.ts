"use client";

/**
 * wagmi config — single Sepolia chain, http RPC (publicnode),
 * MetaMask + WalletConnect + Coinbase via ConnectKit.
 */

import { getDefaultConfig } from "connectkit";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";

const SEPOLIA_RPC =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_HTTP ||
  "https://ethereum-sepolia-rpc.publicnode.com";

const WALLET_CONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "darwin-protocol-demo";

export const wagmiConfig = createConfig(
  getDefaultConfig({
    chains: [sepolia],
    transports: {
      [sepolia.id]: http(SEPOLIA_RPC),
    },
    walletConnectProjectId: WALLET_CONNECT_PROJECT_ID,
    appName: "Darwin Protocol",
    appDescription: "Confidential basket protocol on Miden.",
    appUrl: "https://darwin.xyz",
  }),
);
