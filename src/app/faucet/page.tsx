import { Suspense } from "react";

import { FaucetPanel } from "../../components/FaucetPanel";
import { NavBar } from "../../components/NavBar";

export const metadata = {
  title: "Faucet — Darwin Protocol",
  description: "Mint Darwin testnet assets (dETH, dWBTC, dUSDT, dDAI) into your Miden wallet.",
};

// FaucetPanel reads useMidenFiWallet() which only resolves under the
// browser-side MidenProvider tree. Disable static prerender so the
// build doesn't try to invoke the wallet hook at export time.
export const dynamic = "force-dynamic";

export default function FaucetPage() {
  return (
    <>
      <NavBar />
      <main className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>
        <h1 style={{ fontSize: 28, fontWeight: 500, marginBottom: 8 }}>
          Testnet faucet
        </h1>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 14,
            lineHeight: 1.6,
            marginBottom: 24,
            maxWidth: 720,
          }}
        >
          Connect your Miden wallet and request a small drip of each constituent
          asset (dETH, dWBTC, dUSDT, dDAI). Notes are emitted as public P2ID
          and your wallet auto-consumes them on the next sync. Per-mint amounts
          are intentionally tiny — the per-faucet <code>max_supply</code> caps
          how much can ever exist on this testnet generation.
        </p>
        <Suspense fallback={<p>loading…</p>}>
          <FaucetPanel />
        </Suspense>
      </main>
    </>
  );
}
