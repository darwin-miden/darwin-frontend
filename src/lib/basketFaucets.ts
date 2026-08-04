/**
 * Single source of truth for basket faucets.
 *
 * A basket is served by exactly ONE Miden faucet account. Each basket is
 * either:
 *   - NAV-priced  (`nav: true`)  — the faucet holds real constituents
 *     (dWBTC/dETH/dUSDT); a deposit mints shares priced at the vault's live
 *     net asset value, and the position tracks the vault. Basket token is
 *     8-dec. DCC is the live NAV basket.
 *   - legacy 1:1  (`nav: false`) — the faucet mints 1 token per dUSDC of
 *     collateral (6-dec). DAG/DCO are still on this rail.
 *
 * Every read/display/deposit/redeem path must resolve the faucet through this
 * table — never hard-code an id — so deposit, balance, portfolio, withdraw and
 * the block-explorer link can never drift onto different faucets (which are
 * different tokens). Faucet ids are public, so they live here as literals.
 */

export type BasketFaucet = {
  /** Miden faucet account id (hex). */
  id: string;
  /** Faucet token decimals. */
  decimals: number;
  /** NAV-priced (true) vs legacy flat 1:1 dUSDC (false). */
  nav: boolean;
};

export const BASKET_FAUCETS: Record<string, BasketFaucet> = {
  // NAV rail — real constituents, shares priced at live NAV. Deposit AND
  // redeem: the v12 nav faucet (deploy_v12_nav_faucet) allowlists both the
  // nav_deposit and nav_redeem notes. See darwin-relay send_nav_deposit /
  // send_nav_redeem.
  DCC: {
    // v18 NAV faucet — compute_v = Σ(constituent_holdings × live price) +
    // max(0, D−W)×100 (the SYMMETRIC watermark model). V rises AND falls with
    // the live crypto feed (no max floor), so a redeem settles the real price
    // move both ways. W = feed[3] tracks cash already mirrored into constituents,
    // so a fresh deposit's cash lands in NAV at par immediately (no dilution) and
    // isn't double-counted once mirrored. The relay orchestrator (launchd, every
    // 10 min) pushes live CoinGecko prices via set_feed and seeds 40/40/20
    // WBTC/ETH/USDT per deposit. Supersedes v17 (0x33800b5c, max() = upside-only,
    // downside floored) — see darwin-relay asm/lib/price_oracle.masm.
    id: "0x357559089dcdeaf13bb9e53964aff6",
    decimals: 8,
    nav: true,
  },
  // Legacy 1:1 confidential faucets — not yet migrated to NAV.
  DAG: { id: "0x2fe3469cccf61a710d321df38c4ca1", decimals: 6, nav: false },
  DCO: { id: "0xf1a4752b3689beb110eebec647df20", decimals: 6, nav: false },
};

/** Faucet id for a basket, or undefined if unknown. */
export const basketFaucetId = (symbol: string): string | undefined =>
  BASKET_FAUCETS[symbol]?.id;

/** Faucet token decimals for a basket (defaults to 6 for unknown). */
export const basketDecimals = (symbol: string): number =>
  BASKET_FAUCETS[symbol]?.decimals ?? 6;

/** True when a basket is NAV-priced (shares × live NAV, not flat 1:1). */
export const isNavBasket = (symbol: string): boolean =>
  BASKET_FAUCETS[symbol]?.nav ?? false;

/** Symbols of the NAV-priced baskets. */
export const NAV_BASKETS: string[] = Object.keys(BASKET_FAUCETS).filter(
  (s) => BASKET_FAUCETS[s].nav,
);
