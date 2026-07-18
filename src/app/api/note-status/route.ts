/**
 * GET /api/note-status?id=0x…  —  is this note committed on-chain yet?
 *
 * Returns { committed: boolean }. The faucet polls this after emitting a drip so
 * the browser knows when the PUBLIC payout note is on-chain and can be consumed —
 * WITHOUT a wallet prompt (the in-browser RpcClient path hits WASM marshalling
 * bugs, so we ask a tiny server-side binary that queries the node RPC instead).
 * Pure read — no keys, no signing.
 */
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const BIN =
  process.env.DARWIN_NOTE_COMMITTED_BIN ||
  "/Users/eden/data/darwin/repos/darwin-protocol/target/release/note_committed";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
    return NextResponse.json({ error: "invalid note id" }, { status: 400 });
  }

  // On Vercel the binary isn't present — proxy to the operator host.
  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/note-status?id=${id}`, {
      headers: { "Bypass-Tunnel-Reminder": "1" },
    });
    return new NextResponse(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const out = await new Promise<string>((resolve) => {
    const child = spawn(BIN, [id]);
    let s = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (d) => (s += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("error");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(s.trim());
    });
  });

  return NextResponse.json({ committed: out.includes("committed") });
}
