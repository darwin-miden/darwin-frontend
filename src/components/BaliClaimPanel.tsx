"use client";

/**
 * Bali L2→L1 claim panel.
 *
 * The canonical AggLayer L2→L1 flow is three steps:
 *
 *   1. burn on Miden (B2AGG note) — done by relay worker or
 *      bridge-out-tool
 *   2. wait for the agglayer certificate to settle (~30-90 min)
 *   3. **call claimAsset on the Sepolia bridge** — this panel
 *
 * Step 3 is permissionless and required — the Bali stack does not
 * auto-claim. Until someone submits it the funds sit on the L1
 * bridge contract.
 *
 * This panel mirrors darwin-infra/scripts/bali-l1-claim.sh in TS:
 * lists every L2→L1 deposit indexed for the connected EVM addr,
 * highlights the ones that are ready_for_claim=true with no
 * claim_tx_hash yet, and exposes a single-click "Claim on Sepolia"
 * button that fetches the merkle proof, builds the calldata, and
 * sends the tx via wagmi.
 *
 * Hidden unless an ETH wallet is connected (claimAsset is
 * permissionless, but UI-wise the recipient is by far the most
 * natural caller).
 */

import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useCallback, useEffect, useState } from "react";

import {
  BALI_BRIDGE_ABI,
  BALI_BRIDGE_ADDRESS,
  BALI_BRIDGE_SERVICE,
  buildClaimArgs,
  fetchMerkleProof,
  listBridgesForDest,
  type BaliBridgeDeposit,
} from "../lib/bali";

const SEPOLIA_EXPLORER_TX = "https://sepolia.etherscan.io/tx/";

export function BaliClaimPanel() {
  const { address, isConnected } = useAccount();
  const [deposits, setDeposits] = useState<BaliBridgeDeposit[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busyCnt, setBusyCnt] = useState<number | null>(null);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const {
    writeContractAsync,
    data: pendingTx,
    reset: resetWrite,
  } = useWriteContract();
  const { isLoading: txLoading, isSuccess: txOk } = useWaitForTransactionReceipt({
    hash: pendingTx,
  });

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const xs = await listBridgesForDest(address.toLowerCase());
      setDeposits(xs);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setDeposits(null);
      return;
    }
    void refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [isConnected, address, refresh]);

  // Auto-refresh after a successful claim so the row shows the new
  // claim_tx_hash without the user having to wait the 30s poll.
  useEffect(() => {
    if (txOk) {
      void refresh();
      setBusyCnt(null);
      resetWrite();
    }
  }, [txOk, refresh, resetWrite]);

  const handleClaim = useCallback(
    async (dep: BaliBridgeDeposit) => {
      setBusyCnt(dep.deposit_cnt);
      setClaimErr(null);
      try {
        const proof = await fetchMerkleProof(dep.deposit_cnt);
        const args = buildClaimArgs(dep, proof);
        await writeContractAsync({
          abi: BALI_BRIDGE_ABI,
          address: BALI_BRIDGE_ADDRESS,
          functionName: "claimAsset",
          args,
        });
        // success → useWaitForTransactionReceipt + the txOk effect
      } catch (e) {
        setClaimErr(e instanceof Error ? e.message : String(e));
        setBusyCnt(null);
      }
    },
    [writeContractAsync],
  );

  if (!isConnected) return null;

  const outbound = (deposits ?? []).filter((d) => d.dest_net === 0);
  const claimable = outbound.filter((d) => d.ready_for_claim && !d.claim_tx_hash);
  const claimed = outbound.filter((d) => !!d.claim_tx_hash);

  return (
    <section style={{ marginTop: 48 }}>
      <h2
        style={{
          fontSize: 14,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          borderBottom: "1px solid var(--ink)",
          paddingBottom: 8,
          marginBottom: 14,
        }}
      >
        Bali L2 → L1 claims
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Canonical AggLayer L2→L1 settlements waiting for the final
        Sepolia <code>claimAsset</code> call. The Bali stack settles
        the certificate but does not auto-claim — the recipient (or
        anyone) submits this tx to actually receive the bridged ETH.
        Service: <code>{BALI_BRIDGE_SERVICE}</code>.
      </p>

      {listError && (
        <pre
          style={{
            padding: 8,
            background: "#fff0f0",
            fontSize: 11,
            color: "#a01a1a",
            fontFamily: "var(--font-mono-stack)",
            marginBottom: 12,
          }}
        >
          bridge service: {listError}
        </pre>
      )}

      {deposits == null ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>loading…</div>
      ) : outbound.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          No L2→L1 deposits indexed for {address}. Burn some ETH via
          the relay redemption flow or <code>bridge-out-tool</code>
          first.
        </div>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: "var(--font-mono-stack)",
            fontSize: 12,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--rule)", color: "var(--ink-3)" }}>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>#</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>amount (wei)</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>ready</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>claim tx</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}></th>
            </tr>
          </thead>
          <tbody>
            {claimable.concat(claimed).map((d) => (
              <tr key={d.deposit_cnt} style={{ borderBottom: "1px solid var(--rule)" }}>
                <td style={{ padding: "6px 8px" }}>{d.deposit_cnt}</td>
                <td style={{ padding: "6px 8px" }}>{d.amount}</td>
                <td style={{ padding: "6px 8px" }}>
                  {d.ready_for_claim ? "✓" : "…"}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {d.claim_tx_hash ? (
                    <a
                      href={SEPOLIA_EXPLORER_TX + d.claim_tx_hash}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--ink)" }}
                    >
                      {d.claim_tx_hash.slice(0, 10)}…
                    </a>
                  ) : (
                    <span style={{ color: "var(--ink-3)" }}>—</span>
                  )}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  {d.claim_tx_hash ? (
                    <span style={{ color: "var(--ink-3)", fontSize: 11 }}>claimed</span>
                  ) : d.ready_for_claim ? (
                    <button
                      type="button"
                      onClick={() => void handleClaim(d)}
                      disabled={busyCnt === d.deposit_cnt || txLoading}
                      style={{
                        padding: "4px 10px",
                        fontSize: 11,
                        background: "var(--ink)",
                        color: "var(--paper)",
                        border: 0,
                        cursor: busyCnt === d.deposit_cnt ? "wait" : "pointer",
                      }}
                    >
                      {busyCnt === d.deposit_cnt && txLoading
                        ? "claiming…"
                        : busyCnt === d.deposit_cnt
                          ? "signing…"
                          : "Claim on Sepolia"}
                    </button>
                  ) : (
                    <span style={{ color: "var(--ink-3)", fontSize: 11 }}>not ready</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {claimErr && (
        <pre
          style={{
            marginTop: 10,
            padding: 8,
            background: "#fff0f0",
            fontSize: 11,
            color: "#a01a1a",
            fontFamily: "var(--font-mono-stack)",
          }}
        >
          claim error: {claimErr}
        </pre>
      )}
    </section>
  );
}
