"use client";

/**
 * Miden-native deposit panel. Mirrors the ETH-side `DepositPanel`
 * shape but talks directly to Miden via the Miden Web SDK — no
 * relay, no AggLayer hop, no wrapped ERC20.
 *
 * Flow: user picks an asset they hold on Miden (dETH, dWBTC, dUSDT,
 * dDAI from the testnet faucets), enters an amount, signs a P2ID
 * note from their MidenFi wallet to the basket controller. The
 * controller consumes the note in a separate tx and credits the
 * user's basket-token position.
 *
 * For the M3 launch we keep the UX intentionally simple: one asset
 * at a time. M4 will swap `useSend` for `useCompile` + a custom
 * multi-asset DepositNote built from the bundled .masp package.
 */

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { useSend, useSyncState } from "@miden-sdk/react";
import { useMemo, useState } from "react";

import type { Basket } from "../lib/baskets";

interface Props {
  basket: Basket;
}

// Asset faucet ids on Miden testnet (deploy 2026-05-14), with real
// decimals. `useSend.assetId` accepts any `AccountRef` form (hex,
// bech32, AccountId object).
const ASSET_FAUCETS: Record<string, { label: string; id: string; decimals: number }> = {
  "darwin-eth":  { label: "dETH",  id: "0xa095d9b3831e96206ff70c2218a6a9", decimals: 18 },
  "darwin-wbtc": { label: "dWBTC", id: "0x7a45cb24ada22120246bcf54196e12", decimals: 8  },
  "darwin-usdt": { label: "dUSDT", id: "0xd3789f451ddd4720602ba9eb1a268d", decimals: 6  },
  "darwin-dai":  { label: "dDAI",  id: "0xb526deb0408a29207e4f27ed57bf1a", decimals: 18 },
};

// Per-basket M1 controllers on Miden testnet (RegularAccountUpdatable,
// private storage). Source: miden_testnet_state.md (2026-05-14).
const BASKET_CONTROLLER_ID: Record<string, string> = {
  DCC: "0xaa20da7d98c2e29022510aa786948f",
  DAG: "0x53c54781b7b091905a948b5e3f92fe",
  DCO: "0xa3a0e023381d709060a19527e73f95",
};

export function MidenDepositPanel({ basket }: Props) {
  const { connected, address } = useMidenFiWallet();
  const { syncHeight } = useSyncState();
  const { send, isLoading, stage, result, error } = useSend();

  const assetOptions = useMemo(
    () =>
      basket.constituents
        .map((c) => ASSET_FAUCETS[c.faucetAlias])
        .filter((a): a is { label: string; id: string; decimals: number } =>
          Boolean(a),
        ),
    [basket],
  );

  const [assetIdx, setAssetIdx] = useState(0);
  const [amount, setAmount] = useState<string>("10");
  const asset = assetOptions[assetIdx];

  if (!connected || !address) {
    return (
      <div
        style={{
          padding: "1.2rem 1.4rem",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>Connect a Miden wallet</h3>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 14,
            lineHeight: 1.55,
            marginTop: 8,
            marginBottom: 0,
          }}
        >
          For the Miden-native path you need a Miden wallet (MidenFi browser
          extension, Para, or Turnkey). Click <em>Connect Miden</em> in the
          top nav. Already on Ethereum? Switch to the <em>Ethereum (Sepolia)</em>
          {" "}tab and the relay handles everything.
        </p>
      </div>
    );
  }

  const controllerId = BASKET_CONTROLLER_ID[basket.symbol];

  async function handleSend() {
    if (!asset || !controllerId) return;
    const base = 10n ** BigInt(asset.decimals);
    // parseFloat * 1e6 keeps 6 digits of precision then we scale to
    // the asset's decimals — avoids losing dust on 18-dp tokens.
    const microHuman = BigInt(Math.floor(parseFloat(amount || "0") * 1_000_000));
    const units = (microHuman * base) / 1_000_000n;
    try {
      await send({
        from: address!,
        to: controllerId,
        assetId: asset.id,
        amount: units,
        noteType: "private",
      });
    } catch (e) {
      console.error("miden send failed", e);
    }
  }

  return (
    <div
      style={{
        padding: "1.2rem 1.4rem",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>
        Miden-native deposit → {basket.symbol}
      </h3>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 13,
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 14,
        }}
      >
        Sign a P2ID note from your Miden wallet (
        <code>{address.slice(0, 10)}…</code>) to the {basket.symbol} controller
        (<code>{controllerId?.slice(0, 14)}…</code>). The controller consumes
        the note and credits your basket-token position privately.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <select
          value={assetIdx}
          onChange={(e) => setAssetIdx(parseInt(e.target.value, 10))}
          style={{
            padding: "10px 12px",
            fontFamily: "var(--font-mono-stack)",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
          }}
        >
          {assetOptions.map((a, i) => (
            <option key={a.id} value={i}>
              {a.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={0}
          step={1}
          style={{
            flex: 1,
            padding: "10px 12px",
            fontFamily: "var(--font-mono-stack)",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
          }}
        />
      </div>

      <button
        onClick={handleSend}
        disabled={isLoading || !asset}
        style={{
          width: "100%",
          padding: "12px 16px",
          background: isLoading ? "var(--ink-3)" : "var(--ink)",
          color: "var(--paper)",
          border: 0,
          cursor: isLoading ? "not-allowed" : "pointer",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        {isLoading
          ? `${stage ?? "Working"}…`
          : `Deposit ${amount} ${asset?.label ?? ""} → ${basket.symbol}`}
      </button>

      {result?.txId && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-3)" }}>
          Tx submitted: <code>{result.txId.slice(0, 16)}…</code>
        </p>
      )}

      {error && (
        <pre
          style={{
            marginTop: 10,
            padding: 10,
            background: "#fff0f0",
            fontSize: 11,
            overflowX: "auto",
            color: "#a01a1a",
          }}
        >
          {String(error.message ?? error)}
        </pre>
      )}

      <p
        style={{
          marginTop: 12,
          fontSize: 11,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
        }}
      >
        sync: {syncHeight ? `block ${syncHeight}` : "…"}
      </p>
    </div>
  );
}
