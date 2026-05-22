/**
 * NEAR Intents 1Click client.
 *
 * Wraps the `/v0/*` API the
 * `BrianSeong99/miden-testnet-bridge` mock exposes. Same shape as the
 * production NEAR Intents 1Click service so the integration is a
 * URL flip when the hosted service ships.
 *
 * Verified live 2026-05-22 against the local Sepolia profile of
 * the bridge: 10000 gwei ETH Sepolia → Miden testnet round-trip in
 * ~70s, P2ID note minted on Miden.
 */

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
}

export interface OneClickQuoteRequest {
  dry: boolean;
  depositMode: "SIMPLE" | "INTENT";
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENT";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENT";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENT";
  deadline: string;
}

export interface OneClickQuote {
  depositAddress: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline: string;
  timeWhenInactive: string;
  timeEstimate: number;
}

export interface OneClickQuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: OneClickQuoteRequest;
  quote: OneClickQuote;
}

export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "INCOMING_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface OneClickStatusResponse {
  correlationId: string;
  quoteResponse: OneClickQuoteResponse;
  status: OneClickStatus | string;
  updatedAt: string;
  swapDetails: {
    intentHashes: string[];
    nearTxHashes: string[];
    originChainTxHashes: { hash: string; explorerUrl: string }[];
    destinationChainTxHashes: { hash: string; explorerUrl: string }[];
  };
}

const BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_ONECLICK_URL) ||
  "http://localhost:8080";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`1Click ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

export function listTokens(): Promise<OneClickToken[]> {
  return http<OneClickToken[]>("/v0/tokens");
}

export function quote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
  return http<OneClickQuoteResponse>("/v0/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function submitDeposit(args: {
  txHash: string;
  depositAddress: string;
}): Promise<OneClickStatusResponse> {
  return http<OneClickStatusResponse>("/v0/deposit/submit", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export function getStatus(depositAddress: string): Promise<OneClickStatusResponse> {
  return http<OneClickStatusResponse>(
    `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  );
}

export const ONE_CLICK_BRIDGE_URL = BASE;
