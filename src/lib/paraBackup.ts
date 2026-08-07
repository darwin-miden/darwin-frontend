"use client";

/**
 * /para private-account backup — the portability layer.
 *
 * A private Para-derived Miden account keeps its vault/notes ONLY in the browser
 * IndexedDB. A fresh origin/device re-derives the same account id (deterministic
 * seed) but with EMPTY state, while the chain holds a non-zero commitment — so
 * every tx fails ("initial commitment 0x000… does not match current 0x…"). This
 * module backs the account file up on-chain (encrypted, via the network-note
 * backup — no server) and restores it at login on a new origin.
 *
 * Key derivation: AES-GCM key = SHA-256(account auth pubkey commitment). The
 * commitment is deterministic for a given Para wallet and re-derivable on any
 * origin, so the same login always decrypts its own backup — WITHOUT a Para
 * signature (Para's MPC ECDSA is non-deterministic, unusable for a stable key).
 * NOTE (security): the commitment is public-key material; a stronger scheme would
 * derive the key from a secret only the MPC key can produce. Acceptable for the
 * testnet demo (the commitment isn't on-chain for a private account); flagged for
 * production. Storage key = the account id's (suffix, prefix), like the self-
 * custody backup, so restore reads the right slot-10 rows.
 */

import { encryptBytes, decryptBytes } from "./storeBackup";
import {
  BACKUP_MAGIC,
  BACKUP_META_INDEX,
  BACKUP_NETWORK_CONTROLLER_HEX,
  gunzip,
  gzip,
  unpackWordsToBytes,
} from "./onchainBackup";
import { compileBackupWriteScript, writeOnchainBackupViaNetwork } from "./clientNote";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;
type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompileNoteScript = (opts: { code: string }) => Promise<any>;

const keyCache = new Map<string, CryptoKey>();

/** Big-endian bytes of a Word's 4 felts (stable, for hashing). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wordToBytes(w: any): Uint8Array {
  const felts = (w.toFelts ? w.toFelts() : w) as unknown[];
  const out = new Uint8Array(felts.length * 8);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  felts.forEach((f: any, i) => {
    let v = BigInt(f.asInt ? f.asInt() : f.toString());
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(v & 0xffn);
      v >>= 8n;
    }
  });
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function feltToBig(f: any): bigint {
  return BigInt(f?.asInt ? f.asInt() : f);
}

/** The account id (suffix, prefix) used as the backup's per-user slot-10 key. */
export async function paraBackupKeyFelts(
  walletId: string,
): Promise<{ suffix: bigint; prefix: bigint }> {
  const sdk = await import("@miden-sdk/miden-sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AccountId } = sdk as any;
  const id = AccountId.fromHex(walletId);
  return { suffix: feltToBig(id.suffix()), prefix: feltToBig(id.prefix()) };
}

/**
 * Derive (+ cache) the AES-GCM backup key from the account's auth pubkey
 * commitment — deterministic per Para wallet, re-derivable on any origin.
 */
export async function deriveParaBackupKey(
  client: AnyClient,
  runExclusive: RunExclusive,
  walletId: string,
): Promise<CryptoKey> {
  const hit = keyCache.get(walletId);
  if (hit) return hit;
  const sdk = await import("@miden-sdk/miden-sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AccountId } = sdk as any;
  const commitment = await runExclusive(async () => {
    const acct = await client.getAccount(AccountId.fromHex(walletId));
    if (!acct?.getPublicKeyCommitments) throw new Error("account has no pubkey commitment");
    const pkcs = acct.getPublicKeyCommitments();
    if (!pkcs?.length) throw new Error("empty pubkey commitments");
    return pkcs[0];
  });
  const material = wordToBytes(commitment);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", material as unknown as BufferSource),
  );
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  keyCache.set(walletId, key);
  return key;
}

/**
 * Read the encrypted backup back from the controller's slot-10 ENTIRELY in the
 * browser (no /api): getMapItem for the meta row + each chunk row. Returns null
 * if there is no backup for this (suffix, prefix). Key word order matches
 * backup_read.rs: [index, MAGIC, prefix, suffix].
 */
export async function readOnchainBackupBrowser(
  client: AnyClient,
  runExclusive: RunExclusive,
  suffix: bigint,
  prefix: bigint,
  controller: string = BACKUP_NETWORK_CONTROLLER_HEX,
): Promise<Uint8Array | null> {
  const sdk = await import("@miden-sdk/miden-sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AccountId, Word } = sdk as any;
  const SLOT = "darwin::slot_10";
  const keyWord = (index: bigint) =>
    new Word(new BigUint64Array([index, BACKUP_MAGIC, prefix, suffix]));
  return runExclusive(async () => {
    try {
      await client.importAccountById(AccountId.fromHex(controller));
    } catch {
      /* already tracked */
    }
    await client.syncState();
    const acct = await client.getAccount(AccountId.fromHex(controller));
    const storage = acct?.storage?.();
    if (!storage?.getMapItem) return null;
    const readFelts = (w: unknown): bigint[] => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const felts = (w as any)?.toFelts ? (w as any).toFelts() : [];
      return felts.map(feltToBig);
    };
    const metaW = await storage.getMapItem(SLOT, keyWord(BACKUP_META_INDEX));
    const meta = readFelts(metaW);
    const byteLen = Number(meta[0] ?? 0n);
    const nWords = Number(meta[1] ?? 0n);
    if (!byteLen || !nWords) return null;
    const words: bigint[][] = [];
    for (let i = 0; i < nWords; i++) {
      const w = await storage.getMapItem(SLOT, keyWord(BigInt(i)));
      words.push(readFelts(w));
    }
    return unpackWordsToBytes(words, byteLen);
  });
}

/** Serialize + gzip + encrypt the account file, then emit the backup network notes. */
export async function autoBackupPara(params: {
  client: AnyClient;
  runExclusive: RunExclusive;
  compileNoteScript: CompileNoteScript;
  walletId: string;
}): Promise<{ ok: boolean; nWords?: number; error?: string }> {
  const { client, runExclusive, compileNoteScript, walletId } = params;
  try {
    const sdk = await import("@miden-sdk/miden-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { AccountId } = sdk as any;
    const key = await deriveParaBackupKey(client, runExclusive, walletId);
    const fileBytes = await runExclusive(async () => {
      const file = await client.exportAccountFile(AccountId.fromHex(walletId));
      return file.serialize() as Uint8Array;
    });
    const enc = await encryptBytes(key, await gzip(fileBytes));
    const backupScript = await runExclusive(() => compileBackupWriteScript(compileNoteScript));
    const { suffix, prefix } = await paraBackupKeyFelts(walletId);
    const nWords = await writeOnchainBackupViaNetwork({
      client,
      runExclusive,
      backupScript,
      signer: walletId,
      controller: BACKUP_NETWORK_CONTROLLER_HEX,
      suffix,
      prefix,
      encryptedBytes: enc,
    });
    return { ok: true, nWords };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Restore the private account on a fresh origin: read the on-chain backup,
 * decrypt, and importAccountFile so the local account matches its on-chain
 * commitment. No-op (returns false) if there is no backup. Idempotent — a
 * re-import of an already-tracked/current account is swallowed.
 */
export async function restorePara(params: {
  client: AnyClient;
  runExclusive: RunExclusive;
  walletId: string;
}): Promise<{ restored: boolean; error?: string }> {
  const { client, runExclusive, walletId } = params;
  try {
    const { suffix, prefix } = await paraBackupKeyFelts(walletId);
    const enc = await readOnchainBackupBrowser(client, runExclusive, suffix, prefix);
    if (!enc) return { restored: false };
    const key = await deriveParaBackupKey(client, runExclusive, walletId);
    const fileBytes = await gunzip(await decryptBytes(key, enc));
    const sdk = await import("@miden-sdk/miden-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { AccountFile } = sdk as any;
    const file = AccountFile.deserialize(fileBytes);
    await runExclusive(async () => {
      try {
        await client.importAccountFile(file);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (!/already (being )?tracked|already exist|current/i.test(m)) throw e;
      }
    });
    await runExclusive(() => client.syncState());
    return { restored: true };
  } catch (e) {
    return { restored: false, error: e instanceof Error ? e.message : String(e) };
  }
}
