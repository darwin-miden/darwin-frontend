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

// v0.15 Testnet faucets — deployed 2026-06-23 after Miden's testnet
// v0.15 migration. The on-chain TokenSymbol is uppercase (DETH, DWBTC,
// …) because miden-protocol 0.15's TokenSymbol requires ASCII
// uppercase; the lowercase-d frontend label is just display.
const ASSET_FAUCETS_V015: Record<string, AssetFaucet> = {
  "darwin-eth": {
    symbol: "dETH",
    id: "0xb0411b0e0c4985115c03d034234110",
    decimals: 8,
    referencePriceUsd: 2000,
    minAmountHuman: "0.0005",
  },
  "darwin-wbtc": {
    symbol: "dWBTC",
    id: "0xf4779bc231d7c0713e8dd1175daa75",
    decimals: 8,
    referencePriceUsd: 60000,
    minAmountHuman: "0.00001",
  },
  "darwin-usdt": {
    symbol: "dUSDT",
    id: "0xa80e2f25818339712c73ed8d8e9fa8",
    decimals: 6,
    referencePriceUsd: 1,
    minAmountHuman: "1",
  },
  "darwin-dai": {
    symbol: "dDAI",
    id: "0xd3ddf8c8a8bfe7715e1d92e2f8cd1f",
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
  DCC: { symbol: "DCC", id: "0x4eb76287e07e90714a86ae2b89d700", decimals: 8 },
  DAG: { symbol: "DAG", id: "0xed4219cb5ebf3d911c27dc6b24baa2", decimals: 8 },
  DCO: { symbol: "DCO", id: "0xc58107b160df13d1157b707e3f0a3d", decimals: 8 },
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
 * v0.14 (legacy testnet): 0xbef7d2e8… (no longer reachable since
 *                         Miden's testnet v0.15 migration on 2026-06-23).
 * v0.15 (testnet):        0x719bd3a1… (deployed + initialized 2026-06-23,
 *                         init tx 0x7dfe8ff6…, block 3417).
 */
const FEE_ROUTING_CONTROLLER_ID_V014 = "0xbef7d2e89e9c3e006e10f959fa16d2";
const FEE_ROUTING_CONTROLLER_ID_V015 = "0x6687e59f895c7e3115c654ca7ccbbb";

export const FEE_ROUTING_CONTROLLER_ID = USE_V015
  ? FEE_ROUTING_CONTROLLER_ID_V015
  : FEE_ROUTING_CONTROLLER_ID_V014;

// ─── Cross-chain bridges ─────────────────────────────────────────────
/**
 * Epoch's Miden-side faucets — tokens the hosted bridge delivers when
 * a user deposits the matching ERC-20 on Sepolia. Full table published
 * by Manank / Epoch team 2026-07-04. All 6-decimal on Miden.
 */
export const EPOCH_DUSDC_FAUCET_ID = "0xfc90f0f4da30e51168453b60eafed7";
export const EPOCH_DDAI_FAUCET_ID = "0x176275876f2fd41103257e341832b9";
export const EPOCH_DUSDT_FAUCET_ID = "0x7725b0e9bb9406912d2ebeaeb05f4d";
export const EPOCH_DWETH_FAUCET_ID = "0xa54717f6bd3210d128aeeaa8a2b7f3";
export const EPOCH_DWBTC_FAUCET_ID = "0x151823cde4b7bd91352617729d7614";
export const EPOCH_MIDEN_FAUCET_ID = "0x2458e5446128e6b150b75b8ebd9ce1";

/**
 * Bali (AggLayer) bridge account on Miden side. Used by the legacy
 * BaliDepositPanel as the default destination when no other Miden
 * recipient is specified.
 */
export const BALI_DEFAULT_MIDEN_DEST = "0xed3cd5befa3207805f8529207cfc0d";
