"use client";

/**
 * Client-side helper for the backup-write ownership proof (see
 * backupAuthMessage.ts). The signature is deterministic per address, so we cache
 * it in localStorage: at most ONE MetaMask prompt per device, ever — then every
 * auto-backup reuses it silently, preserving the invisible-backup UX.
 */

import { backupAuthTypedData } from "./backupAuthMessage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignTypedData = (td: any) => Promise<`0x${string}`>;

const LS_PREFIX = "darwin.backupAuthSig.v1:";

function lsKey(evmAddress: string): string {
  return LS_PREFIX + evmAddress.toLowerCase();
}

/** Read the cached auth signature for this address (null if none / no window). */
export function cachedBackupAuthSig(evmAddress: `0x${string}`): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(lsKey(evmAddress));
  } catch {
    return null;
  }
}

/**
 * Return the auth signature for this address, prompting MetaMask once (and
 * caching in localStorage) if it isn't cached yet. Deterministic, so the cached
 * value is stable across sessions. Throws only if the user rejects the prompt —
 * callers treat backup auth as best-effort and skip the write on rejection.
 */
export async function getBackupAuthSig(
  evmAddress: `0x${string}`,
  signTypedData: SignTypedData,
): Promise<string> {
  const cached = cachedBackupAuthSig(evmAddress);
  if (cached) return cached;
  const sig = await signTypedData(backupAuthTypedData(evmAddress));
  try {
    window.localStorage.setItem(lsKey(evmAddress), sig);
  } catch {
    /* private mode / storage full — still return the fresh sig for this call */
  }
  return sig;
}
