"use client";

/**
 * Detect a "poisoned" (permanently frozen) private Miden account.
 *
 * A private account keeps its state only in the browser. If that state was created on
 * another origin/device and NEVER backed up, a fresh origin re-derives the same id but
 * EMPTY, while the chain holds a non-zero commitment. Every tx then fails with:
 *
 *   initial account commitment 0x0000…0000 does not match the current commitment 0x<nonzero>
 *
 * The node keeps only the commitment hash, not the private state, so this is
 * unrecoverable — no backup exists to restore from. The ONLY fix is to sign in with a
 * DIFFERENT login (a different Para identity → a different account id). We detect the
 * signature so the UI can say that plainly instead of letting the user bang on a funding
 * / trade that can never succeed.
 */
export function isPoisonedAccountError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  // local commitment is all-zero, on-chain "current" commitment is non-zero.
  return /initial account commitment 0x0+ .*does not match the current commitment 0x[0-9a-f]*[1-9a-f]/i.test(
    m,
  );
}

export const POISONED_ACCOUNT_MESSAGE =
  "This account can't be recovered — its on-chain state was created on another device and " +
  "was never backed up, so it's permanently frozen. Disconnect (the power icon, top right) " +
  "and sign in with a DIFFERENT login to get a fresh, working account.";
