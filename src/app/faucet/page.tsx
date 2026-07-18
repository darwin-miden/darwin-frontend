import { FaucetPanelClient } from "../../components/FaucetPanelClient";
import { NavBar } from "../../components/NavBar";
import { SepoliaFaucetPanel } from "../../components/SepoliaFaucetPanel";

export const metadata = {
  title: "Faucet",
  description:
    "Mint testnet assets — USDC on Sepolia (MetaMask) and dUSDC/dETH/… on Miden (MidenFi).",
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
            marginBottom: 28,
            maxWidth: 720,
          }}
        >
          Two rails, two faucets. Mint <strong>USDC on Sepolia</strong> for the
          Self-custody rail (your MetaMask), and{" "}
          <strong>dUSDC / dETH / …</strong> on Miden for the Miden-wallet rail
          (MidenFi).
        </p>

        {/* Sepolia rail — MetaMask, public mint */}
        <SepoliaFaucetPanel />

        {/* Miden rail — permissionless dUSDC dispenser (its own heading) */}
        <FaucetPanelClient />
      </main>
    </>
  );
}
