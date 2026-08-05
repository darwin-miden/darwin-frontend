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
import pragmaOracleMasm from "./masm/pragma_oracle.masm";
import { EPOCH_DUSDC_FAUCET_ID } from "./midenConstants";

// Pragma oracle on Miden testnet (astraly-labs/pragma-miden). The client reads
// its medians on-chain via FPI and checks the faucet feed matches — so an
// operator can't inject a price that deviates from the decentralized oracle.
const PRAGMA_ORACLE = "0x7ad4aa02b1816c117e32853e210c28";
const PRAGMA_PUBLISHER = "0x6d37b2d4aedd697140338bb31c67e3";
const PRAGMA_ENTRIES_SLOT = "pragma::publisher::entries";
const DARWIN_FEED_SLOT = "darwin::price::feed";
// pair index prefix + Pragma decimals (BTC/ETH/DAI=8, USDT=6).
const PRAGMA_PAIRS: Record<string, [number, number]> = { wbtc: [3, 8], eth: [2, 8], usdt: [4, 6] };

export interface PragmaVerification {
  /** Live Pragma medians (USD), read on-chain by the browser. */
  pragma: { wbtc: number; eth: number; usdt: number };
  /** The faucet's on-chain feed the NAV notes settle against. */
  feed: { wbtc: number; eth: number; usdt: number };
  /** True when the feed matches Pragma within tolerance. */
  verified: boolean;
  oracle: string;
}

/**
 * Verify the basket faucet's price feed against the LIVE Pragma oracle, entirely
 * client-side: FPI-read each pair's median from the oracle + read the faucet's
 * feed slot, and compare (orchestrator convention: feed = round(usd) for
 * wbtc/eth, round(usd*100) for usdt). Detects operator price-injection on-chain.
 * Returns null if the read fails (e.g. Pragma publisher rotated).
 */
export async function verifyPragma(faucetId: string): Promise<PragmaVerification | null> {
  try {
    const client = await getReadClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = (await import("@miden-sdk/miden-sdk")) as any;
    const { AccountId, Word, Felt, AccountStorageRequirements } = sdk;
    const SlotAndKeys = sdk.SlotAndKeys ?? sdk.getWrappedSdk().SlotAndKeys;
    for (const id of [PRAGMA_ORACLE, PRAGMA_PUBLISHER, faucetId]) await client.accounts.getOrImport(id);

    const readMedian = async (prefix: number, decimals: number): Promise<number> => {
      const fw = Word.newFromFelts([new Felt(0n), new Felt(0n), new Felt(0n), new Felt(BigInt(prefix))]);
      const storage = AccountStorageRequirements.fromSlotAndKeysArray([new SlotAndKeys(PRAGMA_ENTRIES_SLOT, [fw])]);
      const script = await client.compile.txScript({
        code: `use oracle_component::oracle_module\nuse miden::core::sys\nbegin\n    push.0.0.0.${prefix}\n    call.oracle_module::get_median\n    exec.sys::truncate_stack\nend\n`,
        libraries: [{ namespace: "oracle_component::oracle_module", code: pragmaOracleMasm, linking: "dynamic" }],
      });
      const out = await client.transactions.executeProgram({
        account: AccountId.fromHex(PRAGMA_ORACLE),
        script,
        foreignAccounts: [{ id: AccountId.fromHex(PRAGMA_PUBLISHER), storage }, { id: AccountId.fromHex(PRAGMA_ORACLE) }],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const f = (i: number): bigint => { const x = out.at ? out.at(i) : out[i]; return BigInt(x.asInt ? x.asInt() : x.toString()); };
      return f(0) === 0n ? 0 : Number(f(1)) / 10 ** decimals;
    };

    const pragma = {
      wbtc: await readMedian(...PRAGMA_PAIRS.wbtc),
      eth: await readMedian(...PRAGMA_PAIRS.eth),
      usdt: await readMedian(...PRAGMA_PAIRS.usdt),
    };
    const acct = await client.accounts.get(faucetId);
    const item = acct.storage().getItem(DARWIN_FEED_SLOT);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ff = (item.toFelts ? item.toFelts() : item).map((x: any) => Number(BigInt(x.asInt ? x.asInt() : x.toString())));
    const feed = { wbtc: ff[0], eth: ff[1], usdt: ff[2] };
    const within = (a: number, b: number, tol = 0.03) => (b === 0 ? a === 0 : Math.abs(a - b) / b <= tol);
    const verified =
      within(feed.wbtc, Math.round(pragma.wbtc)) &&
      within(feed.eth, Math.round(pragma.eth)) &&
      within(feed.usdt, Math.round(pragma.usdt * 100));
    return { pragma, feed, verified, oracle: PRAGMA_ORACLE };
  } catch {
    return null;
  }
}

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
