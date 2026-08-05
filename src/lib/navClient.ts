"use client";

/**
 * Client-side NAV reads — the decentralized replacement for /api/nav-status.
 *
 * A single read-only Miden client (its own isolated store, no wallet, no keys)
 * reads any basket faucet's live supply + compute_v ON-CHAIN via readFaucetNav
 * (the same view calls the deposit/redeem notes settle against). Public cards
 * and the app both call readNavStatus — nothing runs on the server. The client
 * is created lazily + memoized so the WASM only loads when NAV is first shown.
 */
import { basketFaucetId } from "./basketFaucets";
import { readFaucetNav } from "./clientNote";

/** Same shape /api/nav-status used to return. */
export interface NavStatus {
  faucet: string;
  supply: string;
  vaultValueUsdX1e8: string;
  navPerShareUsd: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readClientP: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getReadClient(): Promise<any> {
  if (!readClientP) {
    readClientP = (async () => {
      const sdk = await import("@miden-sdk/miden-sdk");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = await (sdk as any).MidenClient.create({
        rpcUrl: "testnet",
        storeName: "darwin-nav-read", // isolated from the wallet store
        autoSync: false,
      });
      await client.sync().catch(() => {}); // best-effort; getOrImport refreshes the faucet
      return client;
    })();
  }
  return readClientP;
}

/**
 * Read a NAV basket's live state fully client-side. Returns null for unknown /
 * non-NAV baskets. navPerShareUsd = V / S (or 1 when supply is 0).
 */
export async function readNavStatus(symbol: string): Promise<NavStatus | null> {
  const faucet = basketFaucetId(symbol);
  if (!faucet) return null;
  const client = await getReadClient();
  const { supply, vaultValue } = await readFaucetNav(client, faucet);
  const navPerShareUsd = supply > 0n ? Number(vaultValue) / Number(supply) : 1;
  return {
    faucet,
    supply: supply.toString(),
    vaultValueUsdX1e8: vaultValue.toString(),
    navPerShareUsd,
  };
}
