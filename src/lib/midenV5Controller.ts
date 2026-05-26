/**
 * Helpers for reading the v5 Darwin controller's on-chain state.
 *
 * The v5 controller (deployed 2026-05-26, account
 * 0x9419f2044acb77800a4c91a0cb50e5) has three storage maps the
 * frontend cares about:
 *
 *   slot 3 (target_weights)  basket_id -> [w0, w1, w2, 0] bps
 *   slot 4 (fees)            basket_id -> [mint, redeem, mgmt, 0] bps
 *   slot 10 (user_positions) (user_id || basket_id) -> [amount, 0, 0, 0]
 *
 * All reads go through `get_*` procs that wrap the raw storage map
 * lookup. The MAST roots are baked at compile time and pinned here
 * so the tx-scripts the frontend builds can call them directly.
 *
 * Mast roots match what `build_v5_full_storage_controller` emits;
 * if the v5 MASM changes, regenerate these and the deploy.
 */

export const V5_CONTROLLER_ID = "0x9419f2044acb77800a4c91a0cb50e5";

export const V5_MAST_ROOTS = {
  get_target_weights: "0xbb1bbfeee50296c8a111353ca4017ea213b1619bd9bfaa49682d4e219b576486",
  get_fees:            "0xc503631687186cf924f1933b51e97c25034dfa8d2e3bc4df950d009a1ae550ee",
  get_user_position:   "0x82ee7b22eab6b559ca4ea979753ff04303f561658f461936f98a70875150522c",
  set_target_weights:  "0x57a8ef319a2fe090f649760c4db4fdfc698496778daaea8f496cc46070e4057c",
  set_fees:            "0xf2624ee2a579f81446f60cba7fdb06058c36fa2a06fc1b67accaafdd0d86e3f8",
  set_user_position:   "0xa017ac3e12d53bad11bfb8b4289a3bd2c4deef4c67a5209c53703dacbbe2d335",
  receive_asset:       "0x75f638c65584d058542bcf4674b066ae394183021bc9b44dc2fdd97d52f9bcfb",
} as const;

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
 * the v5 controller and leaves the position word on the stack.
 *
 * The key layout matches the worker's set_user_position payload:
 *   key = (user_id_suffix, user_id_prefix, 0, 0)
 *   where basket_id pad slots are 0 in M3 (M4 splits multi-basket).
 *
 * Stack on exit: [position_first_felt, 0, 0, 0]
 */
export function buildUserPositionScript(userEvmAddr: string): string {
  const { suffix, prefix } = evmToUserIdFelts(userEvmAddr);
  // Push key word in the order set_map_item expects: suffix on top,
  // matching the call site for get_user_position.
  return `use miden::core::sys

begin
  push.0 push.0
  push.${prefix.toString()} push.${suffix.toString()}
  call.${V5_MAST_ROOTS.get_user_position}
  exec.sys::truncate_stack
end
`;
}
