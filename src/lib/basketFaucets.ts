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
    id: "0x2901b41fb0a901714d03b804b8d97e",
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
