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
 * set; the ceiling is per-tx MASM cycles, which 48 stays far under. Bigger ⇒ fewer
 * txs ⇒ fewer WASM proofs (a ~4.5 KB backup → ~3 chunk txs + meta). */
export const BACKUP_CHUNKS_PER_TX = 48;

/** Max txs handed to one submitNewTransactionBatch call. Kept small (2) to bound
 * peak WASM-prover memory per batch — a large single batch OOMs low-RAM browsers.
 * Sequential batch calls still chain (each applies its txs locally before returning). */
export const MAX_TXS_PER_SUBMIT = 2;

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
 * Word, plus a meta entry. Txs are submitted via `submitBatch` — the SDK's
 * submitNewTransactionBatch primitive (execute→prove→submit→APPLY each tx
 * atomically with NO per-tx sync), which is how N sequential dependent txs to
 * one account chain correctly in the browser (the Rust reference does the same
 * with apply_transaction). A per-tx executeTx loop instead force-syncs around a
 * growing stack of uncommitted txs and risks an account-lock / commitment
 * mismatch, so it is NOT used here.
 *
 * Ordering: chunk batches first, then the meta tx as its OWN final batch — so a
 * partial write is never seen as complete (recovery keys off meta's nWords), and
 * an idempotent re-backup (unchanged size ⇒ meta tx is a no-op) fails only that
 * isolated meta batch, which the caller can treat as already-current.
 */
export async function writeOnchainBackup(params: {
  suffix: bigint;
  prefix: bigint;
  encryptedBytes: Uint8Array;
  submitBatch: (masmCodes: string[]) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}): Promise<number> {
  const { suffix, prefix, encryptedBytes, submitBatch, onProgress } = params;
  const words = packBytesToWords(encryptedBytes);

  // One script per BACKUP_CHUNKS_PER_TX group of words.
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
  // Chunk txs, grouped into batches of at most MAX_TXS_PER_SUBMIT. Sequential
  // batch calls still chain cleanly (each applies its txs locally before
  // returning), so no sync between them.
  for (let i = 0; i < chunkScripts.length; i += MAX_TXS_PER_SUBMIT) {
    const group = chunkScripts.slice(i, i + MAX_TXS_PER_SUBMIT);
    await submitBatch(group);
    done += group.length;
    onProgress?.(done, totalTxs);
  }
  // Meta LAST, in its own batch.
  await submitBatch([
    buildSetBackupMetaScript(
      suffix,
      prefix,
      BigInt(encryptedBytes.length),
      BigInt(words.length),
    ),
  ]);
  onProgress?.(totalTxs, totalTxs);
  return words.length;
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
