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
