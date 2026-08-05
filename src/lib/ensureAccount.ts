/**
 * Self-heal the Para signer account into a FRESH local store.
 *
 * The Para signer derives a DETERMINISTIC, PUBLIC Miden account id (same id on
 * every device/origin — the seed is SHA-256 of the wallet's pubkey commitment).
 * The SDK's `initializeSignerAccount` tries `importAccountById` at connect time to
 * pull that account's on-chain state, but the import runs inside a swallow-all
 * `catch {}` — a transient RPC/sync hiccup there drops it to a genesis
 * `newAccount(...)` fallback that can leave the account not-quite-materialized in
 * the store. A later `consume` then throws:
 *
 *     failed to apply transaction result: storage error:
 *     account data wasn't found for account id 0x…
 *
 * This bites a fresh IndexedDB (a new browser, cleared storage, or a DIFFERENT
 * ORIGIN — e.g. the Vercel deploy vs the Mac dev origin) where the account exists
 * on-chain but was never written locally. Because the account is public and, by
 * the time we're claiming/trading, on-chain, we just re-import its full state from
 * the node right before we need it. No-op once the account is tracked locally, so
 * it's cheap to call on every hot path.
 */

type MinimalClient = {
  getAccount: (id: unknown) => Promise<unknown>;
  importAccountById: (id: unknown) => Promise<void>;
  syncState: () => Promise<unknown>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureSignerAccountLoaded(
  client: unknown,
  runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T>,
  signerAccountId: string,
  tries = 4,
): Promise<boolean> {
  if (!client || !signerAccountId) return false;
  const { AccountId } = await import("@miden-sdk/miden-sdk");
  const id = AccountId.fromHex(signerAccountId);
  const c = client as MinimalClient;

  for (let i = 0; i < tries; i++) {
    // Already tracked? Then there's nothing to heal — the common case, one cheap read.
    try {
      if (await runExclusive(() => c.getAccount(id))) return true;
    } catch {
      /* read raced a concurrent sync — fall through to import + retry */
    }
    // Missing locally → pull the public account's on-chain state into the store.
    try {
      await runExclusive(async () => {
        await c.syncState();
        await c.importAccountById(id);
        await c.syncState();
      });
    } catch {
      /* ACCOUNT_NOT_FOUND_ON_CHAIN (deploy still pending) / ALREADY_TRACKED /
         transient RPC — the getAccount at the top of the next loop is the verdict */
    }
    await sleep(1200);
  }

  try {
    return !!(await runExclusive(() => c.getAccount(id)));
  } catch {
    return false;
  }
}
