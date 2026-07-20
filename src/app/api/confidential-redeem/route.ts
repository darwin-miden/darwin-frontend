import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

import {
  acquireSlot,
  busySlot,
  rateLimit,
  rateLimited,
  redact,
  releaseSlot,
} from "../../../lib/apiGuard";
import {
  BASKET_FAUCETS,
  basketFaucetId,
  isNavBasket,
} from "../../../lib/basketFaucets";

/**
 * POST /api/confidential-redeem
 *
 * Body: { sender, recipient, basket, amount }  (amount = basket-token base units)
 * Returns: { noteId, noteB64, paybackId, paybackFileB64, releaseAmount, faucetId }
 *
 * Builds (never submits) a confidential_redeem_note: the browser emits it
 * at the basket faucet-network account carrying the user's basket tokens;
 * the NTX builder burns them and releases the pro-rata dUSDC into a
 * PRIVATE payback note for the recipient. Symmetric to /api/confidential-note
 * (deposit). Pure function — no keys, no chain access. This is the v10
 * confidential redeem, replacing the old /api/network-redeem-note rail.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const BUILDER_BIN =
  process.env.DARWIN_CONFIDENTIAL_REDEEM_BIN ||
  "/Users/eden/data/darwin/repos/darwin-relay/target/release/send_confidential_redeem";

// NAV redeem builder: burns shares and releases dUSDC at the live NAV
// (release = shares × V / S / 100). Reads supply + vault value on-chain, so it
// needs a longer timeout than the flat 1:1 builder.
const NAV_REDEEM_BIN =
  process.env.DARWIN_NAV_REDEEM_BIN ||
  "/Users/eden/data/darwin/repos/darwin-relay/target/release/send_nav_redeem";

interface Body {
  sender?: string;
  recipient?: string;
  basket?: string;
  amount?: string;
}

function runBuilder(
  bin: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    // Without this, a missing/non-exec binary emits an unhandled 'error'
    // that crashes `next start` and leaks the acquired semaphore slot.
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e), code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export async function POST(req: Request) {
  if (!rateLimit(req)) return rateLimited();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/confidential-redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "1" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return new NextResponse(text, { status: r.status, headers: { "Content-Type": "application/json" } });
  }

  const { sender, recipient, basket, amount } = body;
  if (!sender || !recipient || !basket || !amount) {
    return NextResponse.json({ error: "missing fields: sender, recipient, basket, amount" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{30}$/.test(sender) || !/^0x[0-9a-fA-F]{30}$/.test(recipient)) {
    return NextResponse.json({ error: "sender/recipient must be Miden account hex" }, { status: 400 });
  }
  if (!Object.prototype.hasOwnProperty.call(BASKET_FAUCETS, basket)) {
    return NextResponse.json({ error: "basket must be DCC, DAG or DCO" }, { status: 400 });
  }
  const isNav = isNavBasket(basket);
  const faucetId = basketFaucetId(basket)!;
  let amountBig: bigint;
  try {
    amountBig = BigInt(amount);
  } catch {
    return NextResponse.json({ error: "amount must be an integer string" }, { status: 400 });
  }
  if (amountBig <= 0n || amountBig > 10n ** 12n) {
    return NextResponse.json({ error: "amount out of range" }, { status: 400 });
  }

  if (!acquireSlot()) return busySlot();
  const args = [
    "--emit-json",
    "--faucet",
    faucetId,
    "--sender",
    sender,
    "--recipient",
    recipient,
    "--amount",
    amountBig.toString(),
  ];
  let stdout: string, stderr: string, code: number | null;
  try {
    // NAV baskets burn shares → dUSDC at the live NAV (reads on-chain, 90s).
    // Others use the flat 1:1 confidential redeem.
    ({ stdout, stderr, code } = isNav
      ? await runBuilder(NAV_REDEEM_BIN, args, 90_000)
      : await runBuilder(BUILDER_BIN, args));
  } finally {
    releaseSlot();
  }
  if (code !== 0) {
    console.error("[confidential-redeem] builder failed", code, stderr || stdout);
    return NextResponse.json(
      { error: `builder exit ${code}: ${redact((stderr || stdout).slice(-300))}` },
      { status: 500 },
    );
  }
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(lastLine);
    return NextResponse.json({ ...parsed, faucetId });
  } catch {
    console.error("[confidential-redeem] unparseable builder output", lastLine);
    return NextResponse.json({ error: "couldn't parse builder output", raw: redact(lastLine.slice(0, 300)) }, { status: 500 });
  }
}
