/**
 * Off-chain rebalance / drift planner — TypeScript mirror of the
 * `darwin::drift` MASM library in `darwin-protocol/asm/lib/drift.masm`
 * and the Rust `darwin_sdk::rebalance` module.
 *
 * The M3 frontend uses this to render the live drift bar inside the
 * basket detail view, without round-tripping through Wasm. The Rust
 * SDK remains the authoritative implementation; this file must stay
 * algorithmically identical (constituent_weight = position * price *
 * 10000 / total_pool_value, drift = |current - target|, trade fires
 * when drift > basket.driftThresholdBps).
 */

import type { Basket } from "./baskets";

export interface ConstituentSnapshot {
  /** Faucet alias from the basket manifest (`darwin-eth`, …). */
  faucetAlias: string;
  /** Current position in the faucet's native base units. */
  positionBaseUnits: bigint;
  /** Current price in USD (8-decimal fixed point, $20.0 → 2_000_000_000n). */
  priceX1e8: bigint;
}

export type TradeKind = "buy" | "sell";

export interface RebalanceTrade {
  faucetAlias: string;
  kind: TradeKind;
  baseUnits: bigint;
  driftBps: number;
}

export interface ConstituentDrift {
  faucetAlias: string;
  targetWeightBps: number;
  currentWeightBps: number;
  driftBps: number;
}

export interface RebalancePlan {
  totalValueX1e8: bigint;
  drifts: readonly ConstituentDrift[];
  trades: readonly RebalanceTrade[];
}

/** Sum of `position * price` across the snapshot. */
export function totalPoolValue(snapshot: readonly ConstituentSnapshot[]): bigint {
  return snapshot.reduce(
    (acc, c) => acc + c.positionBaseUnits * c.priceX1e8,
    0n,
  );
}

/** Matches `drift::constituent_weight_bps`. */
export function constituentWeightBps(
  c: ConstituentSnapshot,
  total: bigint,
): number {
  if (total === 0n) return 0;
  const num = c.positionBaseUnits * c.priceX1e8 * 10_000n;
  const bps = num / total;
  return Number(bps);
}

/** Matches `drift::abs_drift_bps`. */
export function absDriftBps(current: number, target: number): number {
  return Math.abs(current - target);
}

export interface DriftThresholdBps {
  driftThresholdBps: number;
}

/**
 * Builds a rebalance plan for `basket` given `snapshot` and the
 * caller-supplied drift threshold (the static `BASKETS` catalogue in
 * this repo does not yet carry the threshold per-basket — the M2
 * dashboard wires it in from the Rust manifest).
 */
export function planRebalance(
  basket: Basket,
  snapshot: readonly ConstituentSnapshot[],
  thresholds: DriftThresholdBps,
): RebalancePlan {
  if (snapshot.length !== basket.constituents.length) {
    throw new Error(
      `snapshot has ${snapshot.length} entries but basket ${basket.symbol} declares ${basket.constituents.length}`,
    );
  }
  for (const s of snapshot) {
    if (!basket.constituents.find((c) => c.faucetAlias === s.faucetAlias)) {
      throw new Error(
        `snapshot constituent '${s.faucetAlias}' is not in basket ${basket.symbol}`,
      );
    }
  }

  const total = totalPoolValue(snapshot);
  const drifts: ConstituentDrift[] = [];
  const trades: RebalanceTrade[] = [];

  for (const c of basket.constituents) {
    const snap = snapshot.find((s) => s.faucetAlias === c.faucetAlias)!;
    const current = constituentWeightBps(snap, total);
    const target = c.targetWeightBps;
    const drift = absDriftBps(current, target);
    drifts.push({
      faucetAlias: c.faucetAlias,
      targetWeightBps: target,
      currentWeightBps: current,
      driftBps: drift,
    });
    if (drift > thresholds.driftThresholdBps) {
      const kind: TradeKind = current > target ? "sell" : "buy";
      const driftValue = (BigInt(drift) * total) / 10_000n;
      const baseUnits =
        snap.priceX1e8 === 0n ? 0n : driftValue / snap.priceX1e8;
      trades.push({
        faucetAlias: c.faucetAlias,
        kind,
        baseUnits,
        driftBps: drift,
      });
    }
  }

  return { totalValueX1e8: total, drifts, trades };
}
