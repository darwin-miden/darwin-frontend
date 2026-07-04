import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

/**
 * POST /api/position
 *
 * Body: { suffix: string, prefix: string }
 *   — base-10 stringified u64 field elements that form the
 *     `(user_id_suffix, user_id_prefix)` half of the controller's
 *     slot-10 StorageMap key.
 *
 * Returns: { position: string }
 *   — base-units bigint as a string, ready for BigInt() on the client.
 *
 * Why this exists: the v6 fee-routing controller (the one carrying
 * slot-10) is `storage_mode = private`. Browser miden-clients can't
 * see its storage, so `exec.execute(controller, get_user_position)`
 * always comes back empty for non-operator nodes. The Darwin operator
 * runs miden-client locally on the same box that serves this API, so
 * the read can resolve there and be returned over plain HTTP.
 *
 * Node runtime — needs child_process + fs.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// When deployed on Vercel the operator's miden-client doesn't exist,
// so this route proxies to the operator's host (Mac) via the URL in
// DARWIN_MAC_API_BASE. The bypass-tunnel-reminder header is what
// localtunnel checks to skip its warning interstitial; without it
// Vercel's outbound fetch would receive the HTML reminder page and
// time out waiting for JSON.
const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const MIDEN_CLIENT =
  process.env.DARWIN_MIDEN_CLIENT_BIN ||
  "/Users/eden/Library/Application Support/midenup/toolchains/0.14.0/bin/miden-client";

// 2026-06-23: testnet was migrated to v0.15. The v0.14 hex
// 0xbef7d2e8… is no longer reachable on the new testnet — use the
// freshly redeployed v0.15 controller as the default. Override via
// DARWIN_CONTROLLER_HEX for any other deployment.
const CONTROLLER_ID =
  process.env.DARWIN_CONTROLLER_HEX || "0x6687e59f895c7e3115c654ca7ccbbb";

// MAST root of `get_user_position` on the v7 controller — pinned in
// midenController.ts and mirrored here so the server doesn't need to
// reach into client-side TS to know which proc to call.
//
// 2026-06-23: v0.15 MAST rotation. Wire format 0.0.2 → 0.0.3 rehashes
// every procedure root. The v0.14 root (0xc9ccec54…) is no longer
// callable against the new controller.
const GET_USER_POSITION_MAST_ROOT =
  "0x47b239ea11ad0375cca5a082369f721729c6d63a1fb170e6b5be5755dd06301f";

// Field-element max (Goldilocks p = 2^64 - 2^32 + 1). Both suffix +
// prefix must fit comfortably inside u64 well below this; AccountId
// felts have their high bit unused so the practical bound is 2^63.
const FELT_MAX = (1n << 64n) - (1n << 32n) + 1n;

function buildReadScript(
  suffix: bigint,
  prefix: bigint,
  basketSuffix: bigint,
  basketPrefix: bigint,
): string {
  // Key layout = [basket_prefix, basket_suffix, user_prefix,
  // user_suffix] (top-down) — must mirror the atomic_deposit_note_v2
  // set_user_position write. basket_id felts make the slot per-(user,
  // basket); without them every basket row reads the same slot.
  //
  // The stored value word is [0, 0, 0, amount]; sum the four felts so
  // amount lands on top regardless of which felt holds it. truncate_stack
  // pins depth at 16 so the runner doesn't reject a deep stack.
  return `use miden::core::sys

begin
  push.${suffix.toString()} push.${prefix.toString()}
  push.${basketSuffix.toString()} push.${basketPrefix.toString()}
  call.${GET_USER_POSITION_MAST_ROOT}
  add add add
  exec.sys::truncate_stack
end
`;
}

function runExec(scriptPath: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    // miden-client resolves ${HOME}/.miden/store.sqlite3 for its account
    // + note cache. On the operator's Mac the v0.15 controller (with its
    // Falcon-512 keystore, from the fresh redeploy) lives under the
    // relay's permanent HOME — override HOME on spawn so we point at
    // that store instead of the legacy ~/.miden which still has the
    // v0.14 chain state and would fail to parse v0.15 account IDs.
    const midenHome = process.env.DARWIN_MIDEN_HOME;
    const spawnEnv = midenHome ? { ...process.env, HOME: midenHome } : process.env;
    const child = spawn(
      MIDEN_CLIENT,
      ["exec", "-a", CONTROLLER_ID, "-s", scriptPath],
      { env: spawnEnv },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    setTimeout(() => child.kill("SIGKILL"), 60_000);
  });
}

interface Body {
  suffix?: string;
  prefix?: string;
  basketSuffix?: string;
  basketPrefix?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Proxy mode (Vercel) — forward the body verbatim to the operator's
  // host with the localtunnel bypass header. The local route below
  // still runs on the operator's Mac where miden-client is available.
  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/position`, {
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
      { error: "missing fields: suffix, prefix (base-10 u64 strings)" },
      { status: 400 },
    );
  }

  let suffix: bigint;
  let prefix: bigint;
  let basketSuffix: bigint;
  let basketPrefix: bigint;
  try {
    suffix = BigInt(body.suffix);
    prefix = BigInt(body.prefix);
    // basketSuffix / basketPrefix default to 0 so existing callers
    // that haven't been updated still get the legacy single-slot read.
    basketSuffix = body.basketSuffix ? BigInt(body.basketSuffix) : 0n;
    basketPrefix = body.basketPrefix ? BigInt(body.basketPrefix) : 0n;
  } catch {
    return NextResponse.json(
      { error: "suffix/prefix/basketSuffix/basketPrefix must be base-10 stringified bigints" },
      { status: 400 },
    );
  }
  const allFelts = [suffix, prefix, basketSuffix, basketPrefix];
  if (allFelts.some((f) => f < 0n || f >= FELT_MAX)) {
    return NextResponse.json(
      { error: "felts must be valid field elements" },
      { status: 400 },
    );
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "darwin-pos-"));
  const scriptPath = path.join(tmpDir, "read_slot10.masm");
  try {
    await writeFile(
      scriptPath,
      buildReadScript(suffix, prefix, basketSuffix, basketPrefix),
      "utf8",
    );
    const { stdout, stderr, code } = await runExec(scriptPath);
    if (code !== 0) {
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
    // v0.15 output format is a single "Result: <amount>" line — the
    // v0.14 "Output stack: ├── 0: …" tree was collapsed to just the
    // truncate_stack top. v0.14 fallback pattern kept for safety.
    const m = stdout.match(/Result:\s*(\d+)/) ?? stdout.match(/0:\s*(\d+)/);
    if (!m) {
      return NextResponse.json(
        { error: "couldn't parse position from miden-client output", raw: stdout.slice(0, 500) },
        { status: 500 },
      );
    }
    return NextResponse.json({ position: m[1] });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
