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
  DCC: {
    // ⚠️ REDEPLOY PENDING. This faucet (0x42a1) was built with the retired
    // `price_oracle_fpi` component, whose `compute_v` reads the FPI prices from
    // mem[230..232] but is `call`ed (fresh memory context) so those reads are 0 →
    // it prices the vault CASH-ONLY, ignoring the crypto constituents (V = D·100).
    // The fix (price_oracle::compute_v_fpi, which takes the prices across the call
    // ON THE STACK) requires a NEW faucet: deploy via deploy_v13_fpi_faucet (now
    // wired to price_oracle.masm), --allow-root the browser's new FPI note roots,
    // then replace this id. Until then DCC prices cash-only. Superseded the
    // feed-based v21 (0x817d64ee…) whose keeper (nav-orchestrate) is decommissioned.
    id: "0x42a122b9a3f7a31171af414436c901",
    decimals: 8,
    nav: true,
    fpi: true,
  },
  // Legacy 1:1 confidential faucets — not yet migrated to NAV.
  DAG: { id: "0x2fe3469cccf61a710d321df38c4ca1", decimals: 6, nav: false },
  DCO: { id: "0xf1a4752b3689beb110eebec647df20", decimals: 6, nav: false },
  // FPI test basket — shares the DCC faucet (0x42a1). Same ⚠️ REDEPLOY PENDING as
  // DCC: built with the retired cash-only price_oracle_fpi component; the fix
  // (compute_v_fpi) needs a fresh faucet + re-pointed id. See DCC above.
  DCF: {
    id: "0x42a122b9a3f7a31171af414436c901",
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
