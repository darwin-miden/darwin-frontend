import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

/**
 * POST /api/network-redeem-note
 *
 * Body: {
 *   sender: string,     // Miden account hex emitting the request note
 *   recipient: string,  // Miden account hex receiving the payback dUSDC
 *   userEvm: string,    // EVM address whose position gets debited
 *   basket: string,     // DCC | DAG | DCO
 *   amount: string,     // dUSDC base units to withdraw
 * }
 *
 * Returns: { noteId, noteB64, paybackId, paybackFileB64, paybackTag }
 *
 * Builds (never submits) a network REDEEM request note: the NTX builder
 * executes it against the network controller — debits the (user, basket)
 * slot-10 position and pays `amount` dUSDC from the controller vault to
 * `recipient` via a PRIVATE payback P2ID. The browser emits the request
 * from the user's wallet, then imports paybackFileB64 (a serialized
 * NoteFile::NoteDetails — only the redeemer knows the private note's
 * details) and consumes it on commitment. Pure function: no keys, no
 * chain access.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const BUILDER_BIN =
  process.env.DARWIN_NETWORK_REDEEM_BIN ||
  "/Users/eden/data/darwin/repos/darwin-relay/target/release/send_network_redeem";

const NETWORK_CONTROLLER =
  process.env.DARWIN_NETWORK_CONTROLLER_HEX ||
  "0xf421c9b79dbde7312da5261a58107f";

const VALID_BASKETS = new Set(["DCC", "DAG", "DCO"]);

interface Body {
  sender?: string;
  recipient?: string;
  userEvm?: string;
  basket?: string;
  amount?: string;
}

function runBuilder(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(BUILDER_BIN, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    setTimeout(() => child.kill("SIGKILL"), 30_000);
  });
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/network-redeem-note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Bypass-Tunnel-Reminder": "1",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { sender, recipient, userEvm, basket, amount } = body;
  if (!sender || !recipient || !userEvm || !basket || !amount) {
    return NextResponse.json(
      { error: "missing fields: sender, recipient, userEvm, basket, amount" },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]{30}$/.test(sender) || !/^0x[0-9a-fA-F]{30}$/.test(recipient)) {
    return NextResponse.json({ error: "sender/recipient must be Miden account hex" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(userEvm)) {
    return NextResponse.json({ error: "userEvm must be an EVM address" }, { status: 400 });
  }
  if (!VALID_BASKETS.has(basket)) {
    return NextResponse.json({ error: "basket must be DCC, DAG or DCO" }, { status: 400 });
  }
  let amountBig: bigint;
  try {
    amountBig = BigInt(amount);
  } catch {
    return NextResponse.json({ error: "amount must be a base-10 integer string" }, { status: 400 });
  }
  if (amountBig <= 0n || amountBig > 10n ** 12n) {
    return NextResponse.json({ error: "amount out of range" }, { status: 400 });
  }

  const { stdout, stderr, code } = await runBuilder([
    "--emit-json",
    "--target",
    NETWORK_CONTROLLER,
    "--sender",
    sender,
    "--recipient",
    recipient,
    "--user-evm",
    userEvm,
    "--basket",
    basket,
    "--amount",
    amountBig.toString(),
  ]);
  if (code !== 0) {
    return NextResponse.json(
      { error: `note builder exit ${code}: ${(stderr || stdout).slice(-300)}` },
      { status: 500 },
    );
  }
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine);
    return NextResponse.json({ ...parsed, controllerId: NETWORK_CONTROLLER });
  } catch {
    return NextResponse.json(
      { error: "couldn't parse builder output", raw: lastLine.slice(0, 300) },
      { status: 500 },
    );
  }
}
