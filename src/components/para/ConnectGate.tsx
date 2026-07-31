"use client";

/**
 * Pre-connection landing for /para — rendered OUTSIDE any Miden provider so the
 * user can pick their connection method first (which then decides whether
 * ParaProviders or MidenNativeProviders is mounted around the app shell).
 */

import { CSSProperties, useState } from "react";
import { LogoFull } from "../Logo";
import { Overlay } from "./ParaAppShell";

export type ConnectMethod = "para" | "miden";

const topbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px clamp(20px, 4vw, 40px)",
  borderBottom: "1px solid var(--rule)",
};
const choiceBtn: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 14,
  textAlign: "left",
  background: "var(--paper-2)",
  border: "1px solid var(--rule)",
  borderRadius: 12,
  padding: "14px 16px",
  cursor: "pointer",
  color: "var(--ink)",
};

export function ConnectGate({ onChoose }: { onChoose: (m: ConnectMethod) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ minHeight: "100vh", background: "var(--paper)", color: "var(--ink)", fontFamily: "var(--font-sans-stack)" }}>
      <header style={topbar}>
        <span className="nav-logo" style={{ display: "flex" }}>
          <LogoFull aria-label="Darwin" />
        </span>
        <button type="button" className="nav-cta" onClick={() => setOpen(true)}>
          Connect wallet
        </button>
      </header>

      <main style={{ maxWidth: 540, margin: "0 auto", padding: "clamp(60px, 16vh, 180px) 20px", textAlign: "center" }}>
        <h1 style={{ fontSize: 34, fontWeight: 600, margin: 0, letterSpacing: "-0.02em" }}>
          One token, a whole strategy
        </h1>
        <p style={{ marginTop: 12, color: "var(--ink-3)" }}>
          Sign in to get a Miden account and fund it from your own wallet.
        </p>
        <button type="button" className="nav-cta" style={{ marginTop: 24 }} onClick={() => setOpen(true)}>
          Connect wallet
        </button>
      </main>

      {open && (
        <Overlay onClose={() => setOpen(false)}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Connect</h2>
          <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>Choose how you want to sign in.</p>
          <button type="button" onClick={() => onChoose("para")} style={choiceBtn}>
            <div style={{ fontWeight: 600 }}>Continue with Para</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Email, Google, X, passkey, or MetaMask / Rabby</div>
          </button>
          <button type="button" onClick={() => onChoose("miden")} style={choiceBtn}>
            <div style={{ fontWeight: 600 }}>Connect a Miden wallet</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Native Miden wallet (MidenFi extension)</div>
          </button>
        </Overlay>
      )}
    </div>
  );
}
