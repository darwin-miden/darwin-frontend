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
  /**
   * FPI-priced (true): the NAV note reads Pragma medians live via
   * execute_foreign_procedure — no keeper feed. Uses the *_fpi note scripts +
   * pragma_fpi lib. Implies nav: true.
   */
  fpi?: boolean;
};

export const BASKET_FAUCETS: Record<string, BasketFaucet> = {
  // NAV rail — real constituents, shares priced at live NAV. Deposit AND
  // redeem: the v12 nav faucet (deploy_v12_nav_faucet) allowlists both the
  // nav_deposit and nav_redeem notes. See darwin-relay send_nav_deposit /
  // send_nav_redeem.
  // v13 FPI NAV faucet (redeployed 2026-08-08, tx 0x7bfa8e07…) with the correct
  // price_oracle::compute_v_fpi component — prices the vault at the LIVE Pragma NAV
  // read on-chain via execute_foreign_procedure, no price keeper. Prices are handed
  // to compute_v_fpi across the `call` ON THE STACK. The dWBTC constituent is priced
  // from BTC/USD (Pragma pair 1) — Pragma testnet publishes BTC, not WBTC (pair 3),
  // and DCC is BTC exposure. Allowlists the browser FPI deposit (0x89fc782b…) +
  // redeem (0x81f97965…) roots.
  DCC: {
    id: "0x8c6f0be6889949f172043c9b73a85f",
    decimals: 8,
    nav: true,
    fpi: true,
  },
  // Legacy 1:1 confidential faucets — not yet migrated to NAV.
  DAG: { id: "0x2fe3469cccf61a710d321df38c4ca1", decimals: 6, nav: false },
  DCO: { id: "0xf1a4752b3689beb110eebec647df20", decimals: 6, nav: false },
  // FPI test basket — shares the live DCC FPI faucet (compute_v_fpi). See DCC above.
  DCF: {
    id: "0x8c6f0be6889949f172043c9b73a85f",
    decimals: 8,
    nav: true,
    fpi: true,
  },
};

// INVARIANT: every FPI faucet MUST be nav:true. The trade flow gates the client build
// on isNavBasket but the server no-fallback on isFpiBasket, so fund-safety relies on
// fpi ⟹ nav. An fpi:true, nav:false entry would skip the client build AND (worse, if the
// gate drifts) could route an FPI basket to the CoinGecko server path → mispriced,
// unconsumable payback → stranded funds. Fail fast at module load rather than in prod.
for (const [sym, f] of Object.entries(BASKET_FAUCETS)) {
  if (f.fpi && !f.nav) {
    throw new Error(`basketFaucets: ${sym} is fpi:true but nav:false — every FPI basket must be nav:true`);
  }
}

/** Faucet id for a basket, or undefined if unknown. */
export const basketFaucetId = (symbol: string): string | undefined =>
  BASKET_FAUCETS[symbol]?.id;

/** Faucet token decimals for a basket (defaults to 6 for unknown). */
export const basketDecimals = (symbol: string): number =>
  BASKET_FAUCETS[symbol]?.decimals ?? 6;

/** True when a basket is NAV-priced (shares × live NAV, not flat 1:1). */
export const isNavBasket = (symbol: string): boolean =>
  BASKET_FAUCETS[symbol]?.nav ?? false;

/** True when a basket prices via FPI Pragma reads (uses the *_fpi note scripts). */
export const isFpiBasket = (symbol: string): boolean =>
  BASKET_FAUCETS[symbol]?.fpi ?? false;

/** Symbols of the NAV-priced baskets. */
export const NAV_BASKETS: string[] = Object.keys(BASKET_FAUCETS).filter(
  (s) => BASKET_FAUCETS[s].nav,
);
