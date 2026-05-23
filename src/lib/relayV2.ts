/**
 * darwin-relay v2 client.
 *
 * The relay is the Miden-side custodial component for ETH users:
 * it owns a Miden account that 1Click delivers bridged ETH into,
 * runs atomic_deposit_note against the basket controller for the
 * user, and tracks the resulting basket position keyed by EVM
 * address. The frontend talks to it in two places:
 *
 *  1. *Before* requesting a 1Click quote — to claim a correlation_id
 *     and discover the relay's Miden recipient address.
 *  2. *After* the user's Sepolia tx confirms — to hand the relay the
 *     deposit_address + sepolia_tx so it can mark the intent as
 *     KNOWN_DEPOSIT_TX and start polling 1Click.
 *
 * Status is polled from the relay (not 1Click directly), so the UI
 * sees the relay's unified state machine through to POSITION_CREDITED.
 */
export type RelayIntentStage =
  | "QUOTED"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "ONECLICK_SUCCESS"
  | "POSITION_CREDITED"
  | "ERROR";

export interface RelayIntentCreateRequest {
  user_evm_addr: string;
  basket_symbol: string;
  amount_in_wei: string;
}

export interface RelayIntentCreateResponse {
  correlation_id: string;
  relay_miden_address: string;
  expires_at: number;
}

export interface RelayIntent {
  correlation_id: string;
  user_evm_addr: string;
  basket_symbol: string;
  amount_in_wei: string;
  stage: RelayIntentStage;
  deposit_address: string | null;
  sepolia_tx: string | null;
  atomic_deposit_tx: string | null;
  miden_consume_tx: string | null;
  basket_amount_minted: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface RelayPosition {
  user_evm_addr: string;
  basket_symbol: string;
  basket_amount: string;
  correlation_id: string;
  updated_at: number;
}

const BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_RELAY_V2_URL) ||
  "http://localhost:8090";

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
    throw new Error(`relay-v2 ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

export function createIntent(
  req: RelayIntentCreateRequest,
): Promise<RelayIntentCreateResponse> {
  return http<RelayIntentCreateResponse>("/v0/intents", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function getIntent(correlationId: string): Promise<RelayIntent> {
  return http<RelayIntent>(`/v0/intents/${encodeURIComponent(correlationId)}`);
}

export function attachDeposit(
  correlationId: string,
  args: { deposit_address: string; sepolia_tx: string },
): Promise<{ ok: boolean; stage: RelayIntentStage }> {
  return http(`/v0/intents/${encodeURIComponent(correlationId)}/deposit`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}

interface RawPositionsResp {
  user: string;
  positions: Array<{
    basket_symbol: string;
    basket_amount: string;
    last_correlation_id: string | null;
    last_updated: number;
  }>;
}

export async function getPositions(userEvmAddr: string): Promise<RelayPosition[]> {
  const r = await http<RawPositionsResp>(
    `/v0/positions/${encodeURIComponent(userEvmAddr)}`,
  );
  return r.positions.map((p) => ({
    user_evm_addr: r.user,
    basket_symbol: p.basket_symbol,
    basket_amount: p.basket_amount,
    correlation_id: p.last_correlation_id ?? "",
    updated_at: p.last_updated,
  }));
}

export interface RelayRedeemResponse {
  redemption_id: string;
  user_evm_addr: string;
  basket_symbol: string;
  basket_amount: string;
  stage: string;
}

export function redeem(args: {
  user_evm_addr: string;
  basket_symbol: string;
  basket_amount: string;
}): Promise<RelayRedeemResponse> {
  return http<RelayRedeemResponse>("/v0/redeem", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export interface RelayRedemption {
  redemption_id: string;
  user_evm_addr: string;
  basket_symbol: string;
  basket_amount: string;
  stage: string;
  oneclick_correlation: string | null;
  miden_redeem_tx: string | null;
  miden_bridge_out_tx: string | null;
  sepolia_release_tx: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function getRedemption(id: string): Promise<RelayRedemption> {
  return http<RelayRedemption>(`/v0/redeem/${encodeURIComponent(id)}`);
}

interface RawRedemptionsResp {
  user: string;
  redemptions: RelayRedemption[];
}

export async function listRedemptionsForUser(
  userEvmAddr: string,
): Promise<RelayRedemption[]> {
  const r = await http<RawRedemptionsResp>(
    `/v0/redemptions/${encodeURIComponent(userEvmAddr)}`,
  );
  return r.redemptions;
}

export const RELAY_V2_URL = BASE;
