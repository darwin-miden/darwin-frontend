/**
 * Confidential DCC balance cache — bridges the reliable read to the display.
 *
 * The DCC vault is a PRIVATE Miden account: not server-readable, and
 * `client.getBalance` only resolves reliably inside a flow's warm client
 * (account created + synced). So the deposit/withdraw flows call
 * `stashDccBalance` after they complete (getBalance works there), and the
 * Withdraw panel calls `readDccBalance` to display the true balance.
 * localStorage (not session) so it survives a page reload.
 */

import { CONFIDENTIAL_FAUCETS } from "./confidentialFaucets";

const key = (walletId: string) => `darwin-dcc-${walletId}`;

/** Read + persist the real DCC balance from a warm client. Best-effort. */
export async function stashDccBalance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>,
  walletId: string,
  basketSymbol: string,
): Promise<bigint | null> {
  try {
    const faucet = CONFIDENTIAL_FAUCETS[basketSymbol];
    if (!faucet) return null;
    const bal = await runExclusive(() =>
      (
        client as { getBalance: (a: string, t: string) => Promise<bigint> }
      ).getBalance(walletId, faucet),
    );
    const v = BigInt(bal ?? 0n);
    if (typeof window !== "undefined") localStorage.setItem(key(walletId), String(v));
    return v;
  } catch {
    return null;
  }
}

/**
 * Read the DCC balance LIVE from the account's own vault:
 * getAccount → vault().getBalance(faucet). This is a local, synchronous read of
 * the private account the browser OWNS — reliable once the account is
 * imported/synced (e.g. right after a restore, or on page load with a derived
 * wallet), unlike `client.getBalance` which only resolves in a warm flow client.
 * Stashes the result to the cache and returns it (null on any failure).
 */
export async function liveDccBalance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>,
  walletId: string,
  basketSymbol: string,
): Promise<bigint | null> {
  try {
    const faucetHex = CONFIDENTIAL_FAUCETS[basketSymbol];
    if (!faucetHex) return null;
    const { AccountId } = await import("@miden-sdk/miden-sdk");
    const acc = (await runExclusive(() =>
      client.getAccount(AccountId.fromHex(walletId)),
    )) as { vault: () => { getBalance: (id: unknown) => bigint } } | null | undefined;
    if (!acc) return null;
    const bal = acc.vault().getBalance(AccountId.fromHex(faucetHex));
    const v = BigInt(bal ?? 0n);
    if (typeof window !== "undefined") localStorage.setItem(key(walletId), String(v));
    return v;
  } catch {
    return null;
  }
}

/** Read the last-stashed DCC balance (6-dec base units), or null if unknown. */
export function readDccBalance(walletId: string): bigint | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(key(walletId));
  if (raw == null) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}
