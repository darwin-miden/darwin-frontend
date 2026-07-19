"use client";

import { useEffect, useState } from "react";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ConnectKitButton } from "connectkit";

import { LogoFull } from "./Logo";

// Loaded client-side only — the Miden SDK pulls in the WASM bundle.
const MidenConnectButton = dynamic(
  () => import("./MidenConnectButton").then((m) => m.MidenConnectButton),
  {
    ssr: false,
    loading: () => (
      <button
        className="nav-cta"
        type="button"
        style={{ minWidth: 140, opacity: 0.5, textAlign: "center" }}
      >
        Wallet…
      </button>
    ),
  },
);

// Enforces one-wallet-at-a-time. Client-only + only mounted in the non-bare
// provider, where useMidenFiWallet is available.
const WalletExclusivity = dynamic(
  () => import("./WalletExclusivity").then((m) => m.WalletExclusivity),
  { ssr: false },
);

/**
 * Shared top nav. Uses globals.css design tokens (.nav, .nav-inner,
 * .nav-logo, .nav-links, .nav-cta). The active page is passed in so
 * we can highlight it without a router subscription on the server.
 */
export type NavKey =
  | "home"
  | "baskets"
  | "faucet"
  | "portfolio";

export function NavBar({ active }: { active?: NavKey }) {
  // The Self-custody tab (and /trustless) swap the app to the BARE
  // Miden provider — MidenFiSignerProvider is absent there and
  // useMidenFiWallet would throw, so the connect button hides.
  const [bareMode, setBareMode] = useState(
    () =>
      typeof window !== "undefined" &&
      window.location.hash === "#selfcustody",
  );
  useEffect(() => {
    const check = () =>
      setBareMode(window.location.hash === "#selfcustody");
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  const link = (key: NavKey, href: string, label: string) => (
    <Link
      href={href}
      style={{
        color: active === key ? "var(--ink)" : "var(--ink-2)",
        borderBottom:
          active === key ? "1px solid var(--orange)" : "1px solid transparent",
        paddingBottom: 2,
      }}
    >
      {label}
    </Link>
  );

  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link href="/" className="nav-logo">
          <LogoFull />
        </Link>
        <nav className="nav-links">
          {link("baskets", "/baskets", "Baskets")}
          {link("portfolio", "/portfolio", "Portfolio")}
          {link("faucet", "/faucet", "Faucet")}
        </nav>
        <div style={{ display: "flex", gap: 8 }}>
          {bareMode ? (
            // Bare-provider mode (Self-custody tab): the real button's
            // useMidenFiWallet hook would throw without its provider.
            // Keep the nav visually stable with an identical button that
            // flips to the Miden-wallet tab, where connecting applies.
            <button
              className="nav-cta"
              type="button"
              style={{ minWidth: 140, textAlign: "center" }}
              onClick={() => {
                window.location.hash = "miden";
              }}
            >
              Connect Wallet
            </button>
          ) : (
            <>
              <WalletExclusivity />
              <MidenConnectButton />
            </>
          )}
          <ConnectKitButton.Custom>
            {({ isConnected, isConnecting, show, address, ensName }) => (
              <button
                onClick={show}
                className="nav-cta"
                type="button"
                style={{ minWidth: 140, textAlign: "center" }}
              >
                {isConnecting
                  ? "Connecting…"
                  : isConnected
                  ? (ensName ?? `${address?.slice(0, 6)}…${address?.slice(-4)}`)
                  : "Connect ETH"}
              </button>
            )}
          </ConnectKitButton.Custom>
        </div>
      </div>
    </header>
  );
}
