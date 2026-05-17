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
import Link from "next/link";
import { BASKETS, type Basket, formatWeight } from "../../lib/baskets";
import {
  planRebalance,
  type ConstituentSnapshot,
} from "../../lib/rebalance";
import { NavBar } from "../../components/NavBar";

// Live Pragma snapshot. Refreshed manually by re-running:
//   cargo run --features pragma-live -p darwin-sdk \
//     --bin rebalance_bot -- --once --live
// (verified 2026-05-17, ETH/USD = $2194.28). When the wasm-bindgen
// miden-web SDK ships, this constant is replaced by an in-browser
// pragma_live::pragma_get_median_mast_root_hex call.
const ORACLE_PRICES_X1E8: Record<string, bigint> = {
  "darwin-eth": 219_427_837_701n,
  "darwin-wbtc": 7_812_150_232_994n,
  "darwin-usdt": 999_602n,
  "darwin-dai": 99_972_168n,
};

const ORACLE_SNAPSHOT_AT = "2026-05-17";
const V4_REBALANCE_STEP_MAST_ROOT =
  "0xddff122fa9aff9c1e5b5c253b509d24a795a9ad709f32d54e91eb53a77b84c53";

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
  const [showTrigger, setShowTrigger] = useState<string | null>(null);

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
    <>
    <NavBar active="baskets" />
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
                <Link
                  href={`/baskets/${basket.symbol.toLowerCase()}`}
                  style={{
                    color: "inherit",
                    borderBottom: "1px dotted var(--rule)",
                  }}
                >
                  <strong style={{ fontSize: "1.1rem" }}>{basket.name}</strong>
                </Link>
                <code
                  style={{
                    marginLeft: "0.6rem",
                    color: "#666",
                  }}
                >
                  {basket.symbol}
                </code>
                <Link
                  href={`/baskets/${basket.symbol.toLowerCase()}`}
                  style={{
                    marginLeft: "0.8rem",
                    fontSize: "0.8rem",
                    color: "#666",
                  }}
                >
                  view detail →
                </Link>
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
                <ul style={{ marginTop: "0.4rem", paddingLeft: "1.2rem" }}>
                  {plan.trades.map((t) => (
                    <li key={t.faucetAlias}>
                      <strong>{t.kind.toUpperCase()}</strong>{" "}
                      <code>{t.faucetAlias}</code> {t.baseUnits.toString()} base
                      units (drift {t.driftBps} bps)
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => setShowTrigger(basket.symbol)}
                  style={{
                    marginTop: "0.8rem",
                    padding: "0.5rem 1rem",
                    border: `1px solid ${status.color}`,
                    background: status.color,
                    color: "white",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                  }}
                >
                  Trigger rebalance →
                </button>
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
        Live Pragma snapshot taken <strong>{ORACLE_SNAPSHOT_AT}</strong> — ETH
        $2,194.28 / BTC $78,121.50 / USDT $0.9996 / DAI $0.9997. Refreshed by
        the M2 rebalance bot (
        <code>cargo run --features pragma-live -p darwin-sdk --bin rebalance_bot -- --once --live</code>
        ). Pool positions are synthetic — production reads them from each
        controller's StorageMap slot 2.
      </footer>

      {showTrigger && (
        <div
          onClick={() => setShowTrigger(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--paper, #f4f1ea)",
              borderLeft: "4px solid var(--orange, #ff6a3d)",
              maxWidth: 640,
              padding: "1.5rem 1.8rem",
              fontSize: "0.9rem",
              lineHeight: 1.55,
            }}
          >
            <h3 style={{ margin: "0 0 0.6rem", fontSize: "1.1rem" }}>
              Submit a Flow B trigger note — {showTrigger}
            </h3>
            <p style={{ color: "#444", margin: "0 0 0.8rem" }}>
              Calling <code>execute_rebalance_step</code> on the v4
              rebalance-aware controller. The trigger note carries no assets;
              the controller&apos;s proc runs inside its tx context.
            </p>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                rowGap: 6,
                columnGap: 14,
                fontSize: "0.8rem",
                margin: "0 0 1rem",
              }}
            >
              <dt style={{ color: "#666", fontFamily: "monospace" }}>note</dt>
              <dd style={{ margin: 0, fontFamily: "monospace" }}>
                <code>rebalance-trigger-note.masm</code> · 0 assets
              </dd>
              <dt style={{ color: "#666", fontFamily: "monospace" }}>call</dt>
              <dd style={{ margin: 0, fontFamily: "monospace", wordBreak: "break-all" }}>
                {V4_REBALANCE_STEP_MAST_ROOT}
              </dd>
              <dt style={{ color: "#666", fontFamily: "monospace" }}>basket</dt>
              <dd style={{ margin: 0 }}>{showTrigger}</dd>
            </dl>
            <pre
              style={{
                background: "#0b0b0c",
                color: "#f4f1ea",
                padding: "0.8rem 1rem",
                fontSize: "0.78rem",
                overflowX: "auto",
                marginBottom: "1rem",
              }}
            >
{`# 1. Deploy v4 controller once
cargo run -p darwin-protocol-account \\
    --bin build_v4_rebalance_controller -- \\
    --out /tmp/darwin-v4-rebalance-controller.masp
miden client new-account \\
    --packages /tmp/darwin-v4-rebalance-controller.masp \\
    --storage-mode private --deploy

# 2. Submit + consume the trigger note
cargo run -p darwin-protocol-account --bin flow_b_demo -- \\
    --controller 0x<v4-controller-hex>`}
            </pre>
            <p style={{ color: "#666", fontSize: "0.78rem", margin: 0 }}>
              In-browser submission lands when the wasm-bindgen miden-web SDK
              ships (M3). Until then, run the bot or the CLI above.
            </p>
            <button
              onClick={() => setShowTrigger(null)}
              style={{
                marginTop: "1rem",
                padding: "0.45rem 1rem",
                border: "1px solid #444",
                background: "transparent",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
    </>
  );
}
