"use client";

/**
 * Shared helpers for the trustless flow's position accounting against
 * the v8-noauth controller. Used by both TrustlessDepositPanel (credit
 * on deposit) and TrustlessRedeemPanel (debit on redeem) so the two
 * legs stay in one accounting model: read current slot-10 value,
 * apply the delta, write the new absolute value with
 * `set_user_position`.
 */

import { TRUSTLESS_CONTROLLER_HEX } from "./midenConstants";
// EVM address → (user_id_suffix, user_id_prefix). Imported from the isomorphic
// source of truth (also used here in fetchTrustlessPosition) and re-exported so
// the server-side backup-write auth check keys the slot with the exact same
// encoding as this client path (and the worker).
import { evmToUserIdFelts } from "./userIdFelts";

export { TRUSTLESS_CONTROLLER_HEX, evmToUserIdFelts };

// MAST root of `set_user_position` on the v6/v7/v8 controller. Same MASM
// deployed under all three; the root is stable across auth-component
// variants (v7 SingleSig, v8 NoAuth, v8-network).
export const SET_USER_POSITION_MAST =
  "0xea652ac9aa1b6ee468da0845b52008ffa4639d112f356534ba608bc00d7b6f5f";

// The tx script that runs against v8-noauth to write slot-10 for a
// specific (user_id, amount). Direct `set_user_position` call — the
// NoAuth component means anyone can submit this tx bundle without any
// signing key.
export function buildSetPositionScript(
  suffix: bigint,
  prefix: bigint,
  amount: bigint,
  basketSuffix: bigint = 0n,
  basketPrefix: bigint = 0n,
): string {
  // MASM directive is `use <namespace>` (space), not `use.<namespace>` —
  // the 0.15 assembler in the Miden Web SDK rejects the dot form.
  //
  // Key word = [basket_prefix, basket_suffix, user_prefix, user_suffix]
  // (top-down) — the exact layout atomic_deposit_note_v2 and the
  // /api/position read script use, so per-basket entries line up with
  // the rest of the stack. basket (0, 0) = the legacy flat demo slot.
  return `use miden::core::sys

begin
    # VALUE word first (goes to bottom):
    #   [0, 0, 0, amount]
    push.${amount.toString()} push.0 push.0 push.0

    # KEY word on top:
    #   [basket_prefix, basket_suffix, user_prefix, user_suffix]
    push.${suffix.toString()} push.${prefix.toString()}
    push.${basketSuffix.toString()} push.${basketPrefix.toString()}

    call.${SET_USER_POSITION_MAST}

    exec.sys::truncate_stack
end
`;
}

/**
 * Derive the (suffix, prefix) felts of a basket-token faucet AccountId —
 * the basket half of the slot-10 key. Same derivation
 * MidenPortfolioSection uses for its reads.
 */
export async function basketFelts(faucetHex: string): Promise<{
  basketSuffix: bigint;
  basketPrefix: bigint;
}> {
  const { AccountId } = await import("@miden-sdk/miden-sdk");
  const id = AccountId.fromHex(faucetHex);
  return {
    basketSuffix: BigInt(id.suffix().asInt().toString()),
    basketPrefix: BigInt(id.prefix().asInt().toString()),
  };
}

/**
 * Read the current slot-10 position for an EVM user from the trustless
 * controller. Goes through /api/position (the operator-side
 * miden-client read); the data itself is public account storage — the
 * API is just an indexer convenience, not a trust dependency for
 * writes.
 *
 * Returns 0n when the read fails or the user has no entry, so callers
 * can treat "no position yet" and "indexer briefly down" the same way
 * on the credit path (they add to 0). The debit path double-checks
 * with `positionKnown` to avoid wiping a real balance on a failed read.
 */
export async function fetchTrustlessPosition(
  evmAddr: string,
  basket?: { basketSuffix: bigint; basketPrefix: bigint },
): Promise<{
  position: bigint;
  positionKnown: boolean;
}> {
  try {
    const { suffix, prefix } = evmToUserIdFelts(evmAddr);
    const r = await fetch("/api/position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suffix: suffix.toString(),
        prefix: prefix.toString(),
        basketSuffix: (basket?.basketSuffix ?? 0n).toString(),
        basketPrefix: (basket?.basketPrefix ?? 0n).toString(),
        controllerId: TRUSTLESS_CONTROLLER_HEX,
      }),
    });
    if (!r.ok) return { position: 0n, positionKnown: false };
    const j = (await r.json()) as { position?: string };
    if (j?.position == null) return { position: 0n, positionKnown: false };
    return { position: BigInt(j.position), positionKnown: true };
  } catch {
    return { position: 0n, positionKnown: false };
  }
}
