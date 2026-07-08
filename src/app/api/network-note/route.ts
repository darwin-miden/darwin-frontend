import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

/**
 * POST /api/network-note
 *
 * Body: {
 *   sender: string,    // Miden account hex of the note's emitter (the
 *                      // user's derived wallet)
 *   userEvm: string,   // EVM address whose felts key the slot-10 position
 *   basket: string,    // DCC | DAG | DCO
 *   amount: string,    // dUSDC base units (6-dec) to deposit
 * }
 *
 * Returns: { noteId, noteB64, scriptRoot }
 *
 * Builds (but does NOT submit) an atomic_deposit_note targeting the
 * NETWORK controller, carrying the NetworkAccountTarget attachment the
 * NTX builder requires for routing. The browser deserializes the bytes
 * with the web SDK's Note.deserialize and emits the note itself from
 * the user's derived wallet — proving and submission stay fully
 * client-side; this endpoint is a pure function (no keys, no chain
 * access).
 *
 * Why it exists: the 0.15 web SDK only lets the P2ID helpers carry a
 * NoteAttachment; a custom note script built in the browser can't hold
 * the NetworkAccountTarget attachment, and a tag-only note is invisible
 * to the NTX builder (verified live). Once the SDK exposes attachments
 * on the plain Note constructor this endpoint can be retired.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const BUILDER_BIN =
  process.env.DARWIN_NETWORK_NOTE_BIN ||
  "/Users/eden/data/darwin/repos/darwin-relay/target/release/send_network_deposit";

const NETWORK_CONTROLLER =
  process.env.DARWIN_NETWORK_CONTROLLER_HEX ||
  "0xded5aaaedbd1d55163ac0480838229";

const VALID_BASKETS = new Set(["DCC", "DAG", "DCO"]);

interface Body {
  sender?: string;
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
    const r = await fetch(`${MAC_API_BASE}/api/network-note`, {
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

  const { sender, userEvm, basket, amount } = body;
  if (!sender || !userEvm || !basket || !amount) {
    return NextResponse.json(
      { error: "missing fields: sender, userEvm, basket, amount" },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]{30}$/.test(sender)) {
    return NextResponse.json({ error: "sender must be a Miden account hex" }, { status: 400 });
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
  // The JSON payload is the last stdout line (the root echo precedes it).
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine) as { noteId: string; noteB64: string; scriptRoot: string };
    return NextResponse.json({ ...parsed, controllerId: NETWORK_CONTROLLER });
  } catch {
    return NextResponse.json(
      { error: "couldn't parse builder output", raw: lastLine.slice(0, 300) },
      { status: 500 },
    );
  }
}
