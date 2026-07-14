/**
 * v10 confidential basket faucets — each basket is a NETWORK-account
 * fungible faucet. A deposit emits a confidential_deposit_note at the
 * faucet; the NTX builder drains the dUSDC collateral into the faucet
 * vault and mints basket tokens into a PRIVATE note the depositor alone
 * can claim. Positions = the user's private token balance (no public
 * per-user ledger). See darwin-relay send_confidential_deposit/redeem.
 */
export const CONFIDENTIAL_FAUCETS: Record<string, string> = {
  DCC: "0xfc0a3b234390daf16112dd1c1b49ba",
  DAG: "0xe6bc7aa3e55a0b311bce40b8cb5338",
  DCO: "0x84d4bfb35566af317a32d696d48bca",
};
