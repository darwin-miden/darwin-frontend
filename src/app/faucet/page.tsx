import { FaucetPanelClient } from "../../components/FaucetPanelClient";
import { NavBar } from "../../components/NavBar";

export const metadata = {
  title: "Faucet",
  description: "Mint Darwin testnet assets (dETH, dWBTC, dUSDT, dDAI) into your Miden wallet.",
};

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
          Connect your Miden wallet, click <em>Drip</em> on an asset row to
          have the server mint a small public P2ID note from the faucet to
          your wallet, then click <em>Claim</em> when the row swaps — that
          consumes the note into your vault via a single MidenFi popup.
          Per-mint amounts are intentionally tiny: the per-faucet{" "}
          <code>max_supply</code> caps how much can ever exist on this
          testnet generation (e.g. <code>dWBTC</code> totals at 0.01 across
          all users).
        </p>
        <FaucetPanelClient />
      </main>
    </>
  );
}
