"use client";

/**
 * Lightweight client-side activity log for the portfolio timeline.
 *
 * Deposit / withdraw flows don't persist their history anywhere, so the
 * portfolio had nothing to show once a position netted back to zero. This
 * appends each completed deposit/withdraw to localStorage (keyed by the EVM
 * address) so the portfolio can show "you deposited 1.00 DCC · tx … · 2m ago".
 * Best-effort + purely local: it never blocks a flow and holds no funds.
 */

export type Activity = {
  type: "deposit" | "withdraw";
  /** Basket symbol (DCC / DAG / DCO). */
  basket: string;
  /** Human amount (USDC in / dUSDC out), as typed. */
  amount: string;
  /** Basket-token SHARES minted/burned, in base units (8-dec). NAV baskets
   *  only — lets the portfolio price the position as shares × NAV-per-share
   *  instead of assuming value == deposit amount. */
  shares?: string;
  /** Sepolia tx or Miden note id, for an explorer link. */
  tx?: string;
  /** Unix ms. */
  ts: number;
};

const KEY = (evm: string) => `darwin-activity-${evm.toLowerCase()}`;
const MAX = 25;

/** Append a completed deposit/withdraw. Never throws. */
export function logActivity(
  evm: string | undefined | null,
  a: Omit<Activity, "ts"> & { ts?: number },
): void {
  if (!evm || typeof window === "undefined") return;
  try {
    const list = readActivity(evm);
    list.unshift({ ...a, ts: a.ts ?? Date.now() });
    window.localStorage.setItem(KEY(evm), JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* private mode / quota — the timeline is best-effort */
  }
}

/** Read the activity history for an EVM address, newest first. */
export function readActivity(evm: string | undefined | null): Activity[] {
  if (!evm || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY(evm));
    const parsed = raw ? (JSON.parse(raw) as Activity[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** "2m ago" / "3h ago" / "5d ago". */
export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
