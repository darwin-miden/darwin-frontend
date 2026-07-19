"use client";

/**
 * PURELY ON-CHAIN encrypted backup — no server, no IPFS, no Walrus.
 *
 * A derived Miden wallet is a private account: its vault lives only in the
 * browser, so a cleared browser / new device loses the funds. This stores an
 * encrypted copy of the ACCOUNT FILE (exportAccountFile — the vault + nonce,
 * small, NOT the full store) on-chain, in the v8-noauth controller's slot-10
 * StorageMap, under a backup-namespace key derived from the user.
 *
 * No new contract: `set_user_position` is an absolute full-Word (32-byte)
 * setter, so we reuse it to write chunks. The controller is NoAuth, so any tx
 * can write without a signing key. Recovery re-derives the key from MetaMask,
 * reads the chunks back off-chain, decrypts, and `importAccountFile`s.
 *
 * Key layout (mirrors buildSetPositionScript / the /api/position read):
 *   [chunkIndex, BACKUP_MAGIC, user_prefix, user_suffix]
 * BACKUP_MAGIC occupies the "basket_suffix" slot with a value no real faucet
 * id takes, so backup entries never collide with position entries. The count
 * entry lives at chunkIndex = BACKUP_META_INDEX with value [byteLen, nWords,0,0].
 */

import { SET_USER_POSITION_MAST } from "./trustlessController";

// Distinctive constant in the basket_suffix slot — real faucet suffixes are
// AccountId-derived and never take this value. (Fits in a Felt, < Goldilocks p.)
export const BACKUP_MAGIC = 0xda2b1cead0c0ffeen; // "darwin backup"-ish sentinel
// chunkIndex reserved for the meta/count entry (way above any real chunk count).
export const BACKUP_META_INDEX = 0xffffffffn;

// 7 bytes per felt (< 2^56, safely below Goldilocks p = 2^64-2^32+1); 4 felts
// per Word ⇒ 28 bytes per on-chain entry.
const BYTES_PER_FELT = 7;
const FELTS_PER_WORD = 4;
export const BYTES_PER_WORD = BYTES_PER_FELT * FELTS_PER_WORD; // 28

// ── gzip (fewer chunks = fewer write txs AND fewer read execs) ──
async function streamThrough(
  data: Uint8Array,
  s: "CompressionStream" | "DecompressionStream",
): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (globalThis as any)[s];
  const stream = new Ctor("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(data);
  void writer.close();
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export const gzip = (data: Uint8Array) => streamThrough(data, "CompressionStream");
export const gunzip = (data: Uint8Array) => streamThrough(data, "DecompressionStream");

/** Pack bytes into Words (each a 4-tuple of Felt bigints). */
export function packBytesToWords(bytes: Uint8Array): bigint[][] {
  const words: bigint[][] = [];
  for (let i = 0; i < bytes.length; i += BYTES_PER_WORD) {
    const word: bigint[] = [0n, 0n, 0n, 0n];
    for (let f = 0; f < FELTS_PER_WORD; f++) {
      let felt = 0n;
      for (let b = 0; b < BYTES_PER_FELT; b++) {
        const idx = i + f * BYTES_PER_FELT + b;
        if (idx < bytes.length) felt |= BigInt(bytes[idx]) << BigInt(8 * b);
      }
      word[f] = felt;
    }
    words.push(word);
  }
  return words;
}

/** Inverse of packBytesToWords, truncated to the original byte length. */
export function unpackWordsToBytes(words: bigint[][], byteLen: number): Uint8Array {
  const out = new Uint8Array(byteLen);
  let p = 0;
  for (const word of words) {
    for (let f = 0; f < FELTS_PER_WORD; f++) {
      let felt = word[f] ?? 0n;
      for (let b = 0; b < BYTES_PER_FELT; b++) {
        if (p < byteLen) out[p++] = Number(felt & 0xffn);
        felt >>= 8n;
      }
    }
  }
  return out;
}

/**
 * MASM tx script that writes one Word to slot-10 under the backup key
 * [chunkIndex, BACKUP_MAGIC, user_prefix, user_suffix]. Mirrors
 * buildSetPositionScript's push order exactly, but with the full 4-felt value.
 */
export function buildSetBackupChunkScript(
  suffix: bigint,
  prefix: bigint,
  chunkIndex: bigint,
  value: bigint[], // [f0,f1,f2,f3]
): string {
  const [f0, f1, f2, f3] = [value[0] ?? 0n, value[1] ?? 0n, value[2] ?? 0n, value[3] ?? 0n];
  // Push VALUE in REVERSE (f3 first) so f0 lands on TOP of the value word ⇒
  // the stored map word is [f0,f1,f2,f3], matching packBytesToWords and the
  // /api/backup-read parse. (Verified on-chain: pushing f0-first stored it
  // reversed as [f3,f2,f1,f0], breaking the round-trip.)
  return `use miden::core::sys

begin
    # VALUE word: pushed f3,f2,f1,f0 so the word reads [f0,f1,f2,f3]
    push.${f3} push.${f2} push.${f1} push.${f0}

    # KEY word on top: [chunk_index, BACKUP_MAGIC, user_prefix, user_suffix]
    push.${suffix} push.${prefix}
    push.${BACKUP_MAGIC} push.${chunkIndex}

    call.${SET_USER_POSITION_MAST}

    exec.sys::truncate_stack
end
`;
}

/**
 * Batch write: N set_user_position calls in ONE tx (one proof), each writing a
 * chunk Word. `dropw` after each call discards the returned old value so the
 * stack stays shallow. A 4.5 KB account file is ~161 chunks — batching ~16 per
 * tx cuts it from ~161 proofs to ~10.
 */
export function buildSetBackupBatchScript(
  suffix: bigint,
  prefix: bigint,
  entries: { index: bigint; value: bigint[] }[],
): string {
  const body = entries
    .map(({ index, value }) => {
      const [f0, f1, f2, f3] = [
        value[0] ?? 0n,
        value[1] ?? 0n,
        value[2] ?? 0n,
        value[3] ?? 0n,
      ];
      return `    push.${f3} push.${f2} push.${f1} push.${f0}\n    push.${suffix} push.${prefix} push.${BACKUP_MAGIC} push.${index}\n    call.${SET_USER_POSITION_MAST}\n    dropw`;
    })
    .join("\n");
  return `use miden::core::sys\n\nbegin\n${body}\n    exec.sys::truncate_stack\nend\n`;
}

/** Number of chunk writes (set_map_item calls) per tx. Each is a cheap storage-map
 * set; the ceiling is per-tx MASM cycles, which 128 stays far under. Bigger ⇒ fewer
 * txs ⇒ fewer proofs — a ~3.6 KB payload is ~135 words ⇒ ~2 chunk txs + meta. */
export const BACKUP_CHUNKS_PER_TX = 128;

/** Meta entry: value = [byteLen, nWords, 0, 0] at chunkIndex = BACKUP_META_INDEX. */
export function buildSetBackupMetaScript(
  suffix: bigint,
  prefix: bigint,
  byteLen: bigint,
  nWords: bigint,
): string {
  return buildSetBackupChunkScript(suffix, prefix, BACKUP_META_INDEX, [
    byteLen,
    nWords,
    0n,
    0n,
  ]);
}

/**
 * Write the encrypted account backup on-chain: one slot-10 write per 28-byte
 * Word (batched BACKUP_CHUNKS_PER_TX per tx), plus a meta entry. Each tx is
 * submitted individually via `submitOne` — the panel routes it through the SDK's
 * WORKER-forwarded submit path (submitNewTransaction[WithProver]), which
 * execute→prove→submit→APPLIES each tx off the main thread, so proving never
 * freezes the UI and sequential writes chain correctly (each applies locally
 * before the next executes). NOTE: submitNewTransactionBatch is deliberately NOT
 * used — it is not worker-forwarded and proves on the main thread (Page
 * Unresponsive). A per-tx executeTx loop is also wrong (force-syncs around
 * uncommitted txs → mempool/commitment conflict).
 *
 * Ordering: chunk txs first, meta LAST — a partial write is never seen as
 * complete (recovery keys off meta's nWords), and an idempotent re-backup
 * (unchanged size ⇒ meta tx is a no-op) affects only that isolated final tx.
 */
export async function writeOnchainBackup(params: {
  suffix: bigint;
  prefix: bigint;
  encryptedBytes: Uint8Array;
  submitOne: (masmCode: string) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}): Promise<number> {
  const { suffix, prefix, encryptedBytes, submitOne, onProgress } = params;
  const words = packBytesToWords(encryptedBytes);

  // One tx script per BACKUP_CHUNKS_PER_TX group of words.
  const chunkScripts: string[] = [];
  for (let start = 0; start < words.length; start += BACKUP_CHUNKS_PER_TX) {
    const entries: { index: bigint; value: bigint[] }[] = [];
    for (let i = start; i < Math.min(start + BACKUP_CHUNKS_PER_TX, words.length); i++) {
      entries.push({ index: BigInt(i), value: words[i] });
    }
    chunkScripts.push(buildSetBackupBatchScript(suffix, prefix, entries));
  }

  const totalTxs = chunkScripts.length + 1; // + meta
  let done = 0;
  for (const code of chunkScripts) {
    await submitOne(code); // one worker-routed proof per tx
    onProgress?.(++done, totalTxs);
  }
  await submitOne(
    buildSetBackupMetaScript(
      suffix,
      prefix,
      BigInt(encryptedBytes.length),
      BigInt(words.length),
    ),
  );
  onProgress?.(totalTxs, totalTxs);
  return words.length;
}

/** Base64-encode bytes (browser-safe for small payloads like the ~4 KB backup). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Mac-relay write: the browser encrypts locally and sends ONLY the ciphertext;
 * the native miden-client writes it into the controller's slot-10 map (fast
 * proving, no browser freeze, and it sidesteps the browser worker's inability to
 * apply txs to the public controller). Confidentiality holds — the server sees
 * only opaque ciphertext + public ids. Returns { ok, nWords } or { ok:false, error }.
 */
export async function writeOnchainBackupViaMac(params: {
  suffix: bigint;
  prefix: bigint;
  controllerId: string;
  encryptedBytes: Uint8Array;
  // Ownership proof: the EVM address that owns this slot + its EIP-712 auth
  // signature (see backupAuth.ts). The route recovers the signer and rejects
  // the write unless it maps to (suffix, prefix) — so a caller can only
  // overwrite their OWN backup.
  evmAddress: `0x${string}`;
  authSig: string;
}): Promise<{ ok: boolean; nWords?: number; error?: string }> {
  const { suffix, prefix, controllerId, encryptedBytes, evmAddress, authSig } = params;
  try {
    const r = await fetch("/api/backup-write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suffix: suffix.toString(),
        prefix: prefix.toString(),
        controllerId,
        ciphertextB64: bytesToBase64(encryptedBytes),
        evmAddress,
        authSig,
      }),
    });
    const j = (await r.json().catch(() => null)) as
      | { ok?: boolean; nWords?: number; error?: string }
      | null;
    if (!r.ok || !j?.ok)
      return { ok: false, error: j?.error || `write failed (${r.status})` };
    return { ok: true, nWords: j.nWords };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 160) };
  }
}

/**
 * Warm the backend store (fire-and-forget): triggers a sync now so a follow-up
 * readOnchainBackup skips its own ~400ms network sync. Call at the start of a
 * restore, before the (multi-second) signature prompt, so the sync overlaps the
 * user signing. Never throws — a cold read still works, just slower.
 */
export async function warmOnchainBackup(
  suffix: bigint,
  prefix: bigint,
  controllerId: string,
): Promise<void> {
  try {
    await fetch("/api/backup-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suffix: suffix.toString(),
        prefix: prefix.toString(),
        controllerId,
        warm: true,
      }),
    });
  } catch {
    /* best-effort */
  }
}

/** Read the on-chain backup back into encrypted bytes (null if none). */
export async function readOnchainBackup(
  suffix: bigint,
  prefix: bigint,
  controllerId: string,
): Promise<Uint8Array | null> {
  // Catch network errors (API briefly unreachable) → null, so callers treat it
  // as "not found yet" and retry rather than throwing (a verification poll or a
  // restore must survive a transient blip, not fail the whole operation).
  const r = await fetch("/api/backup-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      suffix: suffix.toString(),
      prefix: prefix.toString(),
      controllerId,
    }),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = (await r.json().catch(() => null)) as
    | { byteLen?: number; words?: string[][] }
    | null;
  if (!j?.byteLen || !j.words?.length) return null;
  const words = j.words.map((w) => w.map((f) => BigInt(f)));
  return unpackWordsToBytes(words, j.byteLen);
}
