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
 * Write the encrypted account backup on-chain: meta entry + one slot-10 write
 * per 28-byte Word. `writeScript` compiles + executes a MASM tx against the
 * controller (provided by the panel, which owns the SDK hooks).
 */
export async function writeOnchainBackup(params: {
  suffix: bigint;
  prefix: bigint;
  encryptedBytes: Uint8Array;
  writeScript: (masmCode: string) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}): Promise<number> {
  const { suffix, prefix, encryptedBytes, writeScript, onProgress } = params;
  const words = packBytesToWords(encryptedBytes);
  const total = words.length + 1;
  // Chunks first, meta LAST — so a partial write is never reported as complete
  // (recovery keys off the meta entry's nWords).
  for (let i = 0; i < words.length; i++) {
    await writeScript(buildSetBackupChunkScript(suffix, prefix, BigInt(i), words[i]));
    onProgress?.(i + 1, total);
  }
  await writeScript(
    buildSetBackupMetaScript(
      suffix,
      prefix,
      BigInt(encryptedBytes.length),
      BigInt(words.length),
    ),
  );
  onProgress?.(total, total);
  return words.length;
}

/** Read the on-chain backup back into encrypted bytes (null if none). */
export async function readOnchainBackup(
  suffix: bigint,
  prefix: bigint,
  controllerId: string,
): Promise<Uint8Array | null> {
  const r = await fetch("/api/backup-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      suffix: suffix.toString(),
      prefix: prefix.toString(),
      controllerId,
    }),
  });
  if (!r.ok) return null;
  const j = (await r.json().catch(() => null)) as
    | { byteLen?: number; words?: string[][] }
    | null;
  if (!j?.byteLen || !j.words?.length) return null;
  const words = j.words.map((w) => w.map((f) => BigInt(f)));
  return unpackWordsToBytes(words, j.byteLen);
}
