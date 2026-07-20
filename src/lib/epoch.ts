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

import { EPOCH_DUSDC_FAUCET_ID } from "./midenConstants";

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

// Canonical Epoch witness extra-typestrings — must match the allocator's
// typehash EXACTLY (it hashes these fields into the compact). These mirror the
// SDK's own EVM_TO_MIDEN_EXTRA_TYPESTRING / MIDEN_TO_EVM_EXTRA_TYPESTRING (which
// aren't re-exported at the package root) and the working reference example. Do
// NOT append fields: we used to add `midenNoteType` (deposit) and
// `midenNoteType`/`midenReclaimHeight` (redeem), which changed the typehash and
// made `POST /compact` reject the registration with "A quote isn't available".
const EVM_TO_MIDEN_EXTRA_TYPESTRING =
  "string midenRecipientAccount,string midenFaucetId";
const MIDEN_TO_EVM_EXTRA_TYPESTRING =
  "string midenSourceAccount,string midenFaucetId,string midenNoteId";

// Epoch's test USDC on Sepolia — same address the bridging-app uses.
// EVM side is 18-decimal (NOT the canonical 6-dec USDC); Miden side is
// 6-decimal (verified live 2026-07-04 with the fresh Epoch faucet table:
// 1 USDC in → ~0.996 dUSDC out — see EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS).
export const EPOCH_USDC_SEPOLIA = {
  symbol: "USDC",
  address: "0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69" as `0x${string}`,
  decimals: 18,
  midenFaucetId: EPOCH_DUSDC_FAUCET_ID,
  midenDecimals: 6,
} as const;

/**
 * Slippage buffer for Epoch minTokenOut on Sepolia→Miden.
 *
 * Epoch's testnet solver quotes ~0.996 dUSDC per 1 Sepolia USDC (measured
 * ~0.68% haircut on-chain 2026-07-16). minTokenOut must sit BELOW that
 * quote or the solver returns NO_QUOTE_AVAILABLE — so we can't ask for the
 * exact human amount. But 5% was far too generous for a 1:1 stablecoin
 * bridge (it made "1" deposit only ~0.96): 100 bps = 1% keeps minTokenOut
 * just under the ~0.996 quote, so "1" now deposits + delivers ~0.99 — much
 * closer to what the user typed. Bump back up if NO_QUOTE reappears on
 * testnet drift.
 */
export const EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS = 100;

/** Apply a bps-denominated slippage discount to a base-unit amount. */
export function applySlippageBps(baseUnits: string, bps: number): string {
  return ((BigInt(baseUnits) * BigInt(10_000 - bps)) / 10_000n).toString();
}

export interface EpochQuoteParams {
  /** Sepolia EVM address of the signer (user wallet). */
  evmSourceAddress: `0x${string}`;
  /** Miden recipient — the relay wallet's hex Miden account id. */
  midenRecipientId: string;
  /** Min Miden output, base units of the dUSDC faucet (6 decimals). */
  minTokenOut: string;
  /**
   * Exact USDC INPUT to send (Sepolia base units, 18-dec). When set (non-zero)
   * this is a FORWARD quote: the user sends exactly this much USDC and the
   * backend computes the dUSDC output — so "deposit 7" sends exactly 7 and Max =
   * the full balance always fits. When "0"/omitted it's a reverse quote (backend
   * computes the required USDC from minTokenOut — the input then exceeds the
   * typed amount, which breaks Max).
   */
  tokenInAmount?: string;
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
      // Forward quote when tokenInAmount is a non-zero exact USDC input (send
      // exactly what the user typed); "0" falls back to reverse-quote.
      tokenInAmount: params.tokenInAmount ?? "0",
      outputTokenAddress: ZERO_ADDRESS,
      minTokenOut: params.minTokenOut,
      destinationChainId: String(MIDEN_DESTINATION_CHAIN_ID),
      protocolHashIdentifier: ZERO_HASH,
      recipient: params.evmSourceAddress,
    },
    // Match the reference example exactly: no midenNoteType (the solver picks
    // the delivery note type). Adding it broke the /compact registration.
    extraDataTypestring: EVM_TO_MIDEN_EXTRA_TYPESTRING,
    extraData: {
      midenRecipientAccount: params.midenRecipientId,
      midenFaucetId: EPOCH_USDC_SEPOLIA.midenFaucetId,
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

/** Convert human USDC amount to Sepolia 18-dec base units (relay's `amount_in_wei`). */
export function usdcSepoliaBaseUnits(human: string): string {
  return parseUnits(human || "0", EPOCH_USDC_SEPOLIA.decimals).toString();
}

/* ═══════════════════════════════════════════════════════════════════
 * Redeem path — Miden → Sepolia via Epoch (reverse of the deposit)
 * ═══════════════════════════════════════════════════════════════════
 *
 * Mirror of buildTaskData / fetchQuote / submitIntent for the "give me
 * back Sepolia USDC" direction. User creates a P2ID(E) note on Miden
 * targeting Epoch's allocator; solver consumes the note and pays USDC
 * on Sepolia.
 */

export interface EpochRedeemParams {
  /** User's derived Miden wallet — the P2ID note sender. */
  midenSourceId: string;
  /** User's Sepolia address — where USDC lands. */
  evmRecipient: `0x${string}`;
  /** Min Sepolia USDC out, base units (18 decimals for Epoch's test USDC). */
  minUsdcSepoliaBaseUnits: string;
}

export interface EpochRedeemQuote {
  taskTypeString: string;
  intentData: unknown;
  quoteResult: IntentQuoteResult;
  params: EpochRedeemParams;
}

function buildRedeemTaskData(params: EpochRedeemParams) {
  return {
    taskType: "gettokenout" as const,
    intentData: {
      // isNative=false: tokenIn is address(0) here because the Miden side is
      // "off-chain" — the SDK's Miden bridging path expects zero-address
      // depositTokenAddress + midenSourceAccount + midenFaucetId in extraData.
      isNative: false,
      depositTokenAddress: ZERO_ADDRESS,
      tokenInAmount: "0", // reverse quote: backend computes dUSDC input
      outputTokenAddress: EPOCH_USDC_SEPOLIA.address,
      minTokenOut: params.minUsdcSepoliaBaseUnits,
      destinationChainId: String(SEPOLIA_CHAIN_ID),
      protocolHashIdentifier: ZERO_HASH,
      recipient: params.evmRecipient,
    },
    // Canonical typestring (only midenNoteId is hashed). midenNoteType /
    // midenReclaimHeight ride in extraData for the solver but are NOT declared
    // here, exactly like the reference example — declaring them changed the
    // typehash and broke /compact.
    extraDataTypestring: MIDEN_TO_EVM_EXTRA_TYPESTRING,
    extraData: {
      midenSourceAccount: params.midenSourceId,
      midenFaucetId: EPOCH_USDC_SEPOLIA.midenFaucetId,
      // P2IDE = P2ID + Extra data (reclaim height) — reference-app spec.
      midenNoteType: "P2IDE",
      midenNoteId: "", // set by SDK after createMidenP2IDNote callback
      midenReclaimHeight: "1000",
    },
  };
}

export async function fetchRedeemQuote(
  sdk: EpochIntentSDK,
  params: EpochRedeemParams,
): Promise<EpochRedeemQuote> {
  const taskDataParams = buildRedeemTaskData(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { taskTypeString, intentData } = await sdk.getTaskData(
    taskDataParams as any,
  );
  const quoteResult = await sdk.getIntentQuote({
    sponsorAddress: params.evmRecipient,
    taskTypeString,
    intentData,
    isNative: false,
  });
  if (!quoteResult.success) {
    throw new Error(quoteResult.error ?? "Epoch redeem quote failed");
  }
  return { taskTypeString, intentData, quoteResult, params };
}

/**
 * Submit the redeem intent — user creates a P2IDE note on Miden, and Epoch
 * solver consumes it and pays USDC on Sepolia. `createMidenP2IDNote` is the
 * callback the SDK invokes to build the note (via useSend on the derived
 * wallet). No Sepolia tx is signed by the user.
 */
export async function submitRedeemIntent(
  sdk: EpochIntentSDK,
  quote: EpochRedeemQuote,
  createMidenP2IDNote: (
    faucetId: string,
    amount: string,
    allocatorId: string,
  ) => Promise<{ success: boolean; noteId?: string }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return sdk.solveIntent({
    isNative: false,
    sponsorAddress: quote.params.evmRecipient,
    taskTypeString: quote.taskTypeString,
    intentData: quote.intentData,
    quoteResult: quote.quoteResult,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collateralType: "miden" as any,
    midenSourceAccount: quote.params.midenSourceId,
    midenFaucetId: EPOCH_USDC_SEPOLIA.midenFaucetId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMidenP2IDNote: createMidenP2IDNote as any,
  });
}

/** Convert human dUSDC amount to Miden 6-dec base units (Epoch `minTokenOut`). */
export function dusdcMidenBaseUnits(human: string): string {
  return parseUnits(human || "0", EPOCH_USDC_SEPOLIA.midenDecimals).toString();
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
