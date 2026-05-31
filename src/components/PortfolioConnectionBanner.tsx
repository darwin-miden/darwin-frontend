"use client";

/**
 * Unified "connect a wallet" banner for the Portfolio page.
 *
 * Replaces the inline 'Connect a Sepolia wallet' panel that used to
 * sit at the top of /portfolio. The page is multi-chain (Sepolia
 * basket ERC20s + Bali bridge on the ETH side, Miden-native positions
 * + faucet balances on the Miden side); the UX should reflect that.
 *
 * Rendering:
 *   - Neither connected → big banner with both Connect buttons
 *   - Only ETH connected → small inline "want Miden too?" hint
 *   - Only Miden connected → small inline "want Sepolia too?" hint
 *   - Both connected → renders nothing
 *
 * The individual section panels (BaliDeposit, MidenPortfolio, etc.)
 * keep their own internal connect prompts; this banner is the
 * page-level entry point.
 */

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { ConnectKitButton } from "connectkit";
import { useAccount } from "wagmi";

export function PortfolioConnectionBanner() {
  const { isConnected: ethConnected } = useAccount();
  const { connected: midenConnected } = useMidenFiWallet();

  // Both connected — nothing to prompt
  if (ethConnected && midenConnected) return null;

  // Big banner when neither is connected
  if (!ethConnected && !midenConnected) {
    return (
      <div
        style={{
          marginTop: 32,
          padding: "24px 28px",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 18 }}>
          Connect a wallet to see your positions
        </h3>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 14,
            lineHeight: 1.55,
            margin: "10px 0 18px",
            maxWidth: 620,
          }}
        >
          Darwin is multi-chain — Sepolia for basket-token ERC20 positions
          and the Bali bridge, Miden testnet for native deposits / redeems
          / faucet balances. Connect either one (or both) to see what
          applies.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <MidenConnectInline />
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button
                onClick={show}
                style={{
                  padding: "10px 18px",
                  background: "var(--ink)",
                  color: "var(--paper)",
                  border: 0,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                Connect ETH
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
        <p
          style={{
            marginTop: 14,
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono-stack)",
            lineHeight: 1.5,
          }}
        >
          Same buttons live in the top nav — pick what's faster.
        </p>
      </div>
    );
  }

  // One connected, suggest the other
  const missing = ethConnected ? "Miden" : "ETH";
  const explanation = ethConnected
    ? "Add a Miden wallet to see native positions, faucet balances, and the deposit flow without the relay hop."
    : "Add an ETH wallet to see your basket-token ERC20 balances on Sepolia and use the Bali bridge.";

  return (
    <div
      style={{
        marginTop: 32,
        padding: "14px 18px",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--rule)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
        <strong>One wallet connected.</strong> {explanation}
      </div>
      {ethConnected ? (
        <MidenConnectInline />
      ) : (
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button
              onClick={show}
              style={{
                padding: "8px 16px",
                background: "var(--ink)",
                color: "var(--paper)",
                border: 0,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              Connect {missing}
            </button>
          )}
        </ConnectKitButton.Custom>
      )}
    </div>
  );
}

function MidenConnectInline() {
  const wallet = useMidenFiWallet();
  const { connect, connecting, wallets, select } = wallet;
  async function onClick() {
    const first = wallets[0];
    if (first && !wallet.wallet) {
      select(first.adapter.name);
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await connect();
    } catch (e) {
      console.warn("[PortfolioBanner] miden connect failed", e);
    }
  }
  return (
    <button
      onClick={onClick}
      disabled={connecting}
      style={{
        padding: "10px 18px",
        background: "var(--orange)",
        color: "var(--paper)",
        border: 0,
        cursor: connecting ? "not-allowed" : "pointer",
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      {connecting ? "Connecting…" : "Connect Miden"}
    </button>
  );
}
