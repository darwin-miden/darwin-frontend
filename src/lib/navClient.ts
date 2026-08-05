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
import { buildClientDripNote, type ClientDripNote, compileDripScript, readFaucetNav } from "./clientNote";
import { EPOCH_DUSDC_FAUCET_ID } from "./midenConstants";

/** Permissionless dUSDC dispenser (network account, allowlists the client drip
 * root 0x429409c1). Redeployed 2026-08-05 with both native + client roots. */
export const DRIP_DISPENSER_ID = "0x0a4f9215997556b16ad7b3faacbbf2";

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

/**
 * Build a permissionless dUSDC drip request fully client-side — replaces
 * /api/drip-note. Compiles the drip script via the read-only client (no wallet)
 * and returns the request note (emit from the user's wallet) + the precomputed
 * PUBLIC payout id (poll/consume once the dispenser mints it).
 */
export async function buildDripRequest(requester: string): Promise<ClientDripNote> {
  const client = await getReadClient();
  // Normalize hex or bech32 → canonical account id string.
  let id = requester;
  if (!/^0x[0-9a-fA-F]+$/.test(requester)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = (await import("@miden-sdk/miden-sdk")) as any;
    try {
      id = sdk.AccountId.fromBech32(requester).toString();
    } catch {
      id = sdk.Address.fromBech32(requester).accountId().toString();
    }
  }
  const script = await compileDripScript((opts) => client.compile.noteScript(opts));
  return buildClientDripNote(script, {
    requester: id,
    dusdcFaucet: EPOCH_DUSDC_FAUCET_ID,
    dispenser: DRIP_DISPENSER_ID,
  });
}
