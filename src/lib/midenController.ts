/**
 * Helpers for reading the live Darwin controller's on-chain state.
 *
 * The v6 controller (account 0xbef7d2e89e9c3e006e10f959fa16d2) is a
 * strict superset of v5 — adds slot 11 (fee_recipient) and a
 * receive_and_credit compound proc — and is the current default
 * across worker + relay. The storage maps the frontend cares about
 * are unchanged from v5:
 *
 *   slot 3 (target_weights)  basket_id -> [w0, w1, w2, 0] bps
 *   slot 4 (fees)            basket_id -> [mint, redeem, mgmt, 0] bps
 *   slot 10 (user_positions) (user_id || basket_id) -> [amount, 0, 0, 0]
 *   slot 11 (fee_recipient)  account_id_word                       (v6 only)
 *
 * MAST roots are pinned here so the tx-scripts the frontend builds
 * can call them directly.
 *
 * Two parallel sets are maintained during the v0.14 → v0.15 migration:
 *
 *   MAST_ROOTS_V014: pinned against the live v6 controller deployed
 *   on Miden testnet (account 0xbef7d2e8…). These are what the
 *   shipped production frontend uses.
 *
 *   MAST_ROOTS_V015: pinned against the controller package rebuilt
 *   under miden-protocol 0.15.3 / miden-assembly 0.23.3 (MAST wire
 *   format 0.0.3). These will replace V014 once the v0.15 controller
 *   is redeployed on Miden Devnet — until then the redeploy address
 *   is not known and the live frontend still uses V014.
 *
 *   Both sets come from `cargo run --bin build_v6_fee_routing_controller`
 *   on their respective toolchains.
 */

export const CONTROLLER_ID = "0xbef7d2e89e9c3e006e10f959fa16d2";

export const MAST_ROOTS_V014 = {
  get_target_weights: "0xd63bb900370d555c4a73142cc101b1d0c8bc47cf25c7ec8ee61002891608e3c6",
  get_fees:            "0xfed5e0d0b487e48aec20a2bcd91995303f2b0cddb18ea8cb85424bdeec96dd0b",
  get_user_position:   "0xc9ccec5458661be113ea48c9d8947d10bfe4705a53a7aeee76c273733f88bf38",
  get_fee_recipient:   "0x1190c4fb84061506d07c85fa3e1fcfbad1f568f68fa6c3f3ad2a6209054a9da8",
  set_target_weights:  "0x57a8ef319a2fe090f649760c4db4fdfc698496778daaea8f496cc46070e4057c",
  set_fees:            "0xf2624ee2a579f81446f60cba7fdb06058c36fa2a06fc1b67accaafdd0d86e3f8",
  set_user_position:   "0xa017ac3e12d53bad11bfb8b4289a3bd2c4deef4c67a5209c53703dacbbe2d335",
  set_fee_recipient:   "0x6721d6156a7a78b8eea224963e4375ee7423ac2d2f79d58a1c5af542f370d9a4",
  receive_asset:       "0x75f638c65584d058542bcf4674b066ae394183021bc9b44dc2fdd97d52f9bcfb",
  receive_and_credit:  "0xeae9e249a88021a2fb6bcae39148f528ee98d5fc884290a42f961b9a536c763e",
} as const;

// New MAST roots under miden-protocol 0.15.3 / miden-assembly 0.23.3.
// Wire-format 0.0.3 rehashes every procedure so all 10 roots shift.
// Sourced from `build_v6_fee_routing_controller` against the v0.15
// workspace on 2026-06-19. Active path will swap to these once the
// v0.15 controller is redeployed on Miden Devnet.
export const MAST_ROOTS_V015 = {
  get_target_weights: "0x48ce893c8e6def417c17b75c77f7b70238748253c17c5e42e7293bb7d6f4daee",
  get_fees:            "0x3f4209cb52091cb69187ab75ff3219ab7b0ff4a17207dfccfc9c06ebe76ae93e",
  get_user_position:   "0x47b239ea11ad0375cca5a082369f721729c6d63a1fb170e6b5be5755dd06301f",
  get_fee_recipient:   "0xd4e46029536b4d308c52c3d501daef7bf552f0c3d6da8aead7dd094d824ad5df",
  set_target_weights:  "0x26a369cd6781d75d40169223996afcc98602775ce4b6fe9bba8236eb70ceb8e2",
  set_fees:            "0xfbcc4fdd3852fc7ea0325e62377af7692845f558a2f0e503c5c52edbbde1ed26",
  set_user_position:   "0xea652ac9aa1b6ee468da0845b52008ffa4639d112f356534ba608bc00d7b6f5f",
  set_fee_recipient:   "0xfed8024bd5134e2229d0ac853fd9191bf3f43479e85af96499c4a05785df6e6c",
  receive_asset:       "0x6170fd6d682d91777b551fd866258f43cc657f1291f8f071500f4e56e9c153da",
  receive_and_credit:  "0x849f526236e9a7ab84a183da209666c3e2839efaeb7d5866a6dca043fdaddc10",
} as const;

// Active set: switch via NEXT_PUBLIC_MIDEN_V015 when the v0.15 Devnet
// redeploy is live. Falls back to V014 so production frontend
// continues to call into the deployed v6 controller on testnet.
export const MAST_ROOTS =
  process.env.NEXT_PUBLIC_MIDEN_V015 === "1" ? MAST_ROOTS_V015 : MAST_ROOTS_V014;

const FELT_MASK = (1n << 63n) - 1n;

/**
 * Pack an EVM address (20 bytes) into the (suffix, prefix) felt pair
 * used as the high half of the user_positions storage map key.
 * Mirrors the worker's `hex_to_evm` + felt-mask logic exactly so
 * frontend reads land on the same key the worker writes.
 */
export function evmToUserIdFelts(addrHex: string): { suffix: bigint; prefix: bigint } {
  const h = addrHex.replace(/^0x/, "").toLowerCase();
  if (h.length !== 40) {
    throw new Error(`evm address must be 20 bytes (40 hex chars), got ${h.length}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  }
  // suffix = last 8 bytes (bytes 12..20) as little-endian u64
  // prefix = bytes 4..12 as little-endian u64
  // matches the worker's u64::from_le_bytes calls.
  const suffix = leBytesToBigInt(bytes.subarray(12, 20)) & FELT_MASK;
  const prefix = leBytesToBigInt(bytes.subarray(4, 12)) & FELT_MASK;
  return { suffix, prefix };
}

function leBytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < b.length; i++) {
    n |= BigInt(b[i]) << (8n * BigInt(i));
  }
  return n;
}

/**
 * Build the tx-script source that calls `get_user_position` against
 * the current controller and leaves the position word on the stack.
 *
 * The key layout matches the worker's set_user_position payload:
 *   key = (user_id_suffix, user_id_prefix, 0, 0)
 *   where basket_id pad slots are 0 in M3 (a future iteration splits multi-basket).
 *
 * Stack on exit: [position_first_felt, 0, 0, 0]
 */
export function buildUserPositionScript(userEvmAddr: string): string {
  const { suffix, prefix } = evmToUserIdFelts(userEvmAddr);
  return buildUserPositionScriptFromFelts(suffix, prefix);
}

/**
 * Same as `buildUserPositionScript` but takes the user_id felts
 * directly — used by the Miden-native flow where the user_id is the
 * Miden wallet's AccountId (suffix + prefix from `AccountId.suffix()`
 * / `.prefix()`) rather than an EVM address.
 *
 * `basketSuffix` / `basketPrefix` are the basket-token faucet's
 * AccountId felts. They make the slot-10 key per-(user, basket) so
 * each basket carries its own balance. Pass `0n / 0n` to fall back
 * to the legacy single-slot semantics.
 *
 * The atomic_deposit_note_v2 script writes the same 4-felt key when
 * it calls `set_user_position`, so this read lands on the exact
 * slot-10 entry the deposit created.
 */
export function buildUserPositionScriptFromFelts(
  suffix: bigint,
  prefix: bigint,
  basketSuffix: bigint = 0n,
  basketPrefix: bigint = 0n,
): string {
  // Key word must be [basket_prefix, basket_suffix, user_prefix,
  // user_suffix] (top-down) — the SAME order the atomic_deposit note's
  // set_user_position writes. get_map_item and set_map_item take the
  // key in the same order, so reading with any other arrangement
  // targets a different map slot and always comes back empty.
  //
  // The stored position word is [0, 0, 0, amount]; sum its four felts
  // (add add add) so the amount lands on the stack top regardless of
  // which felt holds it, and the caller can read result.stack[0].
  return `use miden::core::sys

begin
  push.${suffix.toString()} push.${prefix.toString()}
  push.${basketSuffix.toString()} push.${basketPrefix.toString()}
  call.${MAST_ROOTS.get_user_position}
  add add add
  exec.sys::truncate_stack
end
`;
}
