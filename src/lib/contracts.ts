/**
 * Sepolia-deployed Darwin Protocol contract addresses + minimal ABIs.
 *
 * Source of truth: `darwin-relay/state/sepolia.toml` (relay stack) +
 * the M2 stack addresses from `darwin-bridge-adapter`'s
 * DeployM2Stack.s.sol broadcast.
 *
 * Updated by hand when redeployed. wagmi reads from here for every
 * useReadContract / useWriteContract hook.
 */

import { sepolia } from "wagmi/chains";

export const SEPOLIA_CHAIN = sepolia;

export const DARWIN_RELAY_ADDRESS = "0x7e5279AD0d9F7fB8884562C336Fa6d78DCbf7c93" as const;
export const MOCK_USDC_ADDRESS    = "0x6dAb940a4E1d434965E22e9F6d624fF68F6922a0" as const;

export const DARWIN_STRATEGY_ADDRESS = "0x635E19c61CD09d145D57A88cE8185Ddf27fA356F" as const;

export interface BasketDef {
  symbol: "DCC" | "DAG" | "DCO";
  name: string;
  basketId: `0x${string}`;
  tokenAddress: `0x${string}`;
}

export const BASKET_TOKENS: BasketDef[] = [
  {
    symbol: "DCC",
    name: "Darwin Core Crypto",
    basketId: "0x1fbfef9aa7f4e8f8bd84b940396c9263c0c2ac2212f53759ceb3b71aaeed43fe",
    tokenAddress: "0x1EB7Bd808402824232853e66DF6843D68462B7A4",
  },
  {
    symbol: "DAG",
    name: "Darwin Aggressive",
    basketId: "0x74491929c2f72408e48b338222172a8a07d8c3087617d09881d00d72278eb6c1",
    tokenAddress: "0x73F18087dd45d180e75cADcD383479624326E336",
  },
  {
    symbol: "DCO",
    name: "Darwin Conservative",
    basketId: "0xb2cbc4016a8155cd5b6be0c2683f937c73985e9bee24f6cb8e383f4967408757",
    tokenAddress: "0x6344469eB35Ff00d5892fD368727ad3C9E45677c",
  },
];

export function basketBySymbolUpper(sym: string): BasketDef | undefined {
  return BASKET_TOKENS.find((b) => b.symbol === sym.toUpperCase());
}

/**
 * Sepolia etherscan link helper.
 */
export function sepoliaAddressUrl(addr: string): string {
  return `https://sepolia.etherscan.io/address/${addr}`;
}

export function sepoliaTxUrl(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

// ----------------------------------------------------------------
// ABIs (minimal subsets we actually call from the UI)
// ----------------------------------------------------------------

export const DARWIN_RELAY_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "basketId", type: "bytes32" },
      { name: "midenRecipient", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancelDeposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getDeposit",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "deposit",
        type: "tuple",
        components: [
          { name: "status", type: "uint8" },
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "basketId", type: "bytes32" },
          { name: "midenRecipient", type: "bytes32" },
          { name: "requestedAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "nextId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "depositToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "RelayDepositRequested",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "basketId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "midenRecipient", type: "bytes32", indexed: false },
      { name: "requestedAt", type: "uint64", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * Status enum mirror of `DarwinRelayDeposit.sol::Status`.
 */
export const DEPOSIT_STATUS_LABELS = [
  "unknown",
  "requested",
  "in flight",
  "settled",
  "cancelled",
  "refunded",
] as const;

export type DepositStatusIndex = 0 | 1 | 2 | 3 | 4 | 5;
