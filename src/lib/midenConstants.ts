/**
 * Single source of truth for every hardcoded Miden AccountId hex the
 * frontend depends on. When the Miden network rolls a new protocol
 * version (e.g. v0.14 → v0.15 changes the AccountId wire format from
 * v0 to v1), the migration sweep is a one-file edit instead of a
 * grep-and-replace across components.
 *
 * Two parallel snapshots are pinned during the v0.14 → v0.15 cutover:
 *
 *   *_V014 — what is live on Miden Testnet today.
 *   *_V015 — what was deployed on Miden Devnet 2026-06-20 against
 *            the v0.15 toolchain. Will become the testnet set when
 *            Miden Testnet ships v0.15 (currently scheduled the week
 *            of 2026-06-22).
 *
 * The actively-exported view chooses between them based on
 * `NEXT_PUBLIC_MIDEN_V015`. Static snapshot history lives in
 * `testnet-state.ts`.
 */

const USE_V015 = process.env.NEXT_PUBLIC_MIDEN_V015 === "1";

export const MIDEN_TESTNET_VERSION = USE_V015 ? "v0.15" : "v0.14";

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

const ASSET_FAUCETS_V014: Record<string, AssetFaucet> = {
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

// v0.15 Devnet faucets — deployed 2026-06-20 via
// `deploy_devnet_faucet`. The on-chain TokenSymbol is uppercase
// (DETH, DWBTC, …) because miden-protocol 0.15's TokenSymbol requires
// ASCII uppercase; the lowercase-d frontend label is just display.
const ASSET_FAUCETS_V015: Record<string, AssetFaucet> = {
  "darwin-eth": {
    symbol: "dETH",
    id: "0xc2c923560dc3cb114ec24ab2291a05",
    decimals: 8,
    referencePriceUsd: 2000,
    minAmountHuman: "0.0005",
  },
  "darwin-wbtc": {
    symbol: "dWBTC",
    id: "0xdb5cd1de2141b2f1713bb54529fd5f",
    decimals: 8,
    referencePriceUsd: 60000,
    minAmountHuman: "0.00001",
  },
  "darwin-usdt": {
    symbol: "dUSDT",
    id: "0x17f87027a35ab25112b18aed1345fc",
    decimals: 6,
    referencePriceUsd: 1,
    minAmountHuman: "1",
  },
  "darwin-dai": {
    symbol: "dDAI",
    id: "0xb061f3a800d84d511948f0a5004c0b",
    decimals: 6,
    referencePriceUsd: 1,
    minAmountHuman: "1",
  },
};

export const ASSET_FAUCETS: Record<string, AssetFaucet> = USE_V015
  ? ASSET_FAUCETS_V015
  : ASSET_FAUCETS_V014;

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

const BASKET_TOKEN_FAUCETS_V014: Record<BasketSymbol, BasketFaucet> = {
  DCC: { symbol: "DCC", id: "0x2066f2da1f91ba202af5251d39101c", decimals: 8 },
  DAG: { symbol: "DAG", id: "0xfb6811fd6399df206d44f62800620d", decimals: 8 },
  DCO: { symbol: "DCO", id: "0xbe4efc6729eb3220423b7d6d6a0942", decimals: 8 },
};

const BASKET_TOKEN_FAUCETS_V015: Record<BasketSymbol, BasketFaucet> = {
  DCC: { symbol: "DCC", id: "0x536e8b33e2e10d915bd466faa64099", decimals: 8 },
  DAG: { symbol: "DAG", id: "0x6c4f5da5061c6f312e99327a5b36d3", decimals: 8 },
  DCO: { symbol: "DCO", id: "0xf1be7df227291a714c62658a3bcd18", decimals: 8 },
};

export const BASKET_TOKEN_FAUCETS: Record<BasketSymbol, BasketFaucet> = USE_V015
  ? BASKET_TOKEN_FAUCETS_V015
  : BASKET_TOKEN_FAUCETS_V014;

// ─── Controller ──────────────────────────────────────────────────────
/**
 * v7 fee-routing controller — Public storage so future drift can be
 * recovered via `import_account_by_id`. All three baskets share this
 * one controller (per-user, per-basket positions live in slot-10).
 *
 * v0.14 (testnet): 0xbef7d2e8… (live).
 * v0.15 (devnet):  0x2388eaea… (deployed + initialized 2026-06-20,
 *                  init tx 0x05820193…, block 328295).
 */
const FEE_ROUTING_CONTROLLER_ID_V014 = "0xbef7d2e89e9c3e006e10f959fa16d2";
const FEE_ROUTING_CONTROLLER_ID_V015 = "0x2388eaea4ce45331214b871755e7b5";

export const FEE_ROUTING_CONTROLLER_ID = USE_V015
  ? FEE_ROUTING_CONTROLLER_ID_V015
  : FEE_ROUTING_CONTROLLER_ID_V014;

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
