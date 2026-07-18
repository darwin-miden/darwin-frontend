"use client";

/**
 * Sepolia testnet faucet — mints the Epoch mock USDC straight from the user's
 * own MetaMask (the token has a public mint()). This is the Self-custody rail's
 * collateral, so it lives here next to the Miden faucet: one page, both rails.
 * No server, no MidenFi — the user signs a mint from their own wallet.
 */
import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";

import { EPOCH_USDC_SEPOLIA } from "../lib/epoch";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const MINT_HUMAN = "100";

export function SepoliaFaucetPanel() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!address || !publicClient) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const b = (await publicClient.readContract({
          address: EPOCH_USDC_SEPOLIA.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        })) as bigint;
        if (!cancelled) setBalance(b);
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, nonce]);

  const mint = useCallback(async () => {
    if (!address || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const hash = await writeContractAsync({
        address: EPOCH_USDC_SEPOLIA.address,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [address, parseUnits(MINT_HUMAN, EPOCH_USDC_SEPOLIA.decimals)],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash }).catch(() => undefined);
      }
      setNonce((n) => n + 1);
    } catch (e) {
      setErr(String((e as Error).message ?? e).slice(0, 140));
    } finally {
      setBusy(false);
    }
  }, [address, busy, writeContractAsync, publicClient]);

  const human =
    balance != null
      ? Number(formatUnits(balance, EPOCH_USDC_SEPOLIA.decimals)).toLocaleString(
          undefined,
          { maximumFractionDigits: 2 },
        )
      : null;

  return (
    <section style={{ marginBottom: 40, maxWidth: 720 }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>
        Sepolia — Self-custody rail (MetaMask)
      </h2>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 14,
          lineHeight: 1.6,
          marginBottom: 16,
        }}
      >
        The test USDC has a public <code>mint()</code>, so you mint it straight
        from your own wallet — no server. This is the collateral for the
        Self-custody deposit rail.
      </p>

      {!isConnected ? (
        <div
          style={{
            background: "var(--surface-2, #efece3)",
            borderLeft: "3px solid var(--orange)",
            padding: "16px 20px",
          }}
        >
          <strong>Connect an EVM wallet</strong>
          <p style={{ color: "var(--ink-2)", fontSize: 14, margin: "6px 0 0" }}>
            Click <em>Connect Wallet</em> in the top nav (MetaMask).
          </p>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            background: "var(--surface-2, #efece3)",
            padding: "16px 20px",
          }}
        >
          <div style={{ fontFamily: "var(--font-mono-stack)", fontSize: 14 }}>
            USDC balance:{" "}
            <strong>{human == null ? "…" : `${human} USDC`}</strong>
          </div>
          <button
            type="button"
            onClick={mint}
            disabled={busy}
            className="nav-cta"
            style={{ padding: "6px 16px", fontSize: 13, opacity: busy ? 0.5 : 1 }}
          >
            {busy ? "Minting…" : `Get ${MINT_HUMAN} test USDC`}
          </button>
          {err && (
            <span style={{ color: "crimson", fontSize: 12 }}>{err}</span>
          )}
        </div>
      )}
    </section>
  );
}
