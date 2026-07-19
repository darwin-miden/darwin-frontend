/**
 * EVM address → (user_id_suffix, user_id_prefix) — the canonical encoding the
 * on-chain worker uses to key a user's slot (bytes 12..20 = suffix, bytes 4..12
 * = prefix, both little-endian u64 masked to 63 bits so they fit inside a Miden
 * Felt).
 *
 * ISOMORPHIC + pure: no browser or Node APIs, so both the client
 * (trustlessController re-exports it) and server route handlers (e.g. the
 * backup-write auth check) share ONE source of truth. Any change here must stay
 * byte-identical to what the worker computes, or backups key to the wrong slot.
 */
export function evmToUserIdFelts(evmAddr: string): {
  suffix: bigint;
  prefix: bigint;
} {
  const hex = evmAddr.replace(/^0x/, "").toLowerCase();
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const readLE = (start: number) => {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(bytes[start + i]) << BigInt(8 * i);
    return v & ((1n << 63n) - 1n);
  };
  return { suffix: readLE(12), prefix: readLE(4) };
}
