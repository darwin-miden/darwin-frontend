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
import { CONFIDENTIAL_FAUCETS } from "../../../lib/confidentialFaucets";

/**
 * POST /api/confidential-note
 *
 * Body: { sender, recipient, basket, amount }  (amount = dUSDC base units)
 * Returns: { noteId, noteB64, paybackId, paybackFileB64, mintAmount, faucetId }
 *
 * Builds (never submits) a confidential_deposit_note: the browser emits
 * it at the basket faucet-network account carrying dUSDC collateral; the
 * NTX builder drains the collateral and mints basket tokens into a
 * PRIVATE note for the recipient. mint_amount is priced at the live NAV
 * (fetched here). Pure function — no keys, no chain access.
 *
 * This is the v10 confidential deposit — replaces the public slot-10
 * ledger with private token balances (the grant's Flow A).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const BUILDER_BIN =
  process.env.DARWIN_CONFIDENTIAL_DEPOSIT_BIN ||
  "/Users/eden/data/darwin/repos/darwin-relay/target/release/send_confidential_deposit";

interface Body {
  sender?: string;
  recipient?: string;
  basket?: string;
  amount?: string;
}

function runBuilder(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(BUILDER_BIN, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
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
    const r = await fetch(`${MAC_API_BASE}/api/confidential-note`, {
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
  if (!Object.prototype.hasOwnProperty.call(CONFIDENTIAL_FAUCETS, basket)) {
    return NextResponse.json({ error: "basket must be DCC, DAG or DCO" }, { status: 400 });
  }
  const faucetId = CONFIDENTIAL_FAUCETS[basket];
  let amountBig: bigint;
  try {
    amountBig = BigInt(amount);
  } catch {
    return NextResponse.json({ error: "amount must be an integer string" }, { status: 400 });
  }
  if (amountBig <= 0n || amountBig > 10n ** 12n) {
    return NextResponse.json({ error: "amount out of range" }, { status: 400 });
  }

  // The confidential mint is 1:1 in base units by design: the on-chain
  // note mints from the REAL drained collateral and ignores every NAV/fee
  // storage felt (post-audit hardening), and redeem conserves exactly. So
  // there is no NAV to fetch or apply here — mintAmount == amount. (The
  // builder still takes --fee-factor/--nav-scale but treats them as dead
  // no-ops; we pass 1/1 so the note storage is deterministic.)

  if (!acquireSlot()) return busySlot();
  let stdout: string, stderr: string, code: number | null;
  try {
    ({ stdout, stderr, code } = await runBuilder([
      "--emit-json",
      "--faucet",
      faucetId,
      "--sender",
      sender,
      "--recipient",
      recipient,
      "--amount",
      amountBig.toString(),
      "--fee-factor",
      "1",
      "--nav-scale",
      "1",
    ]));
  } finally {
    releaseSlot();
  }
  if (code !== 0) {
    console.error("[confidential-note] builder failed", code, stderr || stdout);
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
    console.error("[confidential-note] unparseable builder output", lastLine);
    return NextResponse.json({ error: "couldn't parse builder output", raw: redact(lastLine.slice(0, 300)) }, { status: 500 });
  }
}
