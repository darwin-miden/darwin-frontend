/**
 * POST /api/bridge-out — direct canonical Bali outbound burn.
 *
 * Shells out to gateway-fm/miden-agglayer's `bridge-out-tool` to
 * emit a B2AggNote from the relay wallet to a user-specified
 * Sepolia destination. Same trustless agglayer path the relay v2
 * worker uses for redemptions, but with no basket-burn step —
 * this just bridges already-bridged Bali ETH back out, regardless
 * of any Darwin position state.
 *
 * Custodial note: the relay wallet's MidenFi key signs the burn.
 * For true self-custody Miden→Sepolia withdraw a user would need
 * to run `bridge-out-tool` directly against their own wallet's
 * store — that path is documented in
 * [docs/bali-integration.md](https://darwin-miden.github.io/darwin-docs/bali-integration).
 *
 * Request:  { destAddress: "0x…", amount: number-as-string }
 * Response: { ok: bool, txId?: string, error?: string, stderr?: string }
 *
 * Env:
 *   DARWIN_BRIDGE_OUT_BIN   path to the bridge-out-tool binary
 *   DARWIN_RELAY_STORE_DIR  miden-client store dir (default ~/.miden)
 *   DARWIN_BALI_NODE_URL    Miden RPC (default https://rpc.testnet.miden.io)
 *   DARWIN_RELAY_WALLET_HEX 0xed3cd5be…
 *   DARWIN_BALI_BRIDGE_HEX  0xc98bb07c…
 *   DARWIN_BALI_FAUCET_HEX  0xe63ba7bc…
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";

export const runtime = "nodejs";

const DEFAULT_BIN = "/Users/eden/data/darwin/repos/miden-agglayer/target/release/bridge-out-tool";
const DEFAULT_STORE = `${homedir()}/.miden`;
const DEFAULT_NODE = "https://rpc.testnet.miden.io";
const DEFAULT_RELAY = "0xed3cd5befa3207805f8529207cfc0d";
const DEFAULT_BRIDGE = "0xc98bb07c188cd2500e13f68a069cdc";
const DEFAULT_FAUCET = "0xe63ba7bc2c19ff603c52c67fa4426d";

interface ReqBody {
  destAddress: string;
  amount: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => {
      ch.kill("SIGTERM");
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ch.stdout.on("data", (b) => (stdout += b.toString()));
    ch.stderr.on("data", (b) => (stderr += b.toString()));
    ch.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code });
    });
    ch.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

export async function POST(req: Request) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { destAddress, amount } = body;
  if (!/^0x[0-9a-fA-F]{40}$/.test(destAddress ?? "")) {
    return Response.json({ ok: false, error: "destAddress must be a 20-byte hex" }, { status: 400 });
  }
  if (!/^\d+$/.test(amount ?? "") || amount === "0") {
    return Response.json({ ok: false, error: "amount must be a positive integer" }, { status: 400 });
  }

  const bin = process.env.DARWIN_BRIDGE_OUT_BIN ?? DEFAULT_BIN;
  const storeDir = process.env.DARWIN_RELAY_STORE_DIR ?? DEFAULT_STORE;
  const nodeUrl = process.env.DARWIN_BALI_NODE_URL ?? DEFAULT_NODE;
  const wallet = process.env.DARWIN_RELAY_WALLET_HEX ?? DEFAULT_RELAY;
  const bridge = process.env.DARWIN_BALI_BRIDGE_HEX ?? DEFAULT_BRIDGE;
  const faucet = process.env.DARWIN_BALI_FAUCET_HEX ?? DEFAULT_FAUCET;

  try {
    const { stdout, stderr, code } = await run(
      bin,
      [
        "--store-dir", storeDir,
        "--node-url", nodeUrl,
        "--wallet-id", wallet,
        "--bridge-id", bridge,
        "--faucet-id", faucet,
        "--amount", amount,
        "--dest-address", destAddress,
        "--dest-network", "0",
      ],
      120_000,
    );
    if (code !== 0) {
      return Response.json(
        { ok: false, error: `bridge-out-tool exit ${code}`, stderr },
        { status: 502 },
      );
    }
    // Parse the tx id out of the tool's stdout. It prints lines like
    //   [bridge-out] transaction submitted: 0xabc…
    const match = stdout.match(/transaction submitted:\s*(0x[0-9a-f]+)/i);
    const txId = match?.[1];
    return Response.json({ ok: true, txId, stdout });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
