"use client";

/**
 * NEAR Intents 1Click deposit path, brokered by darwin-relay v2.
 *
 * Flow (proposal §Flow A, ETH-user variant):
 *
 *   1. POST /v0/intents       (relay v2) — declares basket symbol + amount
 *                              and gets back correlation_id + the relay's
 *                              Miden recipient address.
 *   2. POST /v0/quote         (1Click) — recipient = relay's Miden address
 *   3. wallet.sendTransaction (Sepolia) — user funds the deposit address
 *   4. POST /v0/deposit/submit (1Click) — txHash + depositAddress
 *   5. POST /v0/intents/:id/deposit (relay v2) — hand the relay the same
 *                              two values so it can drive its own polling
 *                              and mark the intent KNOWN_DEPOSIT_TX
 *   6. GET  /v0/intents/:id   (relay v2) — single source of truth for UI
 *      state, walks QUOTED → KNOWN_DEPOSIT_TX → PROCESSING →
 *      ONECLICK_SUCCESS → POSITION_CREDITED
 *
 * The user never has to enter a Miden recipient — the relay holds the
 * basket position on their behalf, keyed by their EVM address.
 */

import { useAccount, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { useEffect, useState } from "react";
import { parseEther } from "viem";

import type { BasketDef } from "../lib/contracts";
import {
  ONE_CLICK_BRIDGE_URL,
  quote,
  submitDeposit,
  type OneClickQuoteResponse,
} from "../lib/oneClick";
import {
  attachDeposit,
  createIntent,
  getIntent,
  RELAY_V2_URL,
  type RelayIntent,
  type RelayIntentCreateResponse,
} from "../lib/relayV2";

interface Props {
  basket: BasketDef;
}

type Stage =
  | "idle"
  | "claiming-intent"
  | "quoting"
  | "awaiting-tx"
  | "tx-sent"
  | "notifying"
  | "polling"
  | "success"
  | "error";

export function OneClickDepositPanel({ basket }: Props) {
  const { address, isConnected } = useAccount();
  const [amountEth, setAmountEth] = useState<string>("0.00001");
  const [stage, setStage] = useState<Stage>("idle");
  const [intentInit, setIntentInit] = useState<RelayIntentCreateResponse | null>(null);
  const [quoteResp, setQuoteResp] = useState<OneClickQuoteResponse | null>(null);
  const [relayIntent, setRelayIntent] = useState<RelayIntent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendTx = useSendTransaction();
  const wait = useWaitForTransactionReceipt({
    hash: sendTx.data,
    query: { enabled: !!sendTx.data },
  });

  // Once the Sepolia tx lands, notify both 1Click and the relay.
  useEffect(() => {
    if (stage !== "tx-sent" || !wait.data || !quoteResp || !intentInit) return;
    setStage("notifying");
    (async () => {
      try {
        await submitDeposit({
          txHash: wait.data.transactionHash,
          depositAddress: quoteResp.quote.depositAddress,
        });
        await attachDeposit(intentInit.correlation_id, {
          deposit_address: quoteResp.quote.depositAddress,
          sepolia_tx: wait.data.transactionHash,
        });
        setStage("polling");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStage("error");
      }
    })();
  }, [stage, wait.data, quoteResp, intentInit]);

  // Poll the relay's view of the intent until terminal.
  useEffect(() => {
    if (stage !== "polling" || !intentInit) return;
    let cancel = false;
    const tick = async () => {
      try {
        const s = await getIntent(intentInit.correlation_id);
        if (cancel) return;
        setRelayIntent(s);
        if (s.stage === "POSITION_CREDITED") setStage("success");
        else if (s.stage === "ERROR") {
          setError(s.error || "relay reported ERROR");
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
  }, [stage, intentInit]);

  async function go() {
    setError(null);
    setIntentInit(null);
    setQuoteResp(null);
    setRelayIntent(null);
    if (!address) {
      setError("connect an ETH wallet first");
      setStage("error");
      return;
    }
    try {
      const amountWei = parseEther(amountEth || "0").toString();

      // 1. Claim an intent on the relay — get back correlation_id + relay Miden addr.
      setStage("claiming-intent");
      const intent = await createIntent({
        user_evm_addr: address,
        basket_symbol: basket.symbol,
        amount_in_wei: amountWei,
      });
      setIntentInit(intent);

      // 2. Quote 1Click — recipient = relay's Miden account, refundTo = user.
      setStage("quoting");
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
        recipient: intent.relay_miden_address,
        recipientType: "DESTINATION_CHAIN",
        deadline: "2027-01-01T00:00:00Z",
      });
      setQuoteResp(q);

      // 3. Wallet sends ETH to the bridge's deposit address.
      setStage("awaiting-tx");
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
    "claiming-intent": "Claiming intent on darwin-relay…",
    quoting: "Requesting 1Click quote…",
    "awaiting-tx": "Confirm in your wallet",
    "tx-sent": `Waiting for Sepolia confirmation (${sendTx.data?.slice(0, 10)}…)`,
    notifying: "Notifying 1Click + relay…",
    polling: relayIntent
      ? `Relay → ${relayIntent.stage}`
      : "Polling relay…",
    success: `🎯 Position credited — ${relayIntent?.basket_amount_minted ?? ""} ${basket.symbol}`,
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
        ETH wallet → {basket.symbol} (via 1Click + darwin-relay)
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
        Bridge Sepolia ETH to Miden via{" "}
        <a
          href="https://github.com/BrianSeong99/miden-testnet-bridge"
          target="_blank"
          rel="noreferrer"
          style={{ borderBottom: "1px dotted var(--rule)" }}
        >
          NEAR Intents 1Click
        </a>
        ; the darwin-relay custodial Miden wallet receives it and runs the
        atomic deposit so the basket position lives natively on Miden.
        You stay on your ETH wallet — no Miden key required.
      </p>
      <p
        style={{
          color: "var(--ink-3)",
          fontSize: 11,
          fontFamily: "var(--font-mono-stack)",
          margin: "0 0 12px",
        }}
      >
        1Click: <code>{ONE_CLICK_BRIDGE_URL}</code> · relay: <code>{RELAY_V2_URL}</code>
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
            : stage === "polling" || stage === "notifying" || stage === "claiming-intent"
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
        {!isConnected ? "Connect ETH wallet first" : `Deposit ${amountEth} ETH → ${basket.symbol}`}
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

      {intentInit && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono-stack)" }}>
          intent: <code>{intentInit.correlation_id.slice(0, 18)}…</code>
          {" · "}relay: <code>{intentInit.relay_miden_address.slice(0, 14)}…</code>
        </p>
      )}

      {quoteResp && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono-stack)" }}>
          1Click correlationId: <code>{quoteResp.correlationId.slice(0, 18)}…</code>
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

      {relayIntent?.atomic_deposit_tx && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono-stack)" }}>
          miden atomic_deposit:{" "}
          <code>{relayIntent.atomic_deposit_tx.slice(0, 18)}…</code>
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
