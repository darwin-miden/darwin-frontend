"use client";

/**
 * Epoch protocol — Sepolia → Miden bridge wrapper.
 *
 * Replaces the local 1Click mock for ETH-user → basket deposits. Epoch
 * hosts the allocator + solver so the flow no longer needs a relay
 * polling 1Click locally. The custodial relay wallet still receives the
 * Miden-side dUSDC P2ID note and the existing relay worker still emits
 * atomic_deposit_note against the v7 controller — only the source-of-
 * dETH leg changes.
 *
 * Allocator URL: https://testnet-dev.epochprotocol.xyz (Miden-team
 * default; see 0xMiden/tutorials/examples/bridging-app .env.example).
 *
 * Epoch's test USDC on Sepolia is `0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69`
 * (18-decimal, not the canonical 6-decimal USDC), and the matching Miden
 * faucet is `0x0a7d175ed63ec5200fb2ced86f6aa5`. Both are the values used
 * by Miden's own reference bridging app and Epoch's `miden-integration-
 * example`.
 */

import { parseUnits } from "viem";
import type {
  EpochIntentSDK,
  IntentQuoteResult,
} from "@epoch-protocol/epoch-intents-sdk";

export const ALLOCATOR_URL =
  process.env.NEXT_PUBLIC_ALLOCATOR_URL ||
  "https://testnet-dev.epochprotocol.xyz";

// Sepolia (11155111) is the only EVM chain Darwin uses; constants.js
// in the SDK confirms COMPACT/ARBITER/ALLOCATOR are deployed there.
export const SEPOLIA_CHAIN_ID = 11155111;
export const MIDEN_DESTINATION_CHAIN_ID = 999999999;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Epoch's test USDC on Sepolia — same address the bridging-app uses.
// 18-decimal, NOT the canonical 6-decimal USDC.
export const EPOCH_USDC_SEPOLIA = {
  symbol: "USDC",
  address: "0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69" as `0x${string}`,
  decimals: 18,
  midenFaucetId: "0x0a7d175ed63ec5200fb2ced86f6aa5",
} as const;

export interface EpochQuoteParams {
  /** Sepolia EVM address of the signer (user wallet). */
  evmSourceAddress: `0x${string}`;
  /** Miden recipient — the relay wallet's hex Miden account id. */
  midenRecipientId: string;
  /** Min Miden output, base units of the dUSDC faucet (18 decimals). */
  minTokenOut: string;
}

export interface EpochQuote {
  taskTypeString: string;
  intentData: unknown;
  quoteResult: IntentQuoteResult;
  params: EpochQuoteParams;
}

function buildTaskData(params: EpochQuoteParams) {
  return {
    taskType: "gettokenout" as const,
    intentData: {
      isNative: false,
      depositTokenAddress: EPOCH_USDC_SEPOLIA.address,
      // tokenInAmount = "0" → reverse-quote (backend computes required USDC
      // from minTokenOut). Same convention as Miden bridging-app.
      tokenInAmount: "0",
      outputTokenAddress: ZERO_ADDRESS,
      minTokenOut: params.minTokenOut,
      destinationChainId: String(MIDEN_DESTINATION_CHAIN_ID),
      protocolHashIdentifier: ZERO_HASH,
      recipient: params.evmSourceAddress,
    },
    extraDataTypestring:
      "string midenRecipientAccount,string midenFaucetId,string midenNoteType",
    extraData: {
      midenRecipientAccount: params.midenRecipientId,
      midenFaucetId: EPOCH_USDC_SEPOLIA.midenFaucetId,
      midenNoteType: "P2ID",
    },
  };
}

/** Reverse-quote: backend computes required USDC for the requested dUSDC out. */
export async function fetchQuote(
  sdk: EpochIntentSDK,
  params: EpochQuoteParams,
): Promise<EpochQuote> {
  const taskDataParams = buildTaskData(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { taskTypeString, intentData } = await sdk.getTaskData(
    taskDataParams as any,
  );
  const quoteResult = await sdk.getIntentQuote({
    sponsorAddress: params.evmSourceAddress,
    taskTypeString,
    intentData,
    isNative: false,
  });
  if (!quoteResult.success) {
    throw new Error(quoteResult.error ?? "Epoch quote failed");
  }
  return { taskTypeString, intentData, quoteResult, params };
}

/** Submit the intent — user signs ERC-20 approve + Compact deposit on Sepolia. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function submitIntent(sdk: EpochIntentSDK, quote: EpochQuote): Promise<any> {
  return sdk.solveIntent({
    isNative: false,
    sponsorAddress: quote.params.evmSourceAddress,
    taskTypeString: quote.taskTypeString,
    intentData: quote.intentData,
    quoteResult: quote.quoteResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collateralType: "evm" as any,
  });
}

/** Convert human dUSDC amount to base units (18 decimals on Epoch's test USDC). */
export function dusdcBaseUnits(human: string): string {
  return parseUnits(human || "0", EPOCH_USDC_SEPOLIA.decimals).toString();
}

/** Extract the intent nonce from solveIntent's result — Epoch's reply shape varies. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractNonce(solveResult: any): string | undefined {
  const raw =
    solveResult?.nonce ??
    solveResult?.submittedIntentData?.nonce ??
    solveResult?.compact?.nonce ??
    solveResult?.intentNonce;
  return raw != null ? String(raw) : undefined;
}
