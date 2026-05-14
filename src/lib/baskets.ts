/**
 * Static M1 basket catalogue, mirroring `darwin-baskets` manifests.
 *
 * The Rust SDK already exposes these via `darwin_baskets::all_m1()` —
 * once `darwin-sdk` ships a wasm-bindgen build of its TypeScript
 * layer, this module will be replaced by the generated bindings.
 * Until then this hand-maintained copy lets the M3 frontend mock up
 * the basket browser without a Wasm build dependency.
 */

export type BasketSymbol = "DCC" | "DAG" | "DCO";

export interface BasketConstituent {
  readonly faucetAlias: string;
  readonly targetWeightBps: number;
  readonly pragmaPair: string;
}

export interface Basket {
  readonly name: string;
  readonly symbol: BasketSymbol;
  readonly description: string;
  readonly constituents: readonly BasketConstituent[];
}

export const BASKETS: readonly Basket[] = [
  {
    name: "Core Crypto",
    symbol: "DCC",
    description:
      "Blue-chip crypto exposure with a stable buffer (40 BTC / 40 ETH / 20 USDT).",
    constituents: [
      { faucetAlias: "darwin-wbtc", targetWeightBps: 4000, pragmaPair: "WBTC/USD" },
      { faucetAlias: "darwin-eth", targetWeightBps: 4000, pragmaPair: "ETH/USD" },
      { faucetAlias: "darwin-usdt", targetWeightBps: 2000, pragmaPair: "USDT/USD" },
    ],
  },
  {
    name: "Aggressive",
    symbol: "DAG",
    description: "Pure crypto exposure, no stable buffer (50 BTC / 50 ETH).",
    constituents: [
      { faucetAlias: "darwin-wbtc", targetWeightBps: 5000, pragmaPair: "WBTC/USD" },
      { faucetAlias: "darwin-eth", targetWeightBps: 5000, pragmaPair: "ETH/USD" },
    ],
  },
  {
    name: "Conservative",
    symbol: "DCO",
    description:
      "Capital-preservation tilt, stable-heavy (10 BTC / 10 ETH / 40 USDT / 40 DAI).",
    constituents: [
      { faucetAlias: "darwin-wbtc", targetWeightBps: 1000, pragmaPair: "WBTC/USD" },
      { faucetAlias: "darwin-eth", targetWeightBps: 1000, pragmaPair: "ETH/USD" },
      { faucetAlias: "darwin-usdt", targetWeightBps: 4000, pragmaPair: "USDT/USD" },
      { faucetAlias: "darwin-dai", targetWeightBps: 4000, pragmaPair: "DAI/USD" },
    ],
  },
] as const;

export function basketBySymbol(symbol: BasketSymbol): Basket {
  const b = BASKETS.find((b) => b.symbol === symbol);
  if (!b) {
    throw new Error(`unknown basket symbol: ${symbol}`);
  }
  return b;
}

export function formatWeight(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`;
}
