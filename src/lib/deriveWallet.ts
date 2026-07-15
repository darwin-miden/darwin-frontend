import { keccak256 } from "viem";

/**
 * Secure derivation of the self-custody Miden wallet from an EVM
 * signature — the ONE place a signature becomes a signing key.
 *
 * The derived seed IS the Miden private key. This helper applies the
 * hardening the security review surfaced, in one auditable place:
 *
 *  1. EIP-712 typed data (not personal_sign): a legible, versioned
 *     "create your Miden key" prompt instead of an opaque hex blob.
 *     Versioned so a leaked key can be rotated (bump version → a
 *     brand-new wallet). The domain is deliberately NETWORK-INDEPENDENT
 *     (no chainId): the derived wallet must be identical whatever EVM
 *     network MetaMask happens to be on, otherwise a user who switches
 *     network between visits would silently derive a different wallet
 *     and lose access to their funds. NOTE: EIP-712 does NOT bind the
 *     web origin — a phishing site can replay this exact payload and get
 *     the same key. The derived wallet is a HOT wallet; the UI must
 *     frame it as such.
 *
 *  2. EOA guard (fail-CLOSED): smart-contract / MPC / threshold wallets
 *     (Safe, Argent SCW, Fireblocks, ZenGo, cloud-KMS…) do NOT produce
 *     deterministic ECDSA signatures — deriving from them would silently
 *     produce a different wallet next time and lose funds. We refuse
 *     anything whose address carries code. If the on-chain code lookup
 *     itself fails (RPC hiccup) we retry, then BLOCK rather than derive
 *     blind — a wrong "it's an EOA" guess costs the user their funds,
 *     an availability blip costs them a retry. EIP-7702 delegated EOAs
 *     (code prefixed 0xef0100) still sign with their own secp256k1 key
 *     deterministically, so they are allowed.
 *
 *  3. Low-s canonicalisation: normalise s ≤ n/2 (+ flip v) before
 *     hashing, so a malleable/relayed signature can't yield a different
 *     seed than the wallet that signed it. The signature is first
 *     normalised from either the 65-byte (r,s,v) or the 64-byte
 *     EIP-2098 compact (r, yParityAndS) encoding — a compact signature
 *     silently truncated would corrupt the seed.
 *
 *  4. Minimal seed exposure: keccak straight to a Uint8Array (never a hex
 *     string — JS strings are immutable and can't be zeroed), handed
 *     straight to the WASM createWallet, and fill(0)-wiped in a finally.
 *     The seed is never returned, logged, persisted, or kept in a
 *     long-lived closure. Only the wallet id string leaves this function.
 */

// @miden-sdk/react hard-codes a broken default AuthScheme symbol; the
// wasm binding wants the numeric enum (2 = AuthRpoFalcon512).
const AUTH_SCHEME_FALCON_ENUM_VALUE = 2;

// Bump to rotate every derived wallet (e.g. after a suspected leak).
export const DERIVE_VERSION = 1;

const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const HALF_N = SECP256K1_N / 2n;
// EIP-2098: the compact encoding packs yParity into the top bit of s.
const S_MASK = (1n << 255n) - 1n;

/**
 * EIP-712 typed data for the derivation. Fields pin the key to (this
 * EOA, this version) so it can't be silently reused across accounts and
 * can be rotated. Deliberately NO chainId (see note 1) — the key must be
 * stable across network switches.
 */
export function deriveTypedData(evmAddress: `0x${string}`, keyIndex: bigint = 0n) {
  return {
    domain: {
      name: "Darwin Miden Key Derivation",
      version: "1",
    },
    types: {
      MidenKeyDerivation: [
        { name: "purpose", type: "string" },
        { name: "account", type: "address" },
        { name: "version", type: "uint256" },
        { name: "keyIndex", type: "uint256" },
      ],
    },
    primaryType: "MidenKeyDerivation" as const,
    message: {
      purpose: "Deterministic Miden (Falcon-512) signing key",
      account: evmAddress,
      version: BigInt(DERIVE_VERSION),
      keyIndex,
    },
  };
}

/**
 * Normalise a signature (65-byte r||s||v OR 64-byte EIP-2098 r||yParityAndS)
 * to canonical low-s (r,s,v) bytes. Throws on any other length so a
 * malformed signature can never silently corrupt the derived seed.
 * Returns fresh 65 bytes.
 */
function canonicalizeSignature(sig: `0x${string}`): Uint8Array {
  const hex = sig.slice(2);
  let r: string;
  let s: bigint;
  let v: number;

  if (hex.length === 130) {
    // Standard r (32) || s (32) || v (1).
    r = hex.slice(0, 64);
    s = BigInt("0x" + hex.slice(64, 128));
    v = parseInt(hex.slice(128, 130), 16);
    if (v < 27) v += 27; // some signers return 0/1
  } else if (hex.length === 128) {
    // EIP-2098 compact: r (32) || yParityAndS (32).
    r = hex.slice(0, 64);
    const yParityAndS = BigInt("0x" + hex.slice(64, 128));
    s = yParityAndS & S_MASK;
    const yParity = yParityAndS >> 255n;
    v = yParity === 1n ? 28 : 27;
  } else {
    throw new Error(
      `Unexpected signature length (${hex.length / 2} bytes); refusing to derive a key from a malformed signature.`,
    );
  }

  if (s > HALF_N) {
    s = SECP256K1_N - s;
    v = v === 27 ? 28 : 27;
  }
  const full =
    r + s.toString(16).padStart(64, "0") + v.toString(16).padStart(2, "0");
  const bytes = new Uint8Array(full.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(full.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateWallet = (opts: any) => Promise<{ id: () => { toString: () => string } }>;

type TypedData = ReturnType<typeof deriveTypedData>;

export interface DeriveOptions {
  evmAddress: `0x${string}`;
  signTypedData: (td: TypedData) => Promise<`0x${string}`>;
  /** Optional EOA guard: return the address' on-chain bytecode ("0x" for an EOA). */
  getCode?: (addr: `0x${string}`) => Promise<`0x${string}` | undefined>;
  /**
   * Derive a distinct wallet under the same EOA (default 0 = the user's
   * primary wallet). Used by the autonomous E2E to isolate runs without
   * diverging from the production derivation path.
   */
  keyIndex?: bigint;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Fail-closed EOA check. Retries the code lookup a couple of times, then
 * — if it still can't confirm the address is a plain EOA — throws rather
 * than deriving from an unverified (possibly non-deterministic) signer.
 */
async function assertPlainEoa(
  getCode: NonNullable<DeriveOptions["getCode"]>,
  addr: `0x${string}`,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const code = await getCode(addr);
      const c = (code ?? "0x").toLowerCase();
      // Plain EOA, or an EIP-7702 delegated EOA (still a deterministic
      // secp256k1 signer) — allow.
      if (c === "0x" || c === "" || c.startsWith("0xef0100")) return;
      throw new Error(
        "This looks like a smart-contract or MPC wallet, which can't deterministically re-derive your Miden key — your funds could become inaccessible. Use a standard EOA (MetaMask, Ledger, Trezor) or a Miden-native wallet.",
      );
    } catch (e) {
      // A thrown "SCW detected" error must propagate, not be retried.
      if (e instanceof Error && /smart-contract or MPC/.test(e.message)) throw e;
      lastErr = e;
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(
    "Couldn't verify your wallet type on-chain (network error). For your safety we won't derive a key without confirming it's a standard wallet — please check your connection and try again.",
  );
}

export async function deriveMidenWallet(
  createWallet: CreateWallet,
  opts: DeriveOptions,
): Promise<string> {
  // (2) EOA guard — refuse non-deterministic signers before signing.
  if (opts.getCode) {
    await assertPlainEoa(opts.getCode, opts.evmAddress);
  }

  // (1) EIP-712 signature (network-independent domain).
  const sig = await opts.signTypedData(
    deriveTypedData(opts.evmAddress, opts.keyIndex ?? 0n),
  );

  // (3) low-s canonicalise, then (4) keccak → bytes, wipe intermediates.
  const canon = canonicalizeSignature(sig);
  const seedBytes = keccak256(canon, "bytes");
  canon.fill(0);
  try {
    const acc = await createWallet({
      initSeed: seedBytes,
      storageMode: "private",
      authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE,
    });
    return acc.id().toString();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = msg.match(/id (0x[0-9a-fA-F]+)/);
    if (m && /already being tracked/i.test(msg)) return m[1];
    throw e;
  } finally {
    seedBytes.fill(0);
  }
}
