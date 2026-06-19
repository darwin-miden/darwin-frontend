/**
 * Single source of truth for every hardcoded Miden AccountId hex the
 * frontend depends on. When the Miden testnet rolls a new protocol
 * version (e.g. v0.14 → v0.15 changes the AccountId wire format from
 * v0 to v1), the migration sweep is a one-file edit instead of a
 * grep-and-replace across components.
 *
 * Values mirror what is deployed on the live Miden testnet. Static
 * snapshot history lives in `testnet-state.ts`; this file is the
 * runtime-consumed view.
 *
 * On migration: redeploy the controllers and faucets under the new
 * SDK, replace every hex below with the new AccountId, then bump
 * `MIDEN_TESTNET_VERSION` so consumers can short-circuit any
 * version-keyed caches.
 */

export const MIDEN_TESTNET_VERSION = "v0.14";

// ─── Constituent asset faucets ───────────────────────────────────────
// Each maps an internal `id` slug to the deployed Miden faucet account
// id, the Miden-side decimals, and a static USD reference used for
// minimum-amount + display heuristics until a live price feed is
// wired through.
export interface AssetFaucet {
  symbol: "dETH" | "dWBTC" | "dUSDT" | "dDAI";
  id: string;
  decimals: number;
  /** Static USD price for min-amount / display heuristics only. */
  referencePriceUsd: number;
  /** Minimum human-readable amount the UI accepts. */
  minAmountHuman: string;
}

export const ASSET_FAUCETS: Record<string, AssetFaucet> = {
  "darwin-eth": {
    symbol: "dETH",
    id: "0x7b727cd8d659d72042a9872c9c68b0",
    decimals: 8,
    referencePriceUsd: 2000,
    minAmountHuman: "0.0005",
  },
  "darwin-wbtc": {
    symbol: "dWBTC",
    id: "0x2357c29fd5ed992038b0c44bf54aaf",
    decimals: 8,
    referencePriceUsd: 60000,
    minAmountHuman: "0.00001",
  },
  "darwin-usdt": {
    symbol: "dUSDT",
    id: "0x049d581b3233f42040501b99d2bd52",
    decimals: 6,
    referencePriceUsd: 1,
    minAmountHuman: "1",
  },
  "darwin-dai": {
    symbol: "dDAI",
    id: "0x93968449ab8ec92035a92a38d747f9",
    decimals: 6,
    referencePriceUsd: 1,
    minAmountHuman: "1",
  },
};

// Reverse lookup: faucet id → asset record. Used by panels that have
// the faucet id but not the slug.
export const ASSET_FAUCET_BY_ID: Record<string, AssetFaucet> =
  Object.fromEntries(
    Object.values(ASSET_FAUCETS).map((a) => [a.id, a]),
  );

// ─── Basket-token faucets ────────────────────────────────────────────
export type BasketSymbol = "DCC" | "DAG" | "DCO";

export interface BasketFaucet {
  symbol: BasketSymbol;
  id: string;
  decimals: number;
}

export const BASKET_TOKEN_FAUCETS: Record<BasketSymbol, BasketFaucet> = {
  DCC: { symbol: "DCC", id: "0x2066f2da1f91ba202af5251d39101c", decimals: 8 },
  DAG: { symbol: "DAG", id: "0xfb6811fd6399df206d44f62800620d", decimals: 8 },
  DCO: { symbol: "DCO", id: "0xbe4efc6729eb3220423b7d6d6a0942", decimals: 8 },
};

// ─── Controller ──────────────────────────────────────────────────────
/**
 * v7 fee-routing controller — Public storage so future drift can be
 * recovered via `import_account_by_id`. All three baskets share this
 * one controller (per-user, per-basket positions live in slot-10).
 */
export const FEE_ROUTING_CONTROLLER_ID =
  "0xbef7d2e89e9c3e006e10f959fa16d2";

// ─── Cross-chain bridges ─────────────────────────────────────────────
/**
 * Epoch's Miden-side dUSDC faucet — the token the hosted bridge
 * delivers when a user deposits USDC on Sepolia.
 */
export const EPOCH_DUSDC_FAUCET_ID = "0x0a7d175ed63ec5200fb2ced86f6aa5";

/**
 * Bali (AggLayer) bridge account on Miden side. Used by the legacy
 * BaliDepositPanel as the default destination when no other Miden
 * recipient is specified.
 */
export const BALI_DEFAULT_MIDEN_DEST = "0xed3cd5befa3207805f8529207cfc0d";
