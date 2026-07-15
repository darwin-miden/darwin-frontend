/**
 * v10 confidential basket faucets — each basket is a NETWORK-account
 * fungible faucet. A deposit emits a confidential_deposit_note at the
 * faucet; the NTX builder drains the dUSDC collateral into the faucet
 * vault and mints basket tokens into a PRIVATE note the depositor alone
 * can claim. Positions = the user's private token balance (no public
 * per-user ledger). See darwin-relay send_confidential_deposit/redeem.
 */
// v10.3 faucets — value is bound to real collateral with NO emitter lever:
//  - deposit mints 1:1 from the actually-drained dUSDC (the mint ratio is
//    NOT read from note-storage fee/nav felts, which an attacker could set
//    to mint 1e6x and drain the pool), and asserts the collateral faucet
//    IS dUSDC (rejects worthless-token deposits);
//  - redeem pays out the real burned amount and asserts the release asset
//    is dUSDC.
// Validated on-chain: honest deposit+redeem conserve exactly; non-dUSDC
// collateral is rejected; the fee/nav lever is dead (mint stays 1:1).
export const CONFIDENTIAL_FAUCETS: Record<string, string> = {
  DCC: "0x9463767a994d6f9178fce256261430",
  DAG: "0x2fe3469cccf61a710d321df38c4ca1",
  DCO: "0xf1a4752b3689beb110eebec647df20",
};
