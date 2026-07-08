import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

/**
 * POST /api/network-position
 *
 * Body: { suffix, prefix, basketSuffix?, basketPrefix? } — base-10
 * stringified u64 felts, same contract as /api/position.
 *
 * Returns: { position: string }
 *
 * Reads the NETWORK controller's slot-10 map. The regular /api/position
 * path (miden-client CLI exec) can't read this account: the CLI 0.15.0
 * rejects the account code published by the 0.15.2 lib
 * (UntrustedMastForest STRIPPED/HASHLESS wire skew). This route spawns
 * the read_v9_position binary instead, which tracks the account in its
 * dedicated store and reads the map locally after a sync.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const READER_BIN =
  process.env.DARWIN_NETWORK_READER_BIN ||
  "/Users/eden/data/darwin/repos/darwin-protocol/target/release/read_v9_position";

const NETWORK_CONTROLLER =
  process.env.DARWIN_NETWORK_CONTROLLER_HEX ||
  "0xf421c9b79dbde7312da5261a58107f";

interface Body {
  suffix?: string;
  prefix?: string;
  basketSuffix?: string;
  basketPrefix?: string;
}

/** LE-hex of one u64 felt (8 bytes), matching Word's display order. */
function feltLeHex(v: bigint): string {
  let out = "";
  for (let i = 0n; i < 8n; i++) {
    out += Number((v >> (8n * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

function runReader(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(READER_BIN, ["--account", NETWORK_CONTROLLER, "--json"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    setTimeout(() => child.kill("SIGKILL"), 60_000);
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
    const r = await fetch(`${MAC_API_BASE}/api/network-position`, {
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

  if (!body.suffix || !body.prefix) {
    return NextResponse.json(
      { error: "missing fields: suffix, prefix" },
      { status: 400 },
    );
  }
  let suffix: bigint, prefix: bigint, bSuffix: bigint, bPrefix: bigint;
  try {
    suffix = BigInt(body.suffix);
    prefix = BigInt(body.prefix);
    bSuffix = body.basketSuffix ? BigInt(body.basketSuffix) : 0n;
    bPrefix = body.basketPrefix ? BigInt(body.basketPrefix) : 0n;
  } catch {
    return NextResponse.json(
      { error: "felts must be base-10 stringified bigints" },
      { status: 400 },
    );
  }

  const { stdout, stderr, code } = await runReader();
  if (code !== 0) {
    return NextResponse.json(
      { error: `reader exit ${code}: ${(stderr || stdout).slice(-200)}` },
      { status: 500 },
    );
  }
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  let parsed: { entries: Array<{ key: string; amount: string }> };
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return NextResponse.json(
      { error: "couldn't parse reader output", raw: lastLine.slice(0, 200) },
      { status: 500 },
    );
  }
  // Map key Word displays as the LE bytes of
  // [basket_prefix, basket_suffix, user_prefix, user_suffix] — mirror of
  // the atomic_deposit_note write order.
  const wantedKey =
    "0x" + feltLeHex(bPrefix) + feltLeHex(bSuffix) + feltLeHex(prefix) + feltLeHex(suffix);
  const hit = parsed.entries.find((e) => e.key.toLowerCase() === wantedKey);
  return NextResponse.json({ position: hit?.amount ?? "0" });
}
