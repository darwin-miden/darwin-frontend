"use client";

/**
 * Polymarket-style app shell for the Para experience: a top bar with
 * Portfolio / Cash / Deposit / Connect, and the funding+withdraw flow in a
 * modal opened from Deposit (or by clicking the Cash balance).
 *
 * Styled with the app's own CSS system (CSS variables + `nav-cta` etc.) via
 * inline styles — the app does NOT use Tailwind, so utility classes are inert.
 *
 * Runs on the remote-prover / no-COEP model (see ParaProviders) so Para's auth
 * iframe works. Connect offers a choice: Para (email/Google/X/passkey/MetaMask/
 * Rabby) or a native Miden wallet (wired next). Whatever connects, Cash +
 * Deposit/Withdraw work through the unified @miden-sdk/react hooks.
 */

import { CSSProperties, useCallback, useEffect, useState } from "react";
import { useMiden, useSigner } from "@miden-sdk/react";
import { useModal } from "@miden-sdk/use-miden-para-react";
import { formatUnits } from "viem";

import { EPOCH_USDC_SEPOLIA } from "../../lib/epoch";
import { ParaFundingPanel } from "./ParaFundingPanel";
import { LogoFull } from "../Logo";

function short(v: string | null | undefined, head = 6, tail = 4) {
  if (!v) return "";
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}

const label: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--ink-3)",
};
const value: CSSProperties = {
  fontFamily: "var(--font-mono-stack)",
  fontSize: 15,
  fontWeight: 600,
  color: "var(--ink)",
};

export function ParaAppShell() {
  const signer = useSigner();
  const { openModal } = useModal();
  const { client, runExclusive, signerAccountId, isReady } = useMiden() as unknown as {
    client: unknown;
    runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>;
    signerAccountId: string | null;
    isReady: boolean;
  };
  const connected = !!signer?.isConnected && !!signerAccountId;

  const [dusdc, setDusdc] = useState<bigint | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const refreshBalance = useCallback(async () => {
    if (!client || !signerAccountId) return;
    try {
      const { AccountId } = await import("@miden-sdk/miden-sdk");
      const faucet = AccountId.fromHex(EPOCH_USDC_SEPOLIA.midenFaucetId);
      const acc = (await runExclusive(() =>
        (client as { getAccount: (id: unknown) => Promise<unknown> }).getAccount(
          AccountId.fromHex(signerAccountId),
        ),
      )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
      setDusdc(acc ? BigInt(acc.vault().getBalance(faucet) ?? 0n) : 0n);
    } catch {
      /* vault not synced yet */
    }
  }, [client, signerAccountId, runExclusive]);

  useEffect(() => {
    if (isReady && signerAccountId) refreshBalance();
  }, [isReady, signerAccountId, refreshBalance]);
  useEffect(() => {
    if (!depositOpen && connected) refreshBalance();
  }, [depositOpen, connected, refreshBalance]);

  const cash = dusdc != null ? Number(formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals)) : 0;
  const cashUsd = cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--paper)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans-stack)",
      }}
    >
      {/* Top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px clamp(20px, 4vw, 40px)",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <span className="nav-logo" style={{ display: "flex" }}>
          <LogoFull aria-label="Darwin" />
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          {connected && (
            <>
              <div style={{ textAlign: "right" }}>
                <div style={label}>Portfolio</div>
                <div style={value}>$0.00</div>
              </div>
              <button
                type="button"
                onClick={() => setDepositOpen(true)}
                style={{ textAlign: "right", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                title="Add or withdraw funds"
              >
                <div style={label}>Cash</div>
                <div style={{ ...value, color: "var(--green)" }}>${cashUsd}</div>
              </button>
              <button type="button" className="nav-cta" onClick={() => setDepositOpen(true)}>
                Deposit
              </button>
              <button
                type="button"
                className="nav-cta"
                onClick={() => signer?.disconnect()}
                title={signerAccountId ?? ""}
                style={{ fontFamily: "var(--font-mono-stack)", fontSize: 12 }}
              >
                {short(signerAccountId)} ⏻
              </button>
            </>
          )}
          {!connected && (
            <button type="button" className="nav-cta" onClick={() => setConnectOpen(true)}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <main style={{ maxWidth: "var(--max)", margin: "0 auto", padding: "clamp(40px, 8vh, 96px) clamp(20px, 4vw, 40px)" }}>
        {connected ? (
          <div
            style={{
              background: "var(--paper-2)",
              border: "1px solid var(--rule)",
              borderRadius: 16,
              padding: "clamp(24px, 4vw, 40px)",
              maxWidth: 640,
            }}
          >
            <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Welcome to Darwin</h1>
            <p style={{ marginTop: 8, color: "var(--ink-3)" }}>
              Your Miden account is ready. You hold{" "}
              <span style={{ fontFamily: "var(--font-mono-stack)", color: "var(--green)" }}>${cashUsd}</span> in dUSDC.
            </p>
            <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>
              Use{" "}
              <button
                type="button"
                onClick={() => setDepositOpen(true)}
                style={{ background: "none", border: "none", padding: 0, color: "var(--orange)", cursor: "pointer", textDecoration: "underline" }}
              >
                Deposit
              </button>{" "}
              to add or withdraw funds. Baskets are coming next.
            </p>
          </div>
        ) : (
          <div style={{ maxWidth: 540, margin: "0 auto", textAlign: "center" }}>
            <h1 style={{ fontSize: 34, fontWeight: 600, margin: 0, letterSpacing: "-0.02em" }}>
              One token, a whole strategy
            </h1>
            <p style={{ marginTop: 12, color: "var(--ink-3)" }}>
              Sign in to get a Miden account and fund it from your own wallet.
            </p>
            <button type="button" className="nav-cta" style={{ marginTop: 24 }} onClick={() => setConnectOpen(true)}>
              Connect wallet
            </button>
          </div>
        )}
      </main>

      {/* Connect-choice modal */}
      {connectOpen && !connected && (
        <Overlay onClose={() => setConnectOpen(false)}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Connect</h2>
          <p style={{ marginTop: 4, fontSize: 14, color: "var(--ink-3)" }}>Choose how you want to sign in.</p>
          <button type="button" onClick={() => { setConnectOpen(false); openModal?.(); }} style={choiceBtn}>
            <div style={{ fontWeight: 600 }}>Continue with Para</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Email, Google, X, passkey, or MetaMask / Rabby</div>
          </button>
          <button type="button" disabled style={{ ...choiceBtn, opacity: 0.55, cursor: "not-allowed" }}>
            <div style={{ fontWeight: 600 }}>Connect a Miden wallet</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Native Miden wallet (MidenFi) — coming next</div>
          </button>
        </Overlay>
      )}

      {/* Deposit / Withdraw modal */}
      {depositOpen && (
        <Overlay onClose={() => setDepositOpen(false)}>
          <ParaFundingPanel />
        </Overlay>
      )}
    </div>
  );
}

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

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflowY: "auto",
        background: "rgba(11,11,12,0.55)",
        padding: "40px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--paper)",
          border: "1px solid var(--rule)",
          borderRadius: 18,
          padding: 22,
          boxShadow: "0 20px 60px rgba(11,11,12,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-3)" }}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
