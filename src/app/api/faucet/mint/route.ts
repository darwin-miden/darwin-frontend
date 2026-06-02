import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

/**
 * POST /api/faucet/mint
 *
 * Body: { target: string, faucetId: string, amount: string }
 *
 * Invokes the local miden-client CLI to mint a public P2ID note from
 * the named asset faucet to the requested target wallet. The
 * operator's miden-client store (and the faucet operator keys) live
 * on the host's `~/.miden/` — there's no network exposure of those
 * keys, just the CLI subprocess.
 *
 * Strict per-asset drip caps + per-IP rate-limit could be layered on
 * top in a hardened deployment; for the M3 testnet helper it's
 * deliberately bare so the loop "click → mint → consume → deposit"
 * has minimum latency.
 *
 * Node runtime (not Edge) — needs child_process.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIDEN_CLIENT =
  process.env.DARWIN_MIDEN_CLIENT_BIN ||
  "/Users/eden/Library/Application Support/midenup/toolchains/0.14.0/bin/miden-client";

// Allowlist of faucet IDs we'll mint from. Anything else → 400. Avoids
// the panel being repurposed to mint from arbitrary user-supplied
// faucets that happen to be in the operator's store.
const ALLOWED_FAUCETS = new Set([
  "0x9ecd63df21c64f2029429a6337a712", // dETH
  "0x2357c29fd5ed992038b0c44bf54aaf", // dWBTC
  "0xd3789f451ddd4720602ba9eb1a268d", // dUSDT
  "0x619df5d889019020782e804eb60d0b", // dDAI
]);

// 1e18 = enough for one 1.0 unit drip of an 18-decimal asset (dETH/dDAI).
// 6-/8-decimal faucets (dUSDT/dWBTC) request much smaller numbers so the
// effective ceiling is per-faucet supply, not this constant.
const MAX_AMOUNT_PER_REQUEST = 1_000_000_000_000_000_000n;

function runMint(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(MIDEN_CLIENT, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    setTimeout(() => child.kill("SIGKILL"), 60_000);
  });
}

function decodeBech32ToHex(input: string): string {
  // Mirror of the deposit-panel sniff. If it already looks hex, return
  // as-is. Otherwise, hand it to miden-client which understands bech32
  // for the --target flag.
  if (/^0x[0-9a-f]+$/i.test(input)) return input;
  return input;
}

interface Body {
  target?: string;
  faucetId?: string;
  amount?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const target = body.target?.trim();
  const faucetId = body.faucetId?.trim();
  const amountStr = body.amount?.trim();

  if (!target || !faucetId || !amountStr) {
    return NextResponse.json(
      { error: "missing fields: target, faucetId, amount" },
      { status: 400 },
    );
  }
  if (!ALLOWED_FAUCETS.has(faucetId)) {
    return NextResponse.json({ error: "faucetId not in allowlist" }, { status: 400 });
  }
  let amount: bigint;
  try {
    amount = BigInt(amountStr);
  } catch {
    return NextResponse.json({ error: "amount must be a base-units bigint string" }, { status: 400 });
  }
  if (amount <= 0n || amount > MAX_AMOUNT_PER_REQUEST) {
    return NextResponse.json(
      { error: `amount must be 1..${MAX_AMOUNT_PER_REQUEST}` },
      { status: 400 },
    );
  }

  const targetHex = decodeBech32ToHex(target);

  const { stdout, stderr, code } = await runMint([
    "mint",
    "-t", targetHex,
    "-a", `${amount.toString()}::${faucetId}`,
    "-n", "public",
    "--force",
  ]);

  if (code !== 0) {
    // Surface the last interesting line — the miden-client banner
    // tends to wrap long blocks; the user just needs the verdict.
    const lastErr = (stderr + stdout)
      .split("\n")
      .filter((l) => /assertion|error|failed|✗|×/i.test(l))
      .slice(-3)
      .join(" / ");
    return NextResponse.json(
      { error: lastErr || `miden-client exit ${code}` },
      { status: 500 },
    );
  }

  // Parse "Transaction ID: 0x…" and the first output note id from the
  // CLI's structured output.
  const txMatch = stdout.match(/Transaction ID:\s*(0x[a-f0-9]+)/i);
  const noteMatch = stdout.match(/Output notes:\s*\n\s*-\s*(0x[a-f0-9]+)/i);
  return NextResponse.json({
    txId: txMatch?.[1] ?? null,
    noteId: noteMatch?.[1] ?? null,
  });
}
