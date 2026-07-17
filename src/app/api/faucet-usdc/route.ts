/**
 * Server-side testnet USDC faucet.
 *
 * Both Sepolia deposit rails need the tester to hold a specific mock "USDC"
 * before they can deposit — and a BRAND-NEW MetaMask account has no Sepolia ETH
 * to pay gas for a client-side mint. So this route mints the token server-side,
 * paying gas from a DISPOSABLE faucet key (FAUCET_PK in .env.local — never the
 * protected dev key). That makes onboarding invisible: connect → USDC appears,
 * no popup, no gas needed. Powers both the "Get test USDC" button and the
 * new-account auto-mint on the deposit panels.
 *
 * The tokens are open, public-mint mocks (anyone can mint any amount), so this
 * grants nothing that isn't already freely mintable — it just pays the gas and
 * caps the per-recipient amount so the faucet's gas isn't drained.
 */
import { NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC =
  process.env.SEPOLIA_RPC_HTTP ?? "https://ethereum-sepolia-rpc.publicnode.com";

// Whitelisted mock "USDC" tokens, one per deposit rail. Both expose a public
// `mint(address,uint256)`. Addresses mirror src/lib/epoch.ts (EPOCH_USDC_SEPOLIA)
// and src/lib/contracts.ts (MOCK_USDC_ADDRESS).
const TOKENS = {
  // Self-custody / Epoch rail (18-dec mock "USDC").
  "epoch-usdc": {
    address: "0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69" as `0x${string}`,
    decimals: 18,
  },
  // Miden-wallet / atomic-note rail (6-dec mock "USDC").
  "mock-usdc": {
    address: "0x6dAb940a4E1d434965E22e9F6d624fF68F6922a0" as `0x${string}`,
    decimals: 6,
  },
} as const;
type TokenKey = keyof typeof TOKENS;

const MINT_HUMAN = "100"; // grant per call
const SKIP_ABOVE_HUMAN = "200"; // don't top up an already-funded address (anti-drain)

const ERC20_MINT_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Serialize faucet txs: concurrent mints from one key would collide on nonce.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function POST(req: Request) {
  const pk = process.env.FAUCET_PK;
  if (!pk) {
    return NextResponse.json(
      { error: "faucet disabled (no FAUCET_PK configured)" },
      { status: 503 },
    );
  }

  let body: { address?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let to: `0x${string}`;
  try {
    to = getAddress(body.address ?? "");
  } catch {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  const tokenKey = (body.token ?? "epoch-usdc") as TokenKey;
  const token = TOKENS[tokenKey];
  if (!token) {
    return NextResponse.json(
      { error: `unknown token '${tokenKey}'` },
      { status: 400 },
    );
  }

  const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const skipAbove = parseUnits(SKIP_ABOVE_HUMAN, token.decimals);
  const mintAmount = parseUnits(MINT_HUMAN, token.decimals);

  try {
    const bal = (await pub.readContract({
      address: token.address,
      abi: ERC20_MINT_ABI,
      functionName: "balanceOf",
      args: [to],
    })) as bigint;

    if (bal >= skipAbove) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "already funded",
        balance: bal.toString(),
      });
    }

    const account = privateKeyToAccount(
      (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`,
    );
    const wallet = createWalletClient({
      account,
      chain: sepolia,
      transport: http(RPC),
    });

    const hash = await serialize(() =>
      wallet.writeContract({
        address: token.address,
        abi: ERC20_MINT_ABI,
        functionName: "mint",
        args: [to, mintAmount],
      }),
    );

    return NextResponse.json({
      ok: true,
      hash,
      token: tokenKey,
      minted: mintAmount.toString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `faucet mint failed: ${msg.slice(0, 300)}` },
      { status: 500 },
    );
  }
}
