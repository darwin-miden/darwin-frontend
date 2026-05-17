"use client";

/**
 * Basket browser + live drift dashboard.
 *
 * Renders the three M1 baskets (DCC, DAG, DCO) with their target
 * weights, current synthetic snapshots, and per-constituent drift
 * computed via the local `planRebalance` planner (algorithmically
 * identical to `darwin_sdk::rebalance::plan` and `darwin::drift`
 * MASM). The "Skew" slider perturbs the first constituent's position
 * so the drift status flips between green / amber / red — proves the
 * planner end-to-end in the browser.
 *
 * M3 prep: this is the wireframe the production deposit / redeem UI
 * sits on top of once the wasm-bindgen SDK ships.
 */

import { useMemo, useState } from "react";
import { BASKETS, type Basket, formatWeight } from "../../lib/baskets";
import {
  planRebalance,
  type ConstituentSnapshot,
} from "../../lib/rebalance";

const ORACLE_PRICES_X1E8: Record<string, bigint> = {
  "darwin-eth": 200_000_000_000n,
  "darwin-wbtc": 6_000_000_000_000n,
  "darwin-usdt": 100_000_000n,
  "darwin-dai": 100_000_000n,
};

const DRIFT_THRESHOLD_BPS = 500;

function snapshotFor(basket: Basket, skew: number): ConstituentSnapshot[] {
  return basket.constituents.map((c, idx) => {
    let position = BigInt(c.targetWeightBps);
    if (idx === 0) {
      position = BigInt(Math.round(c.targetWeightBps * skew));
    }
    return {
      faucetAlias: c.faucetAlias,
      positionBaseUnits: position,
      priceX1e8: ORACLE_PRICES_X1E8[c.faucetAlias] ?? 1n,
    };
  });
}

function classifyDrift(maxDrift: number): {
  emoji: string;
  label: string;
  color: string;
} {
  if (maxDrift > DRIFT_THRESHOLD_BPS) {
    return { emoji: "🔴", label: "rebalance", color: "#d23f3f" };
  }
  if (maxDrift > DRIFT_THRESHOLD_BPS / 2) {
    return { emoji: "🟡", label: "watch", color: "#c5a23e" };
  }
  return { emoji: "🟢", label: "within", color: "#3aa05a" };
}

export default function BasketsPage() {
  const [skew, setSkew] = useState<number>(1);

  const plans = useMemo(() => {
    return BASKETS.map((basket) => {
      const snapshot = snapshotFor(basket, skew);
      const plan = planRebalance(basket, snapshot, {
        driftThresholdBps: DRIFT_THRESHOLD_BPS,
      });
      const maxDrift = plan.drifts.reduce(
        (acc, d) => (d.driftBps > acc ? d.driftBps : acc),
        0,
      );
      return { basket, snapshot, plan, maxDrift };
    });
  }, [skew]);

  return (
    <main
      style={{
        minHeight: "100vh",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: "2rem",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <header style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "2rem", margin: 0 }}>Darwin baskets</h1>
        <p
          style={{
            color: "#666",
            fontSize: "0.95rem",
            marginTop: "0.4rem",
          }}
        >
          Live drift dashboard. The same planner runs in the on-chain
          MASM controller (<code>darwin::drift</code>) and the M2
          rebalance bot (<code>darwin_sdk::rebalance::plan</code>).
        </p>
      </header>

      <section style={{ marginBottom: "1.5rem" }}>
        <label style={{ fontSize: "0.9rem", color: "#444" }}>
          Skew first constituent: <strong>{skew.toFixed(2)}x</strong>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={skew}
            onChange={(e) => setSkew(parseFloat(e.target.value))}
            style={{
              display: "block",
              width: "100%",
              marginTop: "0.4rem",
            }}
          />
        </label>
      </section>

      {plans.map(({ basket, plan, maxDrift }) => {
        const status = classifyDrift(maxDrift);
        return (
          <article
            key={basket.symbol}
            style={{
              border: "1px solid #ddd",
              borderRadius: "8px",
              padding: "1rem 1.2rem",
              marginBottom: "1rem",
              borderLeft: `5px solid ${status.color}`,
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.6rem",
              }}
            >
              <div>
                <strong style={{ fontSize: "1.1rem" }}>{basket.name}</strong>
                <code
                  style={{
                    marginLeft: "0.6rem",
                    color: "#666",
                  }}
                >
                  {basket.symbol}
                </code>
              </div>
              <div style={{ color: status.color, fontWeight: 600 }}>
                {status.emoji} {status.label} — max drift {maxDrift} bps
              </div>
            </header>

            <p style={{ color: "#555", fontSize: "0.9rem", margin: "0.4rem 0" }}>
              {basket.description}
            </p>

            <table
              style={{
                width: "100%",
                fontSize: "0.85rem",
                borderCollapse: "collapse",
                marginTop: "0.6rem",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #eee" }}>
                  <th style={{ textAlign: "left", padding: "0.3rem" }}>
                    Constituent
                  </th>
                  <th style={{ textAlign: "right", padding: "0.3rem" }}>
                    Target
                  </th>
                  <th style={{ textAlign: "right", padding: "0.3rem" }}>
                    Current
                  </th>
                  <th style={{ textAlign: "right", padding: "0.3rem" }}>
                    Drift
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.drifts.map((d) => (
                  <tr key={d.faucetAlias}>
                    <td style={{ padding: "0.3rem" }}>{d.faucetAlias}</td>
                    <td style={{ textAlign: "right", padding: "0.3rem" }}>
                      {formatWeight(d.targetWeightBps)}
                    </td>
                    <td style={{ textAlign: "right", padding: "0.3rem" }}>
                      {formatWeight(d.currentWeightBps)}
                    </td>
                    <td
                      style={{
                        textAlign: "right",
                        padding: "0.3rem",
                        color: d.driftBps > DRIFT_THRESHOLD_BPS ? status.color : "#444",
                      }}
                    >
                      {d.driftBps} bps
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {plan.trades.length > 0 && (
              <div style={{ marginTop: "0.8rem", fontSize: "0.85rem" }}>
                <strong>Rebalance plan</strong>{" "}
                <span style={{ color: "#666" }}>
                  (M2 will submit this as a Flow B trigger note)
                </span>
                <ul style={{ marginTop: "0.4rem", paddingLeft: "1.2rem" }}>
                  {plan.trades.map((t) => (
                    <li key={t.faucetAlias}>
                      <strong>{t.kind.toUpperCase()}</strong>{" "}
                      <code>{t.faucetAlias}</code> {t.baseUnits.toString()} base
                      units (drift {t.driftBps} bps)
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        );
      })}

      <footer
        style={{
          marginTop: "2rem",
          fontSize: "0.8rem",
          color: "#888",
        }}
      >
        Synthetic data — production reads live prices from the on-chain
        Pragma adapter (<code>0x085ba19a…6fd</code>) and pool positions
        from each controller's StorageMap slot 2 (Track C).
      </footer>
    </main>
  );
}
