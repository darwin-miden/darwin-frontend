"use client";

/**
 * /para private-account backup — the portability layer.
 *
 * A private Para-derived Miden account keeps its vault/notes ONLY in the browser
 * IndexedDB. A fresh origin/device re-derives the same account id (deterministic
 * seed) but with EMPTY state, while the chain holds a non-zero commitment — so
 * every tx fails ("initial commitment 0x000… does not match current 0x…"). This
 * module backs the account file up on-chain (encrypted) into a NoAuth controller's
 * slot-10 — writing via txs FROM THE CONTROLLER so the Para account never emits and
 * its nonce stays consistent with the backed-up state — and restores it at login on
 * a new origin. 100% client-side (no server, no relay).
 *
 * Key derivation: AES-GCM key = SHA-256(account auth pubkey commitment). The
 * commitment is deterministic for a given Para wallet and re-derivable on any
 * origin, so the same login always decrypts its own backup — WITHOUT a Para
 * signature (Para's MPC ECDSA is non-deterministic, unusable for a stable key).
 * Storage key = the account id's (suffix, prefix), so restore reads the right rows.
 *
 * ┌─ SECURITY — DEFERRED (architectural, tracked; not fixable client-side alone) ───────┐
 * │ 1. CONFIDENTIALITY: the AES key is a deterministic function of PUBLIC key material  │
 * │    (the pubkey commitment) and the ciphertext lives in a WORLD-READABLE controller  │
 * │    slot keyed by the public account id. Anyone with the account id + pubkey can      │
 * │    decrypt the vault/positions (they still can't SPEND — Para signs). Real fix:      │
 * │    derive the key from a secret only the MPC key can produce (deterministic sig /    │
 * │    sealed data-key). Blocked today by Para's non-deterministic ECDSA.                │
 * │ 2. INTEGRITY: writes go to a NoAuth controller with NO ownership check, so anyone    │
 * │    can overwrite/corrupt a victim's slot (key = victim's public id) and brick        │
 * │    recovery. Real fix: authenticate the on-chain write (as writeOnchainBackupViaMac  │
 * │    does with EIP-712) or bind the slot to an MPC-only signature. Needs a controller  │
 * │    redeploy. Mitigation in place: restore VERIFIES decrypt + a version guard, so a   │
 * │    corrupt/older backup is rejected rather than silently clobbering local state.     │
 * │ Both couple to the pending Target A (relayer) vs B (pseudonymity) product decision.  │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 */

import { encryptBytes, decryptBytes } from "./storeBackup";
import {
  BACKUP_MAGIC,
  BACKUP_META_INDEX,
  gunzip,
  gzip,
  unpackWordsToBytes,
  writeOnchainBackup,
} from "./onchainBackup";
import { TRUSTLESS_CONTROLLER_HEX } from "./trustlessController";
import { ensureSignerAccountLoaded } from "./ensureAccount";

// The backup lives in the NoAuth controller's slot-10. Writing goes to the
// controller (its own tx advances the CONTROLLER's nonce, NOT the Para account's)
// so a restored Para account still matches its on-chain commitment. Same controller
// for read + write. v8-noauth = the browser can build+submit its txs (no key).
const BACKUP_CONTROLLER_HEX = TRUSTLESS_CONTROLLER_HEX;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;
type RunExclusive = <T>(fn: () => Promise<T> | T) => Promise<T>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompileTxScript = (opts: { code: string }) => Promise<any>;
// The worker-routed submit hook (useTransaction().execute): syncs (unless skipSync) →
// build → prove → submit → APPLIES, and — unlike the raw client.submitNewTransaction —
// materialises a public/foreign account's data so apply_transaction can write it back.
// Self-locks internally, so it MUST be called OUTSIDE runExclusive.
type ExecuteTx = (opts: {
  accountId: string;
  skipSync?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) => Promise<any>;

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
 * browser (no /api): getMapItem for the meta row + each chunk row. Key word order
 * matches backup_read.rs: [index, MAGIC, prefix, suffix].
 *
 * Returns { bytes } where bytes is null ONLY when the backup is genuinely absent
 * (controller materialised, meta row empty). A LOADER/read failure returns { error }
 * instead, so callers never mistake a transient RPC blip for "no backup" and let an
 * empty account overwrite a good on-chain backup.
 */
export async function readOnchainBackupBrowser(
  client: AnyClient,
  runExclusive: RunExclusive,
  suffix: bigint,
  prefix: bigint,
  controller: string = BACKUP_CONTROLLER_HEX,
): Promise<{ bytes: Uint8Array | null; error?: string }> {
  const sdk = await import("@miden-sdk/miden-sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AccountId, Word } = sdk as any;
  const SLOT = "darwin::slot_10";
  const keyWord = (index: bigint) =>
    new Word(new BigUint64Array([index, BACKUP_MAGIC, prefix, suffix]));
  // Materialise the controller before reading its storage — same robust loader as the
  // write path (retries sync→import→sync on a fresh store). Call it OUTSIDE runExclusive
  // (it self-locks; nesting would deadlock). If it can't load, this is a READ ERROR, not
  // an absent backup — surface it so restore doesn't silently proceed on an empty account.
  const loaded = await ensureSignerAccountLoaded(client, runExclusive, controller);
  if (!loaded) return { bytes: null, error: "backup controller not reachable (RPC/sync)" };
  try {
    return await runExclusive(async () => {
      const acct = await client.getAccount(AccountId.fromHex(controller));
      const storage = acct?.storage?.();
      if (!storage?.getMapItem) {
        return { bytes: null, error: "controller storage not materialised" };
      }
      const readFelts = (w: unknown): bigint[] => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const felts = (w as any)?.toFelts ? (w as any).toFelts() : [];
        return felts.map(feltToBig);
      };
      const metaW = await storage.getMapItem(SLOT, keyWord(BACKUP_META_INDEX));
      const meta = readFelts(metaW);
      const byteLen = Number(meta[0] ?? 0n);
      const nWords = Number(meta[1] ?? 0n);
      if (!byteLen || !nWords) return { bytes: null }; // genuinely no backup
      const words: bigint[][] = [];
      for (let i = 0; i < nWords; i++) {
        const w = await storage.getMapItem(SLOT, keyWord(BigInt(i)));
        words.push(readFelts(w));
      }
      return { bytes: unpackWordsToBytes(words, byteLen) };
    });
  } catch (e) {
    return { bytes: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Serialize + gzip + encrypt the account file, then write it into the NoAuth
 * controller's slot-10 — via txs FROM THE CONTROLLER (set_user_position batches),
 * so the CONTROLLER's nonce advances, NOT the Para account's. That is what makes a
 * restored account still match its on-chain commitment (a note emitted from the Para
 * account would bump ITS nonce and strand the restore). Requires the browser to be
 * able to build+submit a tx for the imported NoAuth controller — the exact thing
 * that was broken in the 2026-07 SDK; re-tested here on 0.15.9.
 */
// Max set_user_position calls per tx on the BROWSER local prover (wasm32). The native
// prover handles BACKUP_CHUNKS_PER_TX (128), but the local prover's trace overflows
// far below that: 96 calls in one tx panics ("capacity overflow") while 49 proves fine
// (verified live via the debug hook). 48 keeps a margin under that ceiling, so a ~95-
// word account backs up in 2 chunk txs + 1 meta tx — a chain length already proven to
// hold. Tunable via the debug hook's second arg.
const BROWSER_CHUNKS_PER_TX = 48;

/**
 * Core write: push already-encrypted bytes into the controller's slot-10. Shared by
 * autoBackupPara (real account file) and the debug round-trip (dummy payload).
 *
 * Each batch is one tx FROM the controller via executeTx (compile the tx script UNDER
 * runExclusive — the compiler doesn't self-lock — then executeTx OUTSIDE it, since
 * executeTx self-locks and nesting would deadlock). executeTx is used rather than
 * client.submitNewTransaction because the latter can't apply a tx to a public account
 * it doesn't fully track. skipSync:true — the controller is already materialised by
 * ensureSignerAccountLoaded below. Chains of a few txs have proven stable against the
 * background poll; the batch size keeps typical accounts to ≤3 txs.
 */
async function writeParaBackupBytes(params: {
  client: AnyClient;
  runExclusive: RunExclusive;
  compileTxScript: CompileTxScript;
  executeTx: ExecuteTx;
  suffix: bigint;
  prefix: bigint;
  encryptedBytes: Uint8Array;
  chunksPerTx?: number;
}): Promise<number> {
  const { client, runExclusive, compileTxScript, executeTx, suffix, prefix, encryptedBytes } =
    params;
  const chunksPerTx = params.chunksPerTx ?? BROWSER_CHUNKS_PER_TX;
  const sdk = await import("@miden-sdk/miden-sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { TransactionRequestBuilder } = sdk as any;
  // Materialise the NoAuth controller into the local store so the browser can build +
  // APPLY its txs. ensureSignerAccountLoaded is the proven public-account loader (the
  // same one the buy flow uses for faucets/Pragma): it returns immediately if the
  // controller is already tracked (a returning origin whose local nonce is ahead of
  // chain — so it never re-imports and hits "local state is newer"), and on a FRESH
  // store it retries sync→import→sync until the FULL account data is present. A single
  // import+sync is NOT enough on a fresh store — the tx then fails "account data wasn't
  // found for <controller>" at apply time.
  const loaded = await ensureSignerAccountLoaded(client, runExclusive, BACKUP_CONTROLLER_HEX);
  if (!loaded) {
    throw new Error("controller not materialised locally after import+sync retries");
  }
  // Each batch = a tx FROM the controller (set_user_position) — the Para account never
  // emits, so ITS nonce is untouched and the restore matches on-chain. Submit via
  // executeTx (NOT client.submitNewTransaction, which can't apply to a public account).
  // Lock: compile UNDER runExclusive (compiler doesn't self-lock); executeTx OUTSIDE it
  // (executeTx self-locks — nesting deadlocks). skipSync:true — already synced above.
  const submitOne = async (masmCode: string) => {
    const script = await runExclusive(() => compileTxScript({ code: masmCode }));
    const res = await executeTx({
      accountId: BACKUP_CONTROLLER_HEX,
      skipSync: true,
      request: () => new TransactionRequestBuilder().withCustomScript(script).build(),
    });
    if (!res) throw new Error("executeTx returned null for the controller write");
  };
  return writeOnchainBackup({ suffix, prefix, encryptedBytes, submitOne, chunksPerTx });
}

export async function autoBackupPara(params: {
  client: AnyClient;
  runExclusive: RunExclusive;
  compileTxScript: CompileTxScript;
  executeTx: ExecuteTx;
  walletId: string;
  chunksPerTx?: number;
}): Promise<{ ok: boolean; nWords?: number; encBytes?: number; error?: string }> {
  const { client, runExclusive, compileTxScript, executeTx, walletId, chunksPerTx } = params;
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
    const { suffix, prefix } = await paraBackupKeyFelts(walletId);
    const nWords = await writeParaBackupBytes({
      client,
      runExclusive,
      compileTxScript,
      executeTx,
      suffix,
      prefix,
      encryptedBytes: enc,
      chunksPerTx,
    });
    return { ok: true, nWords, encBytes: enc.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Restore the private account from the on-chain backup, decrypt, and OVERWRITE the
 * local (empty or older) account with newAccount(account, overwrite=true).
 *
 * Result semantics (each is distinct so the caller reacts correctly):
 *  - { restored: true }                          → local now matches the backup.
 *  - { restored: false }                         → no backup exists yet (fresh user).
 *  - { restored: false, error }                  → a READ/restore FAILURE (RPC blip,
 *      decrypt, or the overwrite didn't take). NEVER treat this as "no backup" — the
 *      caller must NOT let an empty account proceed/trade, and must retry.
 *  - { restored: false, skipped }                → deliberately not restored because the
 *      LOCAL account is already at or ahead of the backup (never clobber newer state).
 */
export async function restorePara(params: {
  client: AnyClient;
  runExclusive: RunExclusive;
  walletId: string;
}): Promise<{ restored: boolean; error?: string; skipped?: string }> {
  const { client, runExclusive, walletId } = params;
  try {
    const { suffix, prefix } = await paraBackupKeyFelts(walletId);
    const read = await readOnchainBackupBrowser(client, runExclusive, suffix, prefix);
    if (read.error) return { restored: false, error: read.error }; // NOT "no backup"
    if (!read.bytes) return { restored: false }; // genuinely no backup
    const key = await deriveParaBackupKey(client, runExclusive, walletId);
    const fileBytes = await gunzip(await decryptBytes(key, read.bytes));
    const sdk = await import("@miden-sdk/miden-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { AccountFile, AccountId } = sdk as any;
    const file = AccountFile.deserialize(fileBytes);
    const account = file.account();
    const nonceOf = (a: unknown): bigint => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return feltToBig((a as any).nonce());
      } catch {
        return 0n;
      }
    };
    const backupNonce = nonceOf(account);

    // VERSION GUARD: never overwrite a locally-NEWER account. If the user traded on this
    // origin since the last backup (local nonce > backup nonce), overwriting would
    // DESTROY the newer vault and brick the account. Skip and let the caller surface it.
    const localBefore = await runExclusive(() =>
      client.getAccount(AccountId.fromHex(walletId)).catch(() => null),
    );
    const localNonce = localBefore ? nonceOf(localBefore) : 0n;
    if (localNonce > backupNonce) {
      return {
        restored: false,
        skipped: `local account is newer than backup (local nonce ${localNonce} > backup ${backupNonce}) — not overwriting`,
      };
    }
    if (localNonce === backupNonce && localNonce > 0n) {
      return { restored: false, skipped: "local already at backup state" }; // no-op
    }

    // Local is empty (fresh origin) or strictly older → safe to overwrite.
    await runExclusive(() => client.newAccount(account, true));

    // VERIFY the overwrite actually took. Do NOT trust a swallowed error: the SDK's
    // commitment-mismatch message literally contains "current", so a regex that ignores
    // /current/i would report false success with the vault still at 0.
    const localAfter = await runExclusive(() =>
      client.getAccount(AccountId.fromHex(walletId)).catch(() => null),
    );
    if (!localAfter || nonceOf(localAfter) !== backupNonce) {
      return { restored: false, error: "restore overwrite did not take (nonce mismatch after newAccount)" };
    }
    await runExclusive(() => client.syncState()).catch(() => {});
    return { restored: true };
  } catch (e) {
    return { restored: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One-shot self-test for the fully-client-side backup, callable from the console
 * after login (no trade needed). Proves the two things the nonce-wall analysis said
 * were the open questions: (1) the browser can WRITE the backup to the NoAuth
 * controller (the exact op that once forced the Mac relay), and (2) it reads back +
 * decrypts + deserializes into a valid account file. Records the Para account nonce
 * before/after so we can confirm the write left it UNTOUCHED (the whole point — a
 * moved nonce would strand the restore).
 *
 * Returns a plain verdict object (logged to the console by the caller). Does NOT
 * import the read-back file (that's restorePara's job on a fresh origin) — here we
 * only need to prove the round-trip is valid.
 */
export async function verifyParaBackupRoundtrip(
  params: {
    client: AnyClient;
    runExclusive: RunExclusive;
    compileTxScript: CompileTxScript;
    executeTx: ExecuteTx;
    walletId: string;
  },
  opts?: { dummyChunks?: number; chunksPerTx?: number },
): Promise<{
  ok: boolean;
  phase?: string;
  mode?: string;
  realFileBytes?: number;
  realEncBytes?: number;
  realWords?: number;
  wroteBytes?: number;
  wroteWords?: number;
  chunksPerTx?: number;
  readBytes?: number;
  bytesMatch?: boolean;
  deserializeOk?: boolean;
  nonceBefore?: string;
  nonceAfter?: string;
  nonceUnchanged?: boolean;
  error?: string;
}> {
  const { client, runExclusive, compileTxScript, executeTx, walletId } = params;
  const dummyChunks = opts?.dummyChunks;
  const chunksPerTx = opts?.chunksPerTx;
  try {
    const sdk = await import("@miden-sdk/miden-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { AccountId, AccountFile } = sdk as any;
    const readNonce = async (): Promise<string> =>
      runExclusive(async () => {
        try {
          const acc = await client.getAccount(AccountId.fromHex(walletId));
          const n = acc?.nonce?.();
          return n?.asInt ? String(n.asInt()) : String(n ?? "?");
        } catch {
          return "?";
        }
      });

    // Always measure the REAL account file so we know how many chunks a real backup
    // needs — even when this run writes a small dummy payload to probe the prover.
    const key = await deriveParaBackupKey(client, runExclusive, walletId);
    const realFileBytes = await runExclusive(async () => {
      const file = await client.exportAccountFile(AccountId.fromHex(walletId));
      return file.serialize() as Uint8Array;
    });
    const realEnc = await encryptBytes(key, await gzip(realFileBytes));
    const realWords = Math.ceil(realEnc.length / 28);
    const sizes = {
      realFileBytes: realFileBytes.length,
      realEncBytes: realEnc.length,
      realWords,
    };
    console.log("[para-backup-test] sizes", sizes, {
      dummyChunks: dummyChunks ?? null,
      chunksPerTx: chunksPerTx ?? "default",
    });

    // Payload for THIS run: a dummy random blob of N words to probe the prover ceiling,
    // or the real encrypted file. Byte-compare on read-back proves the round-trip; the
    // real file additionally decrypts + deserializes into a valid AccountFile.
    const payload =
      dummyChunks && dummyChunks > 0
        ? crypto.getRandomValues(new Uint8Array(dummyChunks * 28))
        : realEnc;
    const mode = dummyChunks ? `dummy-${dummyChunks}w` : "real-file";

    const nonceBefore = await readNonce();

    // (1) WRITE — the browser-direct controller write.
    // SAFETY: a dummy/probe run writes to a SEPARATE throwaway slot key, NEVER the real
    // (suffix, prefix). Otherwise the probe would overwrite the user's only recovery copy
    // with random bytes and brick the account. We flip only LOW bits of the suffix
    // (0x7e57 = "TEST"), which lands in a distinct slot while staying a valid field
    // element (a full 64-bit XOR could exceed the Miden field modulus and be invalid).
    const real = await paraBackupKeyFelts(walletId);
    const suffix = dummyChunks ? real.suffix ^ 0x7e57n : real.suffix;
    const prefix = real.prefix;
    let wroteWords: number;
    try {
      wroteWords = await writeParaBackupBytes({
        client,
        runExclusive,
        compileTxScript,
        executeTx,
        suffix,
        prefix,
        encryptedBytes: payload,
        chunksPerTx,
      });
    } catch (e) {
      return {
        ok: false,
        phase: "write",
        mode,
        ...sizes,
        wroteBytes: payload.length,
        chunksPerTx,
        nonceBefore,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const nonceAfter = await readNonce();
    const nonceUnchanged = nonceBefore === nonceAfter;

    // (2) READ-BACK — poll a few block-times for the write to commit, then read it.
    let enc: Uint8Array | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await readOnchainBackupBrowser(client, runExclusive, suffix, prefix);
      enc = r.bytes;
      if (enc && enc.length > 0) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!enc) {
      return {
        ok: false,
        phase: "read-back",
        mode,
        ...sizes,
        wroteBytes: payload.length,
        wroteWords,
        chunksPerTx,
        nonceBefore,
        nonceAfter,
        nonceUnchanged,
        error: "write submitted but nothing read back after ~36s (not committed?)",
      };
    }

    const bytesMatch = enc.length === payload.length && enc.every((b, i) => b === payload[i]);

    // (3) DECRYPT + DESERIALIZE (real payload only) — prove it yields a valid file.
    let deserializeOk: boolean | undefined;
    if (!dummyChunks) {
      try {
        const fileBytes = await gunzip(await decryptBytes(key, enc));
        AccountFile.deserialize(fileBytes);
        deserializeOk = true;
      } catch {
        deserializeOk = false;
      }
    }

    const ok = bytesMatch && (dummyChunks ? true : deserializeOk === true);
    return {
      ok,
      phase: ok ? "done" : !bytesMatch ? "bytes-mismatch" : "deserialize",
      mode,
      ...sizes,
      wroteBytes: payload.length,
      wroteWords,
      chunksPerTx,
      readBytes: enc.length,
      bytesMatch,
      deserializeOk,
      nonceBefore,
      nonceAfter,
      nonceUnchanged,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
