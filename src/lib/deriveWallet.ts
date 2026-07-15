import { keccak256 } from "viem";

/**
 * Secure derivation of the self-custody Miden wallet from an EVM
 * signature — the ONE place a signature becomes a signing key.
 *
 * The derived seed IS the Miden private key. This helper applies the
 * hardening the research surfaced, in one auditable place:
 *
 *  1. EIP-712 typed data (not personal_sign): a legible, versioned,
 *     network-scoped "create your Miden key" prompt instead of an opaque
 *     hex blob. Versioned so a leaked key can be rotated (bump version →
 *     a brand-new wallet). NOTE: EIP-712 does NOT bind the web origin — a
 *     phishing site can replay this exact payload and get the same key.
 *     The derived wallet is a HOT wallet; the UI must frame it as such.
 *
 *  2. EOA guard: smart-contract / MPC / threshold wallets (Safe, Argent
 *     SCW, Fireblocks, ZenGo, cloud-KMS…) do NOT produce deterministic
 *     ECDSA signatures — deriving from them would silently produce a
 *     different wallet next time and lose funds. Reject anything whose
 *     address carries code, and only derive from a raw EOA.
 *
 *  3. Low-s canonicalisation: normalise s ≤ n/2 (+ flip v) before
 *     hashing, so a malleable/relayed signature can't yield a different
 *     seed than the wallet that signed it. (MetaMask already low-s's, but
 *     this makes the derivation robust to any path.)
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

/**
 * EIP-712 typed data for the derivation. Fields pin the key to (this
 * EOA, this chain, this version) so it can't be silently reused across
 * accounts/networks and can be rotated.
 */
export function deriveTypedData(evmAddress: `0x${string}`, chainId: number) {
  return {
    domain: {
      name: "Darwin Miden Key Derivation",
      version: "1",
      chainId,
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
      keyIndex: 0n,
    },
  };
}

/** Normalise a 65-byte (r,s,v) signature to low-s. Returns fresh bytes. */
function canonicalizeSignature(sig: `0x${string}`): Uint8Array {
  const hex = sig.slice(2);
  const r = hex.slice(0, 64);
  let s = BigInt("0x" + hex.slice(64, 128));
  let v = parseInt(hex.slice(128, 130) || "1b", 16);
  if (s > HALF_N) {
    s = SECP256K1_N - s;
    v = v === 27 ? 28 : v === 28 ? 27 : v ^ 1;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypedData = ReturnType<typeof deriveTypedData>;

export interface DeriveOptions {
  evmAddress: `0x${string}`;
  chainId: number;
  signTypedData: (td: TypedData) => Promise<`0x${string}`>;
  /** Optional EOA guard: return the address' on-chain bytecode ("0x" for an EOA). */
  getCode?: (addr: `0x${string}`) => Promise<`0x${string}` | undefined>;
}

export async function deriveMidenWallet(
  createWallet: CreateWallet,
  opts: DeriveOptions,
): Promise<string> {
  // (2) EOA guard — refuse non-deterministic signers before signing.
  if (opts.getCode) {
    let code: `0x${string}` | undefined;
    try {
      code = await opts.getCode(opts.evmAddress);
    } catch {
      code = undefined; // RPC hiccup — don't hard-block on the guard
    }
    if (code && code !== "0x") {
      throw new Error(
        "This looks like a smart-contract or MPC wallet, which can't deterministically re-derive your Miden key — your funds could become inaccessible. Use a standard EOA (MetaMask, Ledger, Trezor) or a Miden-native wallet.",
      );
    }
  }

  // (1) EIP-712 signature.
  const sig = await opts.signTypedData(deriveTypedData(opts.evmAddress, opts.chainId));

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
