"use client";

/**
 * Resilient wrapper around the Miden client's syncState.
 *
 * Miden's public testnet RPC (`rpcUrl: "testnet"`) is load-balanced across several node
 * replicas that are NOT always at the same height. The web-client stores the highest
 * block it has ever seen; when a later request is routed to a replica that is a couple of
 * blocks behind, `sync_notes` is rejected with:
 *
 *     block_to (1300636) is greater than chain tip (1300634)
 *
 * That single failure cascades — a stale sync means the Pragma publisher's price entries
 * don't materialise and the FPI price read asserts "pragma <pair> not tracked". The error
 * is TRANSIENT: a round-robin balancer routes the next attempt to a different replica, and
 * a lagging replica catches up within a block or two. So we simply retry with backoff and
 * swallow only the known transient shapes; a real error is rethrown so it isn't masked.
 *
 * Returns true if a sync eventually succeeded, false if every attempt hit a transient
 * node error (the caller proceeds with possibly-stale local state — never throws on lag).
 */

type SyncFn = () => Promise<unknown>;
type RunExclusive = <T>(fn: () => Promise<T> | T) => Promise<T>;

// Transient, retry-worthy RPC/replica conditions ONLY. Deliberately narrow: bare
// substrings like "chain tip", "failed to sync", "connection" or "unavailable" would
// also match genuine, non-retryable errors (store corruption, state mismatch, bad
// params) and mask them as lag. Each branch is a specific transient shape:
//  - the load-balanced replica lag we actually see ("block_to N is greater than chain tip M")
//  - a block not yet on the routed replica
//  - gRPC transport codes (UNAVAILABLE / DEADLINE_EXCEEDED) and their text forms
//  - concrete connection drops / timeouts
const TRANSIENT_SYNC_RE =
  /block_to\b[^\n]*\b(?:greater than|>)\b[^\n]*\bchain tip\b|block[_ ]?(?:num|number|to)\b[^\n]*\bnot (?:found|yet)\b|\bUNAVAILABLE\b|\bDEADLINE_EXCEEDED\b|deadline exceeded|temporarily unavailable|connection (?:refused|reset|closed|error)|timed out/i;

export function isTransientSyncError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_SYNC_RE.test(msg);
}

export async function resilientSync(
  runExclusive: RunExclusive,
  syncState: SyncFn,
  opts?: { tries?: number; baseDelayMs?: number },
): Promise<boolean> {
  const tries = opts?.tries ?? 6;
  const base = opts?.baseDelayMs ?? 900;
  let lastTransient: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await runExclusive(() => syncState());
      return true;
    } catch (e) {
      if (!isTransientSyncError(e)) throw e; // a real error must surface, not be masked
      lastTransient = e;
      // Linear backoff. A round-robin LB may route the next attempt to a caught-up
      // replica; a lagging replica also advances a block every ~3s.
      await new Promise((r) => setTimeout(r, base + i * 500));
    }
  }
  console.warn(
    "[resilient-sync] node still behind after retries (transient replica lag):",
    lastTransient instanceof Error ? lastTransient.message : lastTransient,
  );
  return false;
}
