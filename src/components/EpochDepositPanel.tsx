"use client";

/**
 * Epoch protocol deposit path — Sepolia → Miden, hosted backend.
 *
 * Drop-in replacement for OneClickDepositPanel: same UX shape (claim
 * intent on darwin-relay → bridge → poll), same final state machine
 * walked by the relay. Difference: Epoch's hosted allocator + solver
 * replace the local 1Click mock, so deposits stop requiring the host
 * laptop to be running the Docker mock.
 *
 * Asset: Epoch's test USDC on Sepolia (18-decimal at
 * `0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69`) bridges to dUSDC at
 * Miden faucet `0x0a7d175ed63ec5200fb2ced86f6aa5`. The relay wallet is
 * the Miden recipient (custodial), and the existing relay worker emits
 * `atomic_deposit_note` against the v7 controller to credit slot-10.
 *
 * For the relay worker to consume the new asset, set
 * `DARWIN_RELAY_V2_FAUCET_HEX=0x0a7d175ed63ec5200fb2ced86f6aa5` in
 * `com.darwin.relay-v2-worker.plist`.
 */

import { useAccount, useChainId, useWalletClient } from "wagmi";
import { useEffect, useRef, useState } from "react";

import type { BasketDef } from "../lib/contracts";
import {
  attachDeposit,
  createIntent,
  getIntent,
  RELAY_V2_URL,
  type RelayIntent,
  type RelayIntentCreateResponse,
} from "../lib/relayV2";
import {
  ALLOCATOR_URL,
  EPOCH_USDC_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  dusdcMidenBaseUnits,
  extractNonce,
  fetchQuote,
  submitIntent,
  usdcSepoliaBaseUnits,
  type EpochQuote,
} from "../lib/epoch";

interface Props {
  basket: BasketDef;
}

const BASKET_TOKEN_DECIMALS = 8;
function formatBasketAmount(raw: string | null | undefined): string {
  if (!raw) return "—";
  let n: bigint;
  try {
    n = BigInt(raw);
  } catch {
    return raw;
  }
  const base = 10n ** BigInt(BASKET_TOKEN_DECIMALS);
  const whole = n / base;
  const frac = n % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac
    .toString()
    .padStart(BASKET_TOKEN_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

type Stage =
  | "idle"
  | "claiming-intent"
  | "quoting"
  | "quote-ready"
  | "submitting"
  | "polling"
  | "success"
  | "error";

export function EpochDepositPanel({ basket }: Props) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();

  // Epoch's testnet-dev solver has draining dUSDC liquidity — the
  // working cap trended down from 0.77 → 0.1 dUSDC over a handful of
  // deposits 2026-06-10 (each successful deposit drains the solver
  // further). 0.1 is the largest amount that quotes reliably right
  // now. Bump back up once Epoch tops up the solver.
  const [usdcOut, setUsdcOut] = useState("0.1");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [intentInit, setIntentInit] = useState<RelayIntentCreateResponse | null>(
    null,
  );
  const [quote, setQuote] = useState<EpochQuote | null>(null);
  const [intentNonce, setIntentNonce] = useState<string | null>(null);
  const [relayIntent, setRelayIntent] = useState<RelayIntent | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkRef = useRef<any>(null);

  // Lazy-import the SDK + bind it to the wagmi wallet client. Re-init on
  // wallet change. The bridging-app tutorial does this in a useEffect
  // because React 19 StrictMode double-mount would otherwise create two
  // SDK instances.
  useEffect(() => {
    if (!walletClient) {
      sdkRef.current = null;
      return;
    }
    let cancelled = false;
    import("@epoch-protocol/epoch-intents-sdk")
      .then(({ EpochIntentSDK }) => {
        if (cancelled) return;
        sdkRef.current = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          walletClient: walletClient as any,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[Epoch] SDK load failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [walletClient]);

  // Poll the relay until POSITION_CREDITED once the intent is submitted.
  useEffect(() => {
    if (stage !== "polling" || !intentInit) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const it = await getIntent(intentInit.correlation_id);
        if (cancelled) return;
        setRelayIntent(it);
        if (it.stage === "POSITION_CREDITED") {
          setStage("success");
          return;
        }
        if (it.stage === "ERROR") {
          setError(it.error ?? "relay marked intent ERROR");
          setStage("error");
          return;
        }
      } catch (err) {
        console.warn("[Epoch] poll failed:", err);
      }
      setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [stage, intentInit]);

  async function handleQuote() {
    if (!sdkRef.current) {
      setError("Epoch SDK not ready — connect wallet first");
      return;
    }
    if (!address) {
      setError("Connect Sepolia wallet first");
      return;
    }
    if (chainId !== SEPOLIA_CHAIN_ID) {
      setError(`Wrong network — switch to Sepolia (current ${chainId})`);
      return;
    }
    setError(null);
    try {
      // Claim a relay intent — gives us the Miden recipient (relay wallet).
      // amount_in_wei uses Sepolia 18-dec (the worker converts via
      // wei_per_miden_base = 10^12 to get Miden 6-dec base units).
      setStage("claiming-intent");
      const intent = await createIntent({
        user_evm_addr: address,
        basket_symbol: basket.symbol,
        amount_in_wei: usdcSepoliaBaseUnits(usdcOut),
      });
      setIntentInit(intent);

      setStage("quoting");
      // minTokenOut is Miden-side base units (6-dec) — that's what
      // Epoch's allocator quotes against.
      const q = await fetchQuote(sdkRef.current, {
        evmSourceAddress: address as `0x${string}`,
        midenRecipientId: intent.relay_miden_address,
        minTokenOut: dusdcMidenBaseUnits(usdcOut),
      });
      setQuote(q);
      setStage("quote-ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  async function handleConfirm() {
    if (!sdkRef.current || !quote || !intentInit) {
      setError("Missing quote or intent");
      return;
    }
    setError(null);
    setStage("submitting");
    try {
      const result = await submitIntent(sdkRef.current, quote);
      const nonce = extractNonce(result);
      setIntentNonce(nonce ?? null);
      // Hand the relay the EVM-side reference so it can track inbound
      // dUSDC on its Miden wallet and run atomic_deposit_note when
      // it arrives. Epoch's `solveIntent` returns the deposit tx hash
      // under `depositResult.transactionHash`.
      const depositTx =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)?.depositResult?.transactionHash ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result as any)?.transactionHash ??
        "";
      if (depositTx && /^0x[0-9a-fA-F]{64}$/.test(depositTx)) {
        try {
          // Epoch's Compact contract is the on-chain receiver, but the
          // relay only needs *some* valid Sepolia tx for its bookkeeping
          // — it doesn't enforce that the address belongs to a 1Click
          // bridge. Pass the Compact contract address.
          await attachDeposit(intentInit.correlation_id, {
            deposit_address: "0x00000000000000171ede64904551eeDF3C6C9788",
            sepolia_tx: depositTx,
          });
        } catch (err) {
          console.warn("[Epoch] attachDeposit failed (non-fatal):", err);
        }
      }
      setStage("polling");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  const stageLabel: Record<Stage, string> = {
    idle: "Ready",
    "claiming-intent": "Claiming intent on darwin-relay…",
    quoting: "Fetching Epoch quote…",
    "quote-ready": "Quote ready — review then confirm",
    submitting: "Signing Sepolia tx + submitting intent…",
    polling: relayIntent
      ? `Relay → ${relayIntent.stage}`
      : intentNonce
        ? `Polling Epoch (nonce ${intentNonce.slice(0, 10)}…)`
        : "Polling relay…",
    success: `🎯 Position credited — ${formatBasketAmount(relayIntent?.basket_amount_minted)} ${basket.symbol}`,
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
        ETH wallet → {basket.symbol} (via Epoch + darwin-relay)
      </h3>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 13,
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 12,
        }}
      >
        Bridge Sepolia USDC to Miden via Epoch protocol. Epoch hosts the
        allocator + solver — no local backend, no laptop dependency. The
        darwin-relay custodial wallet receives the dUSDC P2ID note on
        Miden and runs the atomic deposit so the position lives natively
        on Miden.
      </p>
      <p style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 0 }}>
        allocator: <code style={{ fontSize: 11 }}>{ALLOCATOR_URL}</code> · relay:{" "}
        <code style={{ fontSize: 11 }}>{RELAY_V2_URL}</code>
      </p>

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: "var(--ink-2)" }}>
          Amount (USDC) — pay {EPOCH_USDC_SEPOLIA.symbol} on Sepolia
        </label>
        <input
          type="text"
          value={usdcOut}
          onChange={(e) => setUsdcOut(e.target.value)}
          disabled={
            stage !== "idle" && stage !== "error" && stage !== "quote-ready"
          }
          style={{
            display: "block",
            width: "100%",
            padding: "6px 10px",
            marginTop: 4,
            fontFamily: "monospace",
            fontSize: 14,
            background: "var(--paper-1)",
            border: "1px solid var(--rule)",
          }}
        />
      </div>

      {stage !== "quote-ready" && stage !== "polling" && stage !== "success" && (
        <button
          onClick={handleQuote}
          disabled={
            !walletClient ||
            !address ||
            stage === "claiming-intent" ||
            stage === "quoting" ||
            stage === "submitting"
          }
          style={{
            marginTop: 14,
            padding: "8px 16px",
            background: "var(--orange)",
            color: "white",
            border: 0,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Get quote for {usdcOut} {basket.symbol}
        </button>
      )}

      {stage === "quote-ready" && quote && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "var(--paper-1)",
            border: "1px solid var(--rule)",
          }}
        >
          <p style={{ fontSize: 12, margin: 0, color: "var(--ink-2)" }}>
            Required USDC input (from Epoch quote)
          </p>
          <p
            style={{
              fontFamily: "monospace",
              fontSize: 18,
              margin: "4px 0 8px",
            }}
          >
            {quote.quoteResult.tokenIn ?? "—"} base units
          </p>
          <button
            onClick={handleConfirm}
            style={{
              padding: "8px 16px",
              background: "var(--orange)",
              color: "white",
              border: 0,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Confirm & sign
          </button>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 13 }}>
        <span style={{ color: "var(--ink-2)" }}>Status:</span>{" "}
        <strong>{stageLabel[stage]}</strong>
      </div>

      {intentInit && (
        <p style={{ marginTop: 8, fontSize: 11, color: "var(--ink-2)" }}>
          intent:{" "}
          <code style={{ fontSize: 11 }}>
            {intentInit.correlation_id.slice(0, 16)}…
          </code>{" "}
          · relay miden:{" "}
          <code style={{ fontSize: 11 }}>
            {intentInit.relay_miden_address.slice(0, 14)}…
          </code>
        </p>
      )}
      {intentNonce && (
        <p style={{ marginTop: 4, fontSize: 11, color: "var(--ink-2)" }}>
          epoch nonce: <code style={{ fontSize: 11 }}>{intentNonce}</code>
        </p>
      )}
      {error && (
        <p
          style={{
            marginTop: 8,
            fontSize: 12,
            color: "#a30000",
            background: "#fff0f0",
            padding: "6px 10px",
            border: "1px solid #f6cdcd",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
