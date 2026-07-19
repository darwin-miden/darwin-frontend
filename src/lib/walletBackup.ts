/**
 * Invisible auto-backup / auto-restore for the confidential self-custody wallet.
 *
 * A private Miden account's state lives only in the browser; losing it without a
 * backup permanently freezes the wallet (see the 0x813b incident). Instead of
 * asking the user to click "Back up" / "Restore", this runs automatically:
 *
 * - After every state-changing flow (deposit / withdraw) → autoBackupWallet()
 *   silently writes an encrypted copy on-chain (via the Mac relay). No prompt:
 *   the backup key rode the wallet-derivation signature (see cacheBackupKeyFromSeed).
 * - On wallet derivation (connect / new device) → restoreFromBackup() is passed
 *   to deriveMidenWallet as `tryRestore`; on an empty store it imports the backup
 *   before a fresh shell is created, so the wallet + balance come back silently.
 *
 * Both are best-effort and never throw — a failure must not break a flow.
 */

import {
  cachedBackupKey,
  decryptBytes,
  encryptBytes,
} from "./storeBackup";
import {
  gunzip,
  gzip,
  readOnchainBackup,
  writeOnchainBackupViaMac,
} from "./onchainBackup";
import { evmToUserIdFelts, TRUSTLESS_CONTROLLER_HEX } from "./trustlessController";
import { cachedBackupAuthSig, getBackupAuthSig } from "./backupAuth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;
type RunExclusive = <T>(fn: () => Promise<T>) => Promise<T>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignTypedData = (td: any) => Promise<`0x${string}`>;

/**
 * Import the on-chain backup into the store and return the restored wallet id.
 * Returns null when there's no backup, it can't be decrypted (e.g. a stale
 * backup under an older key), or the account is already tracked locally (a
 * returning user — the caller then keeps the existing local state). Meant to be
 * used as deriveMidenWallet's `tryRestore`, i.e. against an EMPTY store.
 */
export async function restoreFromBackup(params: {
  client: Client;
  runExclusive: RunExclusive;
  syncState: () => Promise<unknown>;
  evmAddress: `0x${string}`;
}): Promise<string | null> {
  const { client, runExclusive, syncState, evmAddress } = params;
  const key = cachedBackupKey(evmAddress);
  if (!key) return null;
  const { suffix, prefix } = evmToUserIdFelts(evmAddress);
  const enc = await readOnchainBackup(suffix, prefix, TRUSTLESS_CONTROLLER_HEX);
  if (!enc) return null;
  try {
    const back = await gunzip(await decryptBytes(key, enc));
    const { AccountFile } = await import("@miden-sdk/miden-sdk");
    const af = AccountFile.deserialize(back);
    const id = await runExclusive(() =>
      (client as { importAccountFile: (f: unknown) => Promise<string> }).importAccountFile(af),
    );
    await runExclusive(() => syncState()).catch(() => {});
    return typeof id === "string" ? id : null;
  } catch {
    // undecryptable (stale key) or "already being tracked" → keep local.
    return null;
  }
}

// Module-level guard: dedupe concurrent backups and debounce bursts (flow
// completions can fire close together).
let backingUp = false;
let lastBackupAt = 0;

/**
 * Silently back up the wallet's confidential state on-chain. No prompt (uses the
 * cached backup key), no UI. Debounced. Call after any flow that changes the
 * account state, and once after derivation so a wallet with a balance is always
 * protected. `force` bypasses the debounce (e.g. right after a deposit).
 */
export async function autoBackupWallet(params: {
  client: Client;
  runExclusive: RunExclusive;
  walletId: string;
  evmAddress: `0x${string}`;
  // Signs the one-time ownership proof the write route requires. Optional: when
  // absent we use a previously-cached signature; if none exists the backup is
  // skipped (best-effort) rather than sent unauthenticated.
  signTypedData?: SignTypedData;
  force?: boolean;
}): Promise<void> {
  const { client, runExclusive, walletId, evmAddress, signTypedData, force } = params;
  const key = cachedBackupKey(evmAddress);
  if (!key || !walletId) return;
  if (backingUp) return;
  if (!force && Date.now() - lastBackupAt < 15_000) return;
  // Ownership proof for the write. Cached in localStorage → at most one prompt
  // per device. Without a signer and no cached proof, skip: the route rejects
  // unauthenticated writes, so there's nothing to gain by calling it.
  let authSig = cachedBackupAuthSig(evmAddress);
  if (!authSig && signTypedData) {
    authSig = await getBackupAuthSig(evmAddress, signTypedData).catch(() => null);
  }
  if (!authSig) return;
  backingUp = true;
  try {
    const { AccountId } = await import("@miden-sdk/miden-sdk");
    const file = await runExclusive(() =>
      (client as {
        exportAccountFile: (id: unknown) => Promise<{ serialize: () => Uint8Array }>;
      }).exportAccountFile(AccountId.fromHex(walletId)),
    );
    const enc = await encryptBytes(key, await gzip(file.serialize()));
    const { suffix, prefix } = evmToUserIdFelts(evmAddress);
    const res = await writeOnchainBackupViaMac({
      suffix,
      prefix,
      controllerId: TRUSTLESS_CONTROLLER_HEX,
      encryptedBytes: enc,
      evmAddress,
      authSig,
    });
    if (res.ok) lastBackupAt = Date.now();
  } catch {
    /* best-effort; silent */
  } finally {
    backingUp = false;
  }
}
