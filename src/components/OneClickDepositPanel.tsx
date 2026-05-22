"use client";

/**
 * NEAR Intents 1Click deposit path.
 *
 * Third deposit rail next to "Ethereum (Sepolia)" (darwin-relay) and
 * "Miden native" (custom note via Web SDK). Speaks the 1Click API
 * shape from `BrianSeong99/miden-testnet-bridge` -- a NEAR Intents-
 * grade mock the Miden DevRel team published for builder testing.
 *
 *   1. Fetch a quote        POST /v0/quote
 *   2. User wallet sends    cast send <depositAddress> ...
 *   3. Notify the bridge    POST /v0/deposit/submit
 *   4. Poll status          GET  /v0/status?depositAddress=...
 *   5. Bridge mints a       P2ID note on Miden -> user picks it up
 *      in the Inbox section of /portfolio.
 *
 * When NEAR ships the hosted 1Click endpoint for Miden,
 * `NEXT_PUBLIC_ONECLICK_URL` flips and this path becomes prod.
 */

import { useAccount, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { useEffect, useState } from "react";
import { parseEther } from "viem";

import type { BasketDef } from "../lib/contracts";
import {
  getStatus,
  ONE_CLICK_BRIDGE_URL,
  quote,
  submitDeposit,
  type OneClickQuoteResponse,
  type OneClickStatusResponse,
} from "../lib/oneClick";

interface Props {
  basket: BasketDef;
}

type Stage =
  | "idle"
  | "quoting"
  | "awaiting-tx"
  | "tx-sent"
  | "notifying-bridge"
  | "polling"
  | "success"
  | "error";

export function OneClickDepositPanel({ basket }: Props) {
  const { address, isConnected } = useAccount();
  const [amountEth, setAmountEth] = useState<string>("0.00001");
  const [stage, setStage] = useState<Stage>("idle");
  const [quoteResp, setQuoteResp] = useState<OneClickQuoteResponse | null>(null);
  const [statusResp, setStatusResp] = useState<OneClickStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [midenRecipient, setMidenRecipient] = useState<string>("0xed3cd5befa3207805f8529207cfc0d");

  const sendTx = useSendTransaction();
  const wait = useWaitForTransactionReceipt({
    hash: sendTx.data,
    query: { enabled: !!sendTx.data },
  });

  // Once the deposit tx lands, notify the bridge and start polling.
  useEffect(() => {
    if (stage !== "tx-sent" || !wait.data || !quoteResp) return;
    setStage("notifying-bridge");
    submitDeposit({
      txHash: wait.data.transactionHash,
      depositAddress: quoteResp.quote.depositAddress,
    })
      .then(() => setStage("polling"))
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStage("error");
      });
  }, [stage, wait.data, quoteResp]);

  // Poll status every 5s while not terminal.
  useEffect(() => {
    if (stage !== "polling" || !quoteResp) return;
    let cancel = false;
    const tick = async () => {
      try {
        const s = await getStatus(quoteResp.quote.depositAddress);
        if (cancel) return;
        setStatusResp(s);
        if (s.status === "SUCCESS") setStage("success");
        else if (s.status === "REFUNDED" || s.status === "FAILED") {
          setError(`bridge ${s.status}`);
          setStage("error");
        }
      } catch (e) {
        if (cancel) return;
        setError(e instanceof Error ? e.message : String(e));
        setStage("error");
      }
    };
    void tick();
    const t = setInterval(tick, 5_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, [stage, quoteResp]);

  async function go() {
    setError(null);
    setQuoteResp(null);
    setStatusResp(null);
    if (!address) {
      setError("connect an ETH wallet first");
      setStage("error");
      return;
    }
    setStage("quoting");
    try {
      const amountWei = parseEther(amountEth || "0").toString();
      const q = await quote({
        dry: false,
        depositMode: "SIMPLE",
        swapType: "EXACT_INPUT",
        slippageTolerance: 100.0,
        originAsset: "eth-sepolia:eth",
        depositType: "ORIGIN_CHAIN",
        destinationAsset: "miden-testnet:eth",
        amount: amountWei,
        refundTo: address,
        refundType: "ORIGIN_CHAIN",
        recipient: midenRecipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: "2027-01-01T00:00:00Z",
      });
      setQuoteResp(q);
      setStage("awaiting-tx");
      // Trigger wagmi: send ETH to the deposit address.
      sendTx.sendTransaction({
        to: q.quote.depositAddress as `0x${string}`,
        value: BigInt(q.quote.amountIn),
      });
      setStage("tx-sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  const stageLabel: Record<Stage, string> = {
    idle: "Ready",
    quoting: "Requesting quote from bridge…",
    "awaiting-tx": "Confirm in your wallet",
    "tx-sent": `Waiting for Sepolia confirmation (${sendTx.data?.slice(0, 10)}…)`,
    "notifying-bridge": "Notifying bridge with tx hash…",
    polling: "Bridge processing — polling /v0/status",
    success: "🎯 Bridge SUCCESS — P2ID note minted on Miden",
    error: "Error",
  };

  return (
    <div
      style={{
        padding: "1.2rem 1.4rem",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>
        NEAR Intents 1Click → {basket.symbol}
      </h3>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 13,
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 6,
        }}
      >
        Sepolia → Miden testnet bridge via the{" "}
        <a
          href="https://github.com/BrianSeong99/miden-testnet-bridge"
          target="_blank"
          rel="noreferrer"
          style={{ borderBottom: "1px dotted var(--rule)" }}
        >
          BrianSeong99/miden-testnet-bridge
        </a>{" "}
        mock (Miden DevRel). API shape matches NEAR Intents 1Click verbatim;
        production swap is the hosted endpoint URL.
      </p>
      <p
        style={{
          color: "var(--ink-3)",
          fontSize: 11,
          fontFamily: "var(--font-mono-stack)",
          margin: "0 0 12px",
        }}
      >
        target: <code>{ONE_CLICK_BRIDGE_URL}</code>
      </p>

      <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: "var(--ink-3)" }}>
          Amount (ETH)
          <input
            type="number"
            value={amountEth}
            onChange={(e) => setAmountEth(e.target.value)}
            min={0}
            step={0.00001}
            disabled={stage !== "idle" && stage !== "error" && stage !== "success"}
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
          Miden recipient (your private wallet)
          <input
            type="text"
            value={midenRecipient}
            onChange={(e) => setMidenRecipient(e.target.value)}
            disabled={stage !== "idle" && stage !== "error" && stage !== "success"}
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
        disabled={
          !isConnected ||
          (stage !== "idle" && stage !== "error" && stage !== "success")
        }
        style={{
          width: "100%",
          padding: "12px 16px",
          background: !isConnected
            ? "var(--paper-2)"
            : stage === "polling" || stage === "notifying-bridge"
              ? "var(--ink-3)"
              : "var(--ink)",
          color: !isConnected ? "var(--ink-3)" : "var(--paper)",
          border: !isConnected ? "1px solid var(--rule)" : 0,
          cursor:
            !isConnected ||
            (stage !== "idle" && stage !== "error" && stage !== "success")
              ? "not-allowed"
              : "pointer",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        {!isConnected ? "Connect ETH wallet first" : `Bridge ${amountEth} ETH → Miden`}
      </button>

      <p
        style={{
          marginTop: 10,
          fontSize: 12,
          color: stage === "error" ? "#a01a1a" : "var(--ink-2)",
          fontFamily: "var(--font-mono-stack)",
        }}
      >
        {stageLabel[stage]}
      </p>

      {quoteResp && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono-stack)" }}>
          correlationId: <code>{quoteResp.correlationId.slice(0, 18)}…</code>
          {" · "}deposit: <code>{quoteResp.quote.depositAddress.slice(0, 14)}…</code>
        </p>
      )}

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

      {statusResp && statusResp.swapDetails.destinationChainTxHashes.length > 0 && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono-stack)" }}>
          miden tx:{" "}
          <code>{statusResp.swapDetails.destinationChainTxHashes[0].hash.slice(0, 18)}…</code>
        </p>
      )}

      {error && (
        <pre
          style={{
            marginTop: 8,
            padding: 8,
            background: "#fff0f0",
            fontSize: 11,
            overflowX: "auto",
            color: "#a01a1a",
          }}
        >
          {error}
        </pre>
      )}
    </div>
  );
}
