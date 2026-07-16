/**
 * Headless Epoch Sepolia→Miden bridge deposit — a reusable ops/test tool.
 *
 * Runs the exact deposit path the TrustlessDepositPanel drives in-browser,
 * but from a local key (no MetaMask). Useful for CI, ops, automation, and
 * verifying the bridge end-to-end without a browser.
 *
 * The Epoch SDK submits via viem's sendTransactionSync, which calls the
 * non-standard `eth_sendRawTransactionSync` RPC method. Public RPCs
 * (publicnode, thirdweb) don't implement it — it only works through
 * MetaMask in a browser. This tool polyfills it as
 * `eth_sendRawTransaction` + receipt polling, so a plain local key works.
 * (Feedback filed with Epoch: their SDK should ship that fallback.)
 *
 * Usage:
 *   TEST_KEY=0x<privkey> AMT=3 RECIPIENT=0x<midenAccountIdHex> \
 *     npx tsx scripts/bridge-deposit.mts
 *
 * Then consume the delivered note on the recipient (miden-client):
 *   miden-client sync
 *   miden-client notes -l consumable -a <RECIPIENT>
 *   miden-client consume-notes -a <RECIPIENT> <noteId> -f
 */
import { createWalletClient, createPublicClient, custom, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";
import {
  ALLOCATOR_URL,
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
  applySlippageBps,
  dusdcMidenBaseUnits,
  fetchQuote,
  submitIntent,
} from "../src/lib/epoch";

const KEY = process.env.TEST_KEY as `0x${string}` | undefined;
const RPC =
  process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const RECIPIENT = process.env.RECIPIENT || "";
const AMT = process.env.AMT || "1";

if (!KEY) throw new Error("set TEST_KEY=0x<sepolia privkey>");
if (!RECIPIENT) throw new Error("set RECIPIENT=0x<miden account id hex>");

const base = createPublicClient({ chain: sepolia, transport: http(RPC) });

/** Polyfill the SDK's eth_sendRawTransactionSync → send + poll receipt. */
const syncPolyfill = custom({
  async request({ method, params }: { method: string; params?: unknown[] }) {
    if (method === "eth_sendRawTransactionSync") {
      const raw = (params as unknown[])[0] as `0x${string}`;
      const hash = (await base.request({
        method: "eth_sendRawTransaction",
        params: [raw],
      } as never)) as `0x${string}`;
      for (let i = 0; i < 90; i++) {
        const rcpt = await base.request({
          method: "eth_getTransactionReceipt",
          params: [hash],
        } as never);
        if (rcpt) return rcpt;
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("receipt timeout for " + hash);
    }
    return base.request({ method, params } as never);
  },
});

const account = privateKeyToAccount(KEY);
const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport: syncPolyfill,
});
const sdk = new EpochIntentSDK({ apiBaseUrl: ALLOCATOR_URL, walletClient });

console.log(`bridge-deposit: ${AMT} USDC  ${account.address} → Miden ${RECIPIENT}`);
const minTokenOut = applySlippageBps(
  dusdcMidenBaseUnits(AMT),
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
);
const quote = await fetchQuote(sdk, {
  evmSourceAddress: account.address,
  midenRecipientId: RECIPIENT,
  minTokenOut,
} as never);
if (!(quote.quoteResult as { success?: boolean }).success) {
  throw new Error("quote failed: " + JSON.stringify(quote.quoteResult).slice(0, 300));
}
console.log("quote ok · minTokenOut:", minTokenOut, "(dUSDC base units)");

const result = (await submitIntent(sdk, quote)) as {
  depositResult?: { transactionHash?: string };
  intentRequestData?: { compact?: { amount?: string } };
};
console.log("deposit tx :", result.depositResult?.transactionHash);
console.log("deposited  :", result.intentRequestData?.compact?.amount, "dUSDC base (18-dec)");
console.log("done — poll the recipient on Miden and consume the delivered note.");
