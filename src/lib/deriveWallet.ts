import { keccak256, toBytes } from "viem";

/**
 * Secure derivation of the self-custody Miden wallet from an EVM
 * signature — the ONE place a signature becomes a signing key.
 *
 * Threat this guards against: the derived seed IS the Miden private key.
 * The less time it spends live in JS memory, the smaller the window an
 * XSS / compromised-dependency / hostile-extension has to read it.
 *
 * Minimisation applied here:
 *  - keccak → bytes DIRECTLY (`to = "bytes"`), never an intermediate hex
 *    string. JS strings are immutable and can't be zeroed, so a hex seed
 *    would linger in memory until GC; a Uint8Array can be wiped now.
 *  - the seed bytes live only inside this function's scope, are handed
 *    straight to the WASM createWallet, and are `fill(0)`-wiped in a
 *    `finally` — so they're gone within milliseconds of the call.
 *  - only the wallet id string is returned. The signature and seed are
 *    never returned, logged, or stored anywhere.
 *
 * Callers pass a `signMessage` thunk so the raw signature also stays in
 * this scope (GC-able on return) instead of a long-lived component
 * closure.
 */

// @miden-sdk/react hard-codes a broken default AuthScheme symbol; the
// wasm binding wants the numeric enum (2 = AuthRpoFalcon512).
const AUTH_SCHEME_FALCON_ENUM_VALUE = 2;

// The SDK's createWallet options type is strict; accept it loosely and
// let the caller's real hook enforce the shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreateWallet = (opts: any) => Promise<{ id: () => { toString: () => string } }>;

export async function deriveMidenWallet(
  createWallet: CreateWallet,
  signMessage: () => Promise<`0x${string}`>,
): Promise<string> {
  const sig = await signMessage();
  // Direct-to-bytes keccak: no hex string of the secret is ever created.
  const seedBytes = keccak256(toBytes(sig), "bytes");
  try {
    const acc = await createWallet({
      initSeed: seedBytes,
      storageMode: "private",
      authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE,
    });
    return acc.id().toString();
  } catch (e) {
    // Re-derive of a wallet already in this browser's IndexedDB: the SDK
    // throws "id 0x… already being tracked" — recover the id, same wallet.
    const msg = e instanceof Error ? e.message : String(e);
    const m = msg.match(/id (0x[0-9a-fA-F]+)/);
    if (m && /already being tracked/i.test(msg)) return m[1];
    throw e;
  } finally {
    // Wipe the seed immediately — shrinks the XSS window to this call.
    seedBytes.fill(0);
  }
}
