/**
 * Encrypted store backup — recovery for the confidential self-custody wallet.
 *
 * A derived Miden wallet is a PRIVATE account: its state (the DCC vault) lives
 * only in the browser's IndexedDB, never on-chain. Clearing the browser or
 * switching device would therefore lose access to the funds. This module backs
 * the store up, encrypted with a key derived from a MetaMask signature, so it
 * can be restored on any device by re-signing.
 *
 * Trust model: the encryption key is deterministic from the user's MetaMask
 * signature, so the ciphertext is safe to store ANYWHERE (even fully public) —
 * only the MetaMask holder can decrypt it. Security reduces entirely to the
 * MetaMask key, exactly like the wallet itself. The backup endpoint stores
 * ciphertext only; it never sees the key, the plaintext store, or the balance.
 */

import { keccak256 } from "viem";

// The active client's store is named "default" (SDK: `storeName || "default"`).
const RESTORE_STORE_NAME = "default";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignTypedData = (td: any) => Promise<`0x${string}`>;

// This project's tsconfig pulls in SharedArrayBuffer (for the WASM prover), so
// Uint8Array is typed as Uint8Array<ArrayBufferLike> and WebCrypto's
// BufferSource params reject it. The runtime values are always plain
// ArrayBuffer-backed — cast at the WebCrypto boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// One AES key per EVM address per session (derived once, cached in memory).
const keyCache = new Map<string, CryptoKey>();

/**
 * EIP-712 for the backup key. Distinct domain from the wallet derivation, so
 * this encryption key is independent of the Falcon signing key. No chainId, so
 * it's stable across networks (like the wallet derivation).
 */
function backupTypedData(evmAddress: `0x${string}`) {
  return {
    domain: { name: "Darwin Encrypted Backup", version: "1" },
    types: {
      DarwinBackupKey: [
        { name: "purpose", type: "string" },
        { name: "account", type: "address" },
        { name: "version", type: "uint256" },
      ],
    },
    primaryType: "DarwinBackupKey" as const,
    message: {
      purpose: "Encrypt & restore your confidential Miden wallet backup",
      account: evmAddress,
      version: 1n,
    },
  };
}

/** Derive (and cache) the AES-GCM backup key from a MetaMask signature. */
export async function deriveBackupKey(
  signTypedData: SignTypedData,
  evmAddress: `0x${string}`,
): Promise<CryptoKey> {
  const cacheId = evmAddress.toLowerCase();
  const hit = keyCache.get(cacheId);
  if (hit) return hit;
  const sig = await signTypedData(backupTypedData(evmAddress));
  // keccak the signature bytes → 32-byte AES key material. MetaMask EIP-712
  // signatures are deterministic (RFC-6979), so the same address always yields
  // the same key → the same backup is always decryptable.
  const keyBytes = keccak256(sig, "bytes");
  const key = await crypto.subtle.importKey(
    "raw",
    bs(keyBytes),
    "AES-GCM",
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
  keyBytes.fill(0);
  keyCache.set(cacheId, key);
  return key;
}

/** True if the backup key for this address is already derived this session. */
export function hasBackupKey(evmAddress: `0x${string}`): boolean {
  return keyCache.has(evmAddress.toLowerCase());
}

// ── base64 helpers (chunked — the store dump can be large) ──
function u8ToB64(u8: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode(...u8.subarray(i, i + CH));
  }
  return btoa(s);
}
function b64ToU8(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

async function encryptBlob(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bs(iv) },
      key,
      bs(new TextEncoder().encode(plaintext)),
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv);
  packed.set(ct, iv.length);
  return u8ToB64(packed);
}

async function decryptBlob(key: CryptoKey, b64: string): Promise<string> {
  const packed = b64ToU8(b64);
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(ct));
  return new TextDecoder().decode(pt);
}

async function pushBackup(walletId: string, ciphertext: string): Promise<void> {
  const r = await fetch("/api/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: walletId, ciphertext }),
  });
  if (!r.ok) throw new Error(`backup upload failed (${r.status})`);
}

async function pullBackup(walletId: string): Promise<string | null> {
  const r = await fetch(`/api/backup?key=${encodeURIComponent(walletId)}`);
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as { ciphertext?: string } | null;
  return j?.ciphertext ?? null;
}

/** Export → encrypt → upload. Best-effort; throws only on hard failure. */
export async function backupStore(
  exportStore: () => Promise<string>,
  key: CryptoKey,
  walletId: string,
): Promise<void> {
  const dump = await exportStore();
  const ct = await encryptBlob(key, dump);
  await pushBackup(walletId, ct);
}

/** Download → decrypt → import. Returns false if no backup exists. */
export async function restoreStore(
  importStore: (dump: string, storeName: string, opts?: { skipSync?: boolean }) => Promise<void>,
  key: CryptoKey,
  walletId: string,
): Promise<boolean> {
  const ct = await pullBackup(walletId);
  if (!ct) return false;
  const dump = await decryptBlob(key, ct);
  await importStore(dump, RESTORE_STORE_NAME, { skipSync: false });
  return true;
}
