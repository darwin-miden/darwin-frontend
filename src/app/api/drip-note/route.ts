/**
 * POST /api/drip-note  —  build a permissionless dUSDC drip request.
 *
 * Body: { requester: string }  (the user's Miden account id, hex)
 *
 * Returns { noteId, noteB64, payoutId, payoutFileB64 }. The browser emits the
 * drip note from the user's own wallet, waits ~30s for the NTX builder to run it
 * against the on-chain dispenser (which pays out a fixed 5 dUSDC), then imports
 * the payout note file and consumes it. Pure builder — no keys, no server-side
 * signing. This is the permissionless path (vs the server-side send in
 * /api/faucet/mint): the DISPENSER contract pays out, driven by the network.
 */
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const BUILDER_BIN =
  process.env.DARWIN_BUILD_DRIP_NOTE_BIN ||
  "/Users/eden/data/darwin/repos/darwin-protocol/target/release/build_drip_note";

// The permissionless dUSDC dispenser (network account holding bridged Epoch dUSDC).
const DISPENSER_ID = process.env.DARWIN_DRIP_DISPENSER_ID;

function runBuilder(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(BUILDER_BIN, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
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
  let body: { requester?: string };
  try {
    body = (await req.json()) as { requester?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // On Vercel the builder binary isn't present — proxy to the operator host.
  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/drip-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "1" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const requester = body.requester?.trim();
  // Accept hex (0x…) or bech32 (mtst1…). Keep it to safe argv chars (no shell
  // metacharacters) but let the builder do the real id validation.
  if (!requester || !/^[0-9a-zA-Z]{6,200}$/.test(requester)) {
    return NextResponse.json(
      { error: `invalid requester id (got: ${JSON.stringify(requester)?.slice(0, 80)})` },
      { status: 400 },
    );
  }
  if (!DISPENSER_ID) {
    return NextResponse.json(
      { error: "drip dispenser not configured (DARWIN_DRIP_DISPENSER_ID)" },
      { status: 503 },
    );
  }

  const { stdout, stderr, code } = await runBuilder([requester, DISPENSER_ID]);
  if (code !== 0) {
    return NextResponse.json(
      { error: `build_drip_note exit ${code}: ${(stderr || stdout).slice(0, 300)}` },
      { status: 500 },
    );
  }
  try {
    const line = stdout
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    const parsed = JSON.parse(line ?? "{}");
    return NextResponse.json({ ...parsed, dispenser: DISPENSER_ID });
  } catch {
    return NextResponse.json(
      { error: "could not parse builder output" },
      { status: 500 },
    );
  }
}
