/**
 * v10 confidential basket faucets — each basket is a NETWORK-account
 * fungible faucet. A deposit emits a confidential_deposit_note at the
 * faucet; the NTX builder drains the dUSDC collateral into the faucet
 * vault and mints basket tokens into a PRIVATE note the depositor alone
 * can claim. Positions = the user's private token balance (no public
 * per-user ledger). See darwin-relay send_confidential_deposit/redeem.
 */
// v10.1 faucets — the notes bind value to real collateral: the deposit
// mints from the actually-drained dUSDC (not an emitter storage felt) and
// the redeem pays out the real burned amount (not a free storage felt).
// Deposit+redeem validated on-chain against DCC (conservation exact).
export const CONFIDENTIAL_FAUCETS: Record<string, string> = {
  DCC: "0x3a2a5457eddd76f137e7050ea8a904",
  DAG: "0xb79116e85cf159315086d5af07840f",
  DCO: "0xe80c8b66065f53115ab13b15e7e718",
};
