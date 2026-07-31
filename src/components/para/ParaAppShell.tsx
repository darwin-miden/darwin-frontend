"use client";

/**
 * Connected app shell (Polymarket-style): top bar with Portfolio / Cash /
 * Deposit / account, plus the funding+withdraw flow in a modal. Signer-AGNOSTIC
 * — it drives connect/disconnect through the unified `useSigner()`, so it works
 * identically under ParaProviders (Para) or MidenNativeProviders (MidenFi). The
 * Para-vs-Miden choice is made a level up (ParaApp), which mounts the matching
 * provider around this shell.
 *
 * Styled with the app's own CSS system (CSS vars + `nav-cta`) via inline styles
 * — the app does NOT use Tailwind.
 */

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useMiden, useSigner, useSyncState } from "@miden-sdk/react";
import { formatUnits } from "viem";

import { EPOCH_USDC_SEPOLIA } from "../../lib/epoch";
import { BASKETS } from "../../lib/baskets";
import { DepositMethods } from "./DepositMethods";
import { BasketBuyPanel } from "./BasketBuyPanel";
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

const shellRoot: CSSProperties = {
  minHeight: "100vh",
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans-stack)",
};
const topbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px clamp(20px, 4vw, 40px)",
  borderBottom: "1px solid var(--rule)",
};

export function ParaAppShell({ onExit }: { onExit: () => void }) {
  const signer = useSigner();
  const { client, runExclusive, signerAccountId, isReady } = useMiden() as unknown as {
    client: unknown;
    runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>;
    signerAccountId: string | null;
    isReady: boolean;
  };
  const { sync: syncState } = useSyncState();
  const connected = !!signer?.isConnected && !!signerAccountId;

  const [dusdc, setDusdc] = useState<bigint | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [buySymbol, setBuySymbol] = useState<string | null>(null);

  // Kick off the wallet connection once when this shell mounts (the method was
  // already chosen a level up). For Para this pops the Para modal; for MidenFi
  // it prompts the extension.
  const tried = useRef(false);
  useEffect(() => {
    if (!tried.current && !signer?.isConnected) {
      tried.current = true;
      Promise.resolve(signer?.connect?.()).catch(() => {});
    }
  }, [signer]);

  // Read the dUSDC vault balance. Sync FIRST — a `getAccount` without a fresh
  // sync returns the last-known (often stale/zero) state, which is why a funded
  // account can read $0.00 right after connecting or switching. Retry a couple of
  // times: the node may lag a beat behind the on-chain deposit.
  const refreshBalance = useCallback(async () => {
    if (!client || !signerAccountId) return;
    const { AccountId } = await import("@miden-sdk/miden-sdk");
    const faucet = AccountId.fromHex(EPOCH_USDC_SEPOLIA.midenFaucetId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runExclusive(() => syncState());
      } catch {
        /* sync mid-flight — read anyway */
      }
      try {
        const acc = (await runExclusive(() =>
          (client as { getAccount: (id: unknown) => Promise<unknown> }).getAccount(
            AccountId.fromHex(signerAccountId),
          ),
        )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null;
        const bal = acc ? BigInt(acc.vault().getBalance(faucet) ?? 0n) : 0n;
        setDusdc(bal);
        if (bal > 0n) return;
      } catch {
        /* vault not synced yet — retry */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, [client, signerAccountId, runExclusive, syncState]);

  useEffect(() => {
    if (isReady && signerAccountId) refreshBalance();
  }, [isReady, signerAccountId, refreshBalance]);
  useEffect(() => {
    if (!depositOpen && connected) refreshBalance();
  }, [depositOpen, connected, refreshBalance]);
  // Keep Cash live: poll while connected so a deposit made in the modal (or the
  // initial synced-in balance) shows up in the header without a manual reload.
  // Once the balance is non-zero, refreshBalance returns on the first read, so a
  // funded account polls cheaply (one sync).
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => {
      void refreshBalance();
    }, 10_000);
    return () => clearInterval(id);
  }, [connected, refreshBalance]);

  const cash = dusdc != null ? Number(formatUnits(dusdc, EPOCH_USDC_SEPOLIA.midenDecimals)) : 0;
  const cashUsd = cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function disconnect() {
    try {
      await signer?.disconnect?.();
    } catch {
      /* ignore */
    }
    onExit();
  }

  // Not connected yet (completing sign-in / user closed the modal).
  if (!connected) {
    return (
      <div style={shellRoot}>
        <header style={topbar}>
          <span className="nav-logo" style={{ display: "flex" }}>
            <LogoFull aria-label="Darwin" />
          </span>
          <button type="button" className="nav-cta" onClick={disconnect}>
            Cancel
          </button>
        </header>
        <main style={{ maxWidth: 480, margin: "0 auto", padding: "clamp(60px, 14vh, 160px) 20px", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Finishing sign-in…</h1>
          <p style={{ marginTop: 10, color: "var(--ink-3)" }}>
            A Para popup opens to finish sign-in. If your browser blocked it, allow
            popups for this site, then Retry — and sign the verification message your
            wallet prompts.
          </p>
          <button
            type="button"
            className="nav-cta"
            style={{ marginTop: 18 }}
            onClick={() => Promise.resolve(signer?.connect?.()).catch(() => {})}
          >
            Retry
          </button>
        </main>
      </div>
    );
  }

  return (
    <div style={shellRoot}>
      <header style={topbar}>
        <span className="nav-logo" style={{ display: "flex" }}>
          <LogoFull aria-label="Darwin" />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
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
            onClick={disconnect}
            title={signerAccountId ?? ""}
            style={{ fontFamily: "var(--font-mono-stack)", fontSize: 12 }}
          >
            {short(signerAccountId)} ⏻
          </button>
        </div>
      </header>

      <main style={{ maxWidth: "var(--max)", margin: "0 auto", padding: "clamp(32px, 6vh, 72px) clamp(20px, 4vw, 40px)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Baskets</h1>
          <p style={{ margin: 0, fontSize: 14, color: "var(--ink-3)" }}>
            You hold{" "}
            <span style={{ fontFamily: "var(--font-mono-stack)", color: "var(--green)" }}>${cashUsd}</span> in dUSDC ·{" "}
            <button
              type="button"
              onClick={() => setDepositOpen(true)}
              style={{ background: "none", border: "none", padding: 0, color: "var(--orange)", cursor: "pointer", textDecoration: "underline" }}
            >
              Deposit
            </button>
          </p>
        </div>

        <div
          style={{
            marginTop: 20,
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {BASKETS.map((b) => (
            <div
              key={b.symbol}
              style={{
                background: "var(--paper-2)",
                border: "1px solid var(--rule)",
                borderRadius: 16,
                padding: 20,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{b.name}</h2>
                <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 13, color: "var(--ink-3)" }}>{b.symbol}</span>
              </div>
              <p style={{ marginTop: 8, fontSize: 13, color: "var(--ink-3)", flex: 1 }}>{b.description}</p>
              <button
                type="button"
                className="nav-cta"
                style={{ marginTop: 16, width: "100%", textAlign: "center" }}
                onClick={() => setBuySymbol(b.symbol)}
              >
                Buy
              </button>
            </div>
          ))}
        </div>
      </main>

      {depositOpen && (
        <Overlay onClose={() => setDepositOpen(false)}>
          <DepositMethods />
        </Overlay>
      )}

      {buySymbol && (
        <Overlay onClose={() => setBuySymbol(null)}>
          <BasketBuyPanel
            symbol={buySymbol}
            name={BASKETS.find((b) => b.symbol === buySymbol)?.name ?? buySymbol}
            onDone={refreshBalance}
          />
        </Overlay>
      )}
    </div>
  );
}

export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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
