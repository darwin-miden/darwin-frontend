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

export { TRUSTLESS_CONTROLLER_HEX };

// MAST root of `set_user_position` on the v6/v7/v8 controller. Same MASM
// deployed under all three; the root is stable across auth-component
// variants (v7 SingleSig, v8 NoAuth, v8-network).
export const SET_USER_POSITION_MAST =
  "0xea652ac9aa1b6ee468da0845b52008ffa4639d112f356534ba608bc00d7b6f5f";

// EVM address → (user_id_suffix, user_id_prefix) — same encoding the
// worker uses (bytes 12..20 = suffix, bytes 4..12 = prefix, both LE u64
// masked to 63 bits so they fit inside a Miden Felt).
export function evmToUserIdFelts(evmAddr: string): {
  suffix: bigint;
  prefix: bigint;
} {
  const hex = evmAddr.replace(/^0x/, "").toLowerCase();
  const bytes = new Uint8Array(
    hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );
  const readLE = (start: number) => {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(bytes[start + i]) << BigInt(8 * i);
    return v & ((1n << 63n) - 1n);
  };
  return { suffix: readLE(12), prefix: readLE(4) };
}

// The tx script that runs against v8-noauth to write slot-10 for a
// specific (user_id, amount). Direct `set_user_position` call — the
// NoAuth component means anyone can submit this tx bundle without any
// signing key.
export function buildSetPositionScript(
  suffix: bigint,
  prefix: bigint,
  amount: bigint,
): string {
  // MASM directive is `use <namespace>` (space), not `use.<namespace>` —
  // the 0.15 assembler in the Miden Web SDK rejects the dot form.
  return `use miden::core::sys

begin
    # VALUE word first (goes to bottom):
    #   [0, 0, 0, amount]
    push.${amount.toString()} push.0 push.0 push.0

    # KEY word on top:
    #   [0, 0, user_prefix, user_suffix]
    push.${suffix.toString()} push.${prefix.toString()} push.0 push.0

    call.${SET_USER_POSITION_MAST}

    exec.sys::truncate_stack
end
`;
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
export async function fetchTrustlessPosition(evmAddr: string): Promise<{
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
