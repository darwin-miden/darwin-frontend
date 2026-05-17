/**
 * Static snapshot of darwin-baskets/state/testnet.toml. Hand-curated
 * — the bot run that builds this is darwin-baskets's testnet_inventory
 * binary; we paste the result here so the frontend stays purely
 * static (no runtime read of a TOML file).
 *
 * When the testnet inventory changes:
 *   1. cargo run -p darwin-baskets --bin testnet_inventory
 *   2. mirror the relevant ids / tx hashes back here
 *   3. bump TESTNET_SNAPSHOT_TAKEN_AT
 */

export const TESTNET_SNAPSHOT_TAKEN_AT = "2026-05-17";

export const MIDENSCAN_BASE = "https://testnet.midenscan.com";
export const MIDEN_RPC = "https://rpc.testnet.miden.io";

export interface DeployedAccount {
  label: string;
  role:
    | "asset-faucet"
    | "basket-faucet"
    | "controller"
    | "user-wallet"
    | "team-wallet"
    | "oracle";
  symbol?: string;
  accountId: string;
  storageMode: "public" | "private";
  deployTx?: string;
  notes?: string;
}

export const DEPLOYED_ACCOUNTS: DeployedAccount[] = [
  // Asset faucets (basket constituents)
  {
    label: "dETH faucet",
    role: "asset-faucet",
    symbol: "DETH",
    accountId: "0xa095d9b3831e96206ff70c2218a6a9",
    storageMode: "public",
    deployTx: "0xd2645c81130aafea22c638ef35833b72c2960d8d05845b584ee9dc294c3909e7",
  },
  {
    label: "dWBTC faucet",
    role: "asset-faucet",
    symbol: "DWBTC",
    accountId: "0x7a45cb24ada22120246bcf54196e12",
    storageMode: "public",
    deployTx: "0x33c2c0248d28f9caee2bcbc474146472a886c082b77986e3873ffa5019d72d99",
  },
  {
    label: "dUSDT faucet",
    role: "asset-faucet",
    symbol: "DUSDT",
    accountId: "0xd3789f451ddd4720602ba9eb1a268d",
    storageMode: "public",
    deployTx: "0x32cd61c2500c257e60a8026541e65208024e6b4345af5f949a681954cae0f90a",
  },
  {
    label: "dDAI faucet",
    role: "asset-faucet",
    symbol: "DDAI",
    accountId: "0xb526deb0408a29207e4f27ed57bf1a",
    storageMode: "public",
    deployTx: "0x2d534d2aecc7bded638610b4456780e8bd43c6954b086e7aa0ed4ef0f7c8dfd0",
  },
  // Basket-token faucets
  {
    label: "DCC basket-token faucet",
    role: "basket-faucet",
    symbol: "DCC",
    accountId: "0x2066f2da1f91ba202af5251d39101c",
    storageMode: "public",
    deployTx: "0x8da73c534cf5802b7a0b30815492d74daab4a14f1ec967b37911c7ed94843e15",
  },
  {
    label: "DAG basket-token faucet",
    role: "basket-faucet",
    symbol: "DAG",
    accountId: "0xfb6811fd6399df206d44f62800620d",
    storageMode: "public",
    deployTx: "0x420d8bda3a81ca39d767fe858e8bb662d7ef8852d11fd7c5f0934319367fbf5d",
  },
  {
    label: "DCO basket-token faucet",
    role: "basket-faucet",
    symbol: "DCO",
    accountId: "0xbe4efc6729eb3220423b7d6d6a0942",
    storageMode: "public",
    deployTx: "0x9f2cfef38b0a8a29732ce5caf190e578b707e294d611e6f3f8919f50d7747906",
  },
  // Controllers (v1 stubs + v2 real-bodies + v3 storage-aware)
  {
    label: "DCC controller (v1 stub)",
    role: "controller",
    symbol: "DCC",
    accountId: "0xaa20da7d98c2e29022510aa786948f",
    storageMode: "private",
    notes: "stub bodies, RegularAccountUpdatableCode",
  },
  {
    label: "DAG controller (v1 stub)",
    role: "controller",
    symbol: "DAG",
    accountId: "0x53c54781b7b091905a948b5e3f92fe",
    storageMode: "private",
  },
  {
    label: "DCO controller (v1 stub)",
    role: "controller",
    symbol: "DCO",
    accountId: "0xa3a0e023381d709060a19527e73f95",
    storageMode: "private",
  },
  {
    label: "v2 controller (real bodies + receive_asset)",
    role: "controller",
    accountId: "0xa25aa0b00007688024b74b05a52aab",
    storageMode: "private",
    notes:
      "compute_nav / compute_mint_amount / compute_redeem_amount run real u64 division. vault holds 100 dETH (Flow A) + 50 DCC (Flow C).",
  },
  {
    label: "v3 controller (storage-aware)",
    role: "controller",
    accountId: "0xcc33bbfe063efb806141336e041b01",
    storageMode: "private",
    notes:
      "adds read_pool_position via active_account::get_map_item on slot 2. M1→M2 hand-off.",
  },
  {
    label: "v4 controller (rebalance-aware)",
    role: "controller",
    accountId: "0x1975a9aa8572f8804fb38bee09fbdf",
    storageMode: "private",
    notes:
      "M2 Track 3. Adds execute_rebalance_step (MAST root 0xddff122f…84c53), the entry point a Flow B trigger note calls into. End-to-end on testnet via flow_b_demo.",
  },
  // Wallets
  {
    label: "Darwin team wallet",
    role: "team-wallet",
    accountId: "0x5230eb6eb7ba5c80335a738beaf8bc",
    storageMode: "private",
  },
  {
    label: "User wallet (Flow A/C simulation)",
    role: "user-wallet",
    accountId: "0xed3cd5befa3207805f8529207cfc0d",
    storageMode: "private",
    notes:
      "holds dETH / dWBTC / dUSDT / dDAI + DCC / DAG / DCO basket tokens.",
  },
  // Oracles
  {
    label: "Live Pragma oracle (testnet)",
    role: "oracle",
    accountId: "0xd0e1384e21a6350029d80128eb5c44",
    storageMode: "public",
    notes:
      "Real Pragma oracle on Miden testnet (mtst1argwzw…2t3x). Darwin's oracle_query_real binary reads ETH/USD and BTC/USD live via call.0xd1aa2a8b…28e8 (get_median MAST root, computed locally by re-running Pragma's build pipeline).",
  },
  {
    label: "Mock Pragma-style oracle (fallback)",
    role: "oracle",
    accountId: "0x085ba19aaebfaa002f1bc7ef8be6fd",
    storageMode: "public",
    notes:
      "Fallback oracle that mirrors Pragma's get_median + get_entry ABI. Production swap to the live Pragma adapter is a one-MAST-root edit.",
  },
];

export interface FlowEvent {
  label: string;
  txId: string;
  block: number;
  note?: string;
  detail: string;
}

export const FLOW_A_EVENTS: FlowEvent[] = [
  {
    label: "User wallet emits atomic deposit note",
    txId: "0xc127a2c9a466f2bc39848cdcf549b5e5a480bb10fd294fd77b453ea930f98187",
    block: 703309,
    note: "0xb4407ef8c40f6d51796ea22be9a9dbc844adb195d6586f1692e70c20f3b36563",
    detail: "100 dETH leaves user wallet → atomic deposit note (carries the asset + math script).",
  },
  {
    label: "v2 controller consumes the deposit note",
    txId: "0x2e211adf6f382749641b9e7324e89c85a0880238df29d154676377166ae856e2",
    block: 703322,
    detail:
      "Note script runs darwin::math::felt_div on-chain, then drains 100 dETH into the controller's vault via call.receive_asset.",
  },
];

export const FLOW_B_EVENTS: FlowEvent[] = [
  {
    label: "User wallet emits Flow B trigger note",
    txId: "0xdd1a97b9170623463e642dfbce86abc94be6315d3755c3c033fe51ca373b037d",
    block: 782141,
    note: "0x6d77db31a501b4ff1a6807953858038d7d4c83c6beb7aece19d5f80ca11e27fe",
    detail: "Zero-asset trigger note carrying [basket_id=1, ts] on its script stack. Calls into the v4 controller's execute_rebalance_step MAST root.",
  },
  {
    label: "v4 controller consumes the trigger note",
    txId: "0xaf8521f24c2a06f05b0512f632e64843e2b9399ad23a6e6c3cce4434c0b402f8",
    block: 782152,
    detail:
      "execute_rebalance_step runs inside the controller's tx context. M2 follow-up adds per-asset swap-note emission targeting a mock DEX account.",
  },
];

export const FLOW_C_EVENTS: FlowEvent[] = [
  {
    label: "User wallet emits atomic redeem note",
    txId: "0xd670066e796ed96ae30ef452392661b0029a4450af97037453c2fc1b6713908f",
    block: 777137,
    note: "0xb9797a4b409f1051578c5658666682338bc59d9b7c6ef575a02f001a6c655cb0",
    detail: "50 DCC leaves user wallet → atomic redeem note.",
  },
  {
    label: "v2 controller consumes the redeem note",
    txId: "0x005c4eec575800d251c12d84eeaa6cc1f2ffd98d090c291161f45e9e2e2a7800",
    block: 777149,
    detail:
      "darwin::math::felt_div runs inside the controller tx context, 50 DCC drains into the controller's vault.",
  },
];

export interface PoolFunding {
  basket: string;
  asset: string;
  amount: number;
  mintTx: string;
}

export const POOL_FUNDING: PoolFunding[] = [
  { basket: "DCC", asset: "dWBTC", amount: 40000, mintTx: "0x9941791ad440aa6a742106026b6c0bc91431425372c2b471de1c2974d1692a7a" },
  { basket: "DCC", asset: "dETH",  amount: 40000, mintTx: "0x9730b5b9b7081094bb971ef839961fc3445d6c9d4187740e47548a6fe4a19bf1" },
  { basket: "DCC", asset: "dUSDT", amount: 20000, mintTx: "0xde4b059d467f591a9e448f20c8ac13030dac734f198ff7dd923d26c7523dc6e5" },
  { basket: "DAG", asset: "dWBTC", amount: 50000, mintTx: "0x9423835a14d0e6f851ab40621eab46fe185fdada2fecc46a25feed441e560102" },
  { basket: "DAG", asset: "dETH",  amount: 50000, mintTx: "0xf8181532948932e15cdc043747a88cc9ff932bb6b4d41829762a0cb717afbfbb" },
  { basket: "DCO", asset: "dWBTC", amount: 10000, mintTx: "0x3eb283d59991640fd78f9a347164c1dac8c43533a1d10b71be14e30bd91f37c3" },
  { basket: "DCO", asset: "dETH",  amount: 10000, mintTx: "0x90d889979b293c5becf7edb1d7fca53c035c8bd48081995b2776e3f48013ebaf" },
  { basket: "DCO", asset: "dUSDT", amount: 40000, mintTx: "0x6343b4196b663a38463eac89d619bf9d1945bfece91642d1a4975e9af9a513b5" },
  { basket: "DCO", asset: "dDAI",  amount: 40000, mintTx: "0x604e0587a11e4c1af8bbc8701ae7dd611b4eb57281bc892fb87d5f344a549a2d" },
];

/**
 * ETH-side deployment registry (Sepolia). Mirrors
 * darwin-relay/state/sepolia.toml.
 */
export interface SepoliaContract {
  label: string;
  address: string;
  role: "relay" | "stablecoin" | "strategy" | "basket-token";
  notes?: string;
}

export const SEPOLIA_CONTRACTS: SepoliaContract[] = [
  {
    label: "DarwinRelayDeposit",
    role: "relay",
    address: "0x7e5279AD0d9F7fB8884562C336Fa6d78DCbf7c93",
    notes:
      "ETH-side escrow. User deposits, relay claims + bridges + confirms.",
  },
  {
    label: "MockUSDC",
    role: "stablecoin",
    address: "0x6dAb940a4E1d434965E22e9F6d624fF68F6922a0",
    notes:
      "6-decimal stable mirror for the deposit currency. Permissionless mint via .mint(to, amount).",
  },
  {
    label: "DarwinStrategy",
    role: "strategy",
    address: "0x635E19c61CD09d145D57A88cE8185Ddf27fA356F",
    notes:
      "Per-basket strategy registry: token list, target weights (bps), fees, drift threshold.",
  },
  {
    label: "DarwinBasketToken DCC",
    role: "basket-token",
    address: "0x1EB7Bd808402824232853e66DF6843D68462B7A4",
    notes: "ERC20 minted by the relay on a successful deposit into DCC.",
  },
  {
    label: "DarwinBasketToken DAG",
    role: "basket-token",
    address: "0x73F18087dd45d180e75cADcD383479624326E336",
    notes: "ERC20 minted by the relay on a successful deposit into DAG.",
  },
  {
    label: "DarwinBasketToken DCO",
    role: "basket-token",
    address: "0x6344469eB35Ff00d5892fD368727ad3C9E45677c",
    notes: "ERC20 minted by the relay on a successful deposit into DCO.",
  },
];
