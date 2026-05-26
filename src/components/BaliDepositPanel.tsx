"use client";

/**
 * Bali agglayer L1→L2 test panel.
 *
 * Lets a user submit a Sepolia → Miden bridge deposit through the
 * canonical Bali agglayer (gateway-fm) and watch the lifecycle in
 * real time:
 *
 *   1. wallet.sendTransaction → bridgeAsset(76, dest, amount, 0x0, true, 0x)
 *   2. tx confirms on Sepolia
 *   3. bridge service indexes the deposit (`/api/bridges/:dest`)
 *   4. ready_for_claim flips to true (post-aggsender push)
 *   5. claim_tx_hash appears (P2ID note minted on Miden)
 *
 * Status is polled every 30s against the bridge service. The default
 * destination is the demo relay wallet so the wallet that's already
 * tracked in the local miden-client picks it up — adjust if you want
 * to send to a different Miden account.
 */

import { useAccount, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { encodeFunctionData, parseEther } from "viem";
import { useEffect, useMemo, useState } from "react";

import {
  BALI_BRIDGE_ABI,
  BALI_BRIDGE_ADDRESS,
  BALI_BRIDGE_SERVICE,
  BALI_NETWORK_ID,
  listBridgesForDest,
  midenToEthDest,
  type BaliBridgeDeposit,
} from "../lib/bali";

const DEFAULT_MIDEN_DEST = "0xed3cd5befa3207805f8529207cfc0d";

type Stage =
  | "idle"
  | "awaiting-wallet"
  | "tx-sent"
  | "indexing"
  | "ready-to-claim"
  | "claimed"
  | "error";

export function BaliDepositPanel() {
  const { isConnected } = useAccount();
  const [amountEth, setAmountEth] = useState("0.001");
  const [midenDest, setMidenDest] = useState(DEFAULT_MIDEN_DEST);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bridgeRow, setBridgeRow] = useState<BaliBridgeDeposit | null>(null);

  const sendTx = useSendTransaction();
  const wait = useWaitForTransactionReceipt({
    hash: sendTx.data,
    query: { enabled: !!sendTx.data },
  });

  const ethDest = useMemo(() => {
    try {
      return midenToEthDest(midenDest);
    } catch {
      return null;
    }
  }, [midenDest]);

  // Once the Sepolia tx confirms, start polling the bridge service.
  useEffect(() => {
    if (stage !== "tx-sent" || !wait.data || !sendTx.data || !ethDest) return;
    setStage("indexing");
    let cancel = false;
    const tick = async () => {
      try {
        const deposits = await listBridgesForDest(ethDest);
        if (cancel) return;
        const ours = deposits.find(
          (d) => d.tx_hash.toLowerCase() === sendTx.data!.toLowerCase(),
        );
        if (!ours) return; // not indexed yet — keep polling
        setBridgeRow(ours);
        if (ours.claim_tx_hash && ours.claim_tx_hash !== "") {
          setStage("claimed");
        } else if (ours.ready_for_claim) {
          setStage("ready-to-claim");
        }
      } catch (e) {
        if (!cancel) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void tick();
    const t = setInterval(tick, 30_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, [stage, wait.data, sendTx.data, ethDest]);

  async function go() {
    setError(null);
    setBridgeRow(null);
    if (!ethDest) {
      setError("invalid miden destination — must be 30 hex chars (15 bytes)");
      setStage("error");
      return;
    }
    const amountWei = parseEther(amountEth || "0");
    if (amountWei === 0n) {
      setError("amount must be > 0");
      setStage("error");
      return;
    }
    setStage("awaiting-wallet");
    try {
      const data = encodeFunctionData({
        abi: BALI_BRIDGE_ABI,
        functionName: "bridgeAsset",
        args: [
          BALI_NETWORK_ID,
          ethDest,
          amountWei,
          "0x0000000000000000000000000000000000000000",
          true,
          "0x",
        ],
      });
      sendTx.sendTransaction({
        to: BALI_BRIDGE_ADDRESS,
        value: amountWei,
        data,
      });
      setStage("tx-sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  const label: Record<Stage, string> = {
    idle: "Ready",
    "awaiting-wallet": "Confirm in your wallet…",
    "tx-sent": "Waiting for Sepolia confirmation…",
    indexing: "Bridge service indexing — polling /api/bridges every 30 s",
    "ready-to-claim": "aggsender pushed — ready_for_claim ✓ (claim mint in flight)",
    claimed: "🎯 Bali claim minted — P2ID note now on Miden",
    error: "Error",
  };

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
        Bali agglayer L1 L2 test
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Canonical Sepolia → Miden bridge via gateway-fm's Bali outpost
        (network 76, post-relaunch). Calls{" "}
        <code>bridgeAsset</code> on the Sepolia bridge contract, then
        polls the bridge service for{" "}
        <code>ready_for_claim</code> + <code>claim_tx_hash</code>.{" "}
        <code style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {BALI_BRIDGE_SERVICE}
        </code>
      </p>

      {!isConnected && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          Connect an ETH wallet to test.
        </p>
      )}

      {isConnected && (
        <>
          <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
              Amount (ETH on Sepolia)
              <input
                type="number"
                value={amountEth}
                onChange={(e) => setAmountEth(e.target.value)}
                min={0}
                step={0.0001}
                disabled={stage !== "idle" && stage !== "error" && stage !== "claimed"}
                style={{
                  display: "block",
                  marginTop: 4,
                  width: "100%",
                  padding: "10px 12px",
                  fontFamily: "var(--font-mono-stack)",
                  background: "var(--paper)",
                  border: "1px solid var(--rule)",
                }}
              />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
              Miden destination (30 hex)
              <input
                type="text"
                value={midenDest}
                onChange={(e) => setMidenDest(e.target.value)}
                disabled={stage !== "idle" && stage !== "error" && stage !== "claimed"}
                style={{
                  display: "block",
                  marginTop: 4,
                  width: "100%",
                  padding: "10px 12px",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 12,
                  background: "var(--paper)",
                  border: "1px solid var(--rule)",
                }}
              />
            </label>
          </div>

          <button
            onClick={go}
            disabled={stage !== "idle" && stage !== "error" && stage !== "claimed"}
            style={{
              padding: "10px 16px",
              background:
                stage !== "idle" && stage !== "error" && stage !== "claimed"
                  ? "var(--ink-3)"
                  : "var(--ink)",
              color: "var(--paper)",
              border: 0,
              fontSize: 13,
              cursor:
                stage !== "idle" && stage !== "error" && stage !== "claimed"
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            Bridge {amountEth} ETH → Bali (net {BALI_NETWORK_ID})
          </button>

          <p
            style={{
              marginTop: 12,
              fontSize: 12,
              color: stage === "error" ? "#a01a1a" : "var(--ink-2)",
              fontFamily: "var(--font-mono-stack)",
            }}
          >
            {label[stage]}
          </p>

          {sendTx.data && (
            <p style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono-stack)" }}>
              sepolia tx:{" "}
              <a
                href={`https://sepolia.etherscan.io/tx/${sendTx.data}`}
                target="_blank"
                rel="noreferrer"
                style={{ borderBottom: "1px dotted var(--rule)" }}
              >
                {sendTx.data.slice(0, 18)}…
              </a>
            </p>
          )}

          {bridgeRow && (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                background: "var(--paper-2)",
                fontFamily: "var(--font-mono-stack)",
                fontSize: 11,
              }}
            >
              <div>deposit_cnt: {bridgeRow.deposit_cnt}</div>
              <div>dest_net:    {bridgeRow.dest_net}</div>
              <div>block:       {bridgeRow.block_num}</div>
              <div>ready:       {bridgeRow.ready_for_claim ? "true ✓" : "false"}</div>
              <div>
                claim_tx:{" "}
                {bridgeRow.claim_tx_hash ? (
                  <code>{bridgeRow.claim_tx_hash.slice(0, 18)}…</code>
                ) : (
                  "(empty)"
                )}
              </div>
            </div>
          )}

          {error && (
            <pre
              style={{
                marginTop: 8,
                padding: 8,
                background: "#fff0f0",
                fontSize: 11,
                color: "#a01a1a",
              }}
            >
              {error}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
