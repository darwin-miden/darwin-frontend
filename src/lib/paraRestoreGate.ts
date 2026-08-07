"use client";

/**
 * Shared "restore gate" for private /para accounts.
 *
 * On a fresh origin the Para provider derives the account EMPTY, and ParaAppShell then
 * restores its real state from the on-chain backup asynchronously. A trade/consume that
 * runs against the still-empty (or restore-FAILED) account emits against the wrong
 * commitment → the tx fails and, worse, can strand funds. This gate lets the trade flow
 * await the restore outcome before emitting, and refuse to trade when restore errored.
 *
 * Status per account id:
 *  - "pending" : restore in flight (callers await)
 *  - "ready"   : local account matches its backup (or was deliberately not overwritten
 *                because local is already newer) → safe to trade
 *  - "none"    : no backup exists (genuinely fresh account) → safe to trade
 *  - "failed"  : restore ERRORED (RPC blip, decrypt, overwrite didn't take) → do NOT
 *                trade; the account may be empty/stale and an emit would be wrong
 */

export type RestoreStatus = "pending" | "ready" | "none" | "failed";

type Gate = { status: RestoreStatus; promise: Promise<RestoreStatus>; resolve: (s: RestoreStatus) => void };

const gates = new Map<string, Gate>();

function ensure(id: string): Gate {
  let g = gates.get(id);
  if (!g) {
    let resolve!: (s: RestoreStatus) => void;
    const promise = new Promise<RestoreStatus>((r) => (resolve = r));
    g = { status: "pending", promise, resolve };
    gates.set(id, g);
  }
  return g;
}

/** Called by the shell once restore resolves (or when there's nothing to restore). */
export function setRestoreStatus(id: string, status: Exclude<RestoreStatus, "pending">): void {
  const g = ensure(id);
  g.status = status;
  g.resolve(status);
}

export function getRestoreStatus(id: string): RestoreStatus {
  return gates.get(id)?.status ?? "pending";
}

/** Await the restore outcome (bounded). Returns the final status; if it never resolves
 *  within the timeout, returns whatever the current status is. */
export async function awaitRestore(id: string, timeoutMs = 30_000): Promise<RestoreStatus> {
  const g = ensure(id);
  if (g.status !== "pending") return g.status;
  const timeout = new Promise<RestoreStatus>((r) => setTimeout(() => r(g.status), timeoutMs));
  return Promise.race([g.promise, timeout]);
}

/** Clear the gate for an account (e.g. before a re-restore attempt after a failure). */
export function resetRestore(id: string): void {
  gates.delete(id);
}
