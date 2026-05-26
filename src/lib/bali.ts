/**
 * Bali agglayer (gateway-fm) L1↔L2 bridge client.
 *
 * Canonical Sepolia ↔ Miden bridge per the proposal Flow A. Calls
 * `bridgeAsset` on the Sepolia bridge contract with destination
 * network = 76 (the post-2026-05-26 relaunch network — net 73 is
 * permanently frozen). On the Miden side the bridge solver mints a
 * P2ID note to the destination once `ready_for_claim` flips.
 *
 * Bridge contract:  0x1348947e282138d8f377b467F7D9c2EB0F335d1f (Sepolia)
 * Bridge service:   https://miden-testnet-bridge.dev.eu-north-3.gateway.fm
 * L2 chain ID:      1022211914 (Bali)
 * Bridge account:   mcst1arychvrurzxdy5qwz0mg5p5umsvsepyx
 *                   (0xc98bb07c188cd2500e13f68a069cdc)
 * ETH faucet:       mcst1arnrhfau9svl7cpu2tr8lfzzd5j87wwe
 *                   (0xe63ba7bc2c19ff603c52c67fa4426d)
 */

export const BALI_NETWORK_ID = 76;
export const BALI_BRIDGE_ADDRESS = "0x1348947e282138d8f377b467F7D9c2EB0F335d1f" as const;
export const BALI_BRIDGE_SERVICE = "https://miden-testnet-bridge.dev.eu-north-3.gateway.fm";
export const BALI_L2_CHAIN_ID = 1022211914;
export const BALI_BRIDGE_ACCOUNT_HEX = "0xc98bb07c188cd2500e13f68a069cdc" as const;
export const BALI_ETH_FAUCET_HEX = "0xe63ba7bc2c19ff603c52c67fa4426d" as const;

export const BALI_BRIDGE_ABI = [
  {
    type: "function",
    name: "bridgeAsset",
    stateMutability: "payable",
    inputs: [
      { name: "destinationNetwork", type: "uint32" },
      { name: "destinationAddress", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "forceUpdateGlobalExitRoot", type: "bool" },
      { name: "permitData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface BaliBridgeDeposit {
  leaf_type: number;
  orig_net: number;
  orig_addr: string;
  amount: string;
  dest_net: number;
  dest_addr: string;
  block_num: string;
  deposit_cnt: number;
  network_id: number;
  tx_hash: string;
  claim_tx_hash: string;
  metadata: string;
  ready_for_claim: boolean;
  global_index: string;
}

interface BridgesResponse {
  deposits: BaliBridgeDeposit[];
  total_cnt: string;
}

/**
 * Pad a 15-byte Miden account ID (30 hex chars) into the 20-byte ETH
 * address representation the bridge contract expects. The bridge
 * decodes the trailing 15 bytes back into a Miden ID on the L2 side.
 *
 *   miden 0xed3cd5befa3207805f8529207cfc0d
 *   eth   0x00000000eD3cD5beFa3207805f8529207CfC0D00
 *
 * The trailing 00 byte aligns to the bridge's internal layout.
 */
export function midenToEthDest(midenHex: string): `0x${string}` {
  let h = midenHex.toLowerCase().replace(/^0x/, "");
  if (h.length !== 30) {
    throw new Error(`miden account ID must be 15 bytes (30 hex chars), got ${h.length}`);
  }
  // pad to 40 chars: 8 leading zeros + 30 char id + 2 trailing zeros
  return `0x${"0".repeat(8)}${h}00` as `0x${string}`;
}

export async function listBridgesForDest(ethEncodedDest: string): Promise<BaliBridgeDeposit[]> {
  const r = await fetch(`${BALI_BRIDGE_SERVICE}/api/bridges/${ethEncodedDest}`);
  if (!r.ok) {
    throw new Error(`bridge service ${r.status}`);
  }
  const j = (await r.json()) as BridgesResponse;
  return j.deposits;
}
