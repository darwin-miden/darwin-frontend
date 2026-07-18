import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

import {
  acquireSlot,
  busySlot,
  keyLimit,
  rateLimit,
  rateLimited,
  redact,
  releaseSlot,
} from "../../../../lib/apiGuard";
import { ASSET_FAUCETS, EPOCH_DUSDC_FAUCET_ID } from "../../../../lib/midenConstants";

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

// On Vercel the operator's miden-client doesn't exist; proxy to the
// operator's host (set via DARWIN_MAC_API_BASE) with the bypass header
// the localtunnel proxy needs to skip its HTML warning interstitial.
const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const MIDEN_CLIENT =
  process.env.DARWIN_MIDEN_CLIENT_BIN ||
  "/Users/eden/Library/Application Support/midenup/toolchains/0.15.0/bin/miden-client";

// Wallet that holds a reserve of real (bridged) Epoch dUSDC. A dUSDC drip is a
// TRANSFER from this wallet (`send`), not a mint — we don't own Epoch's faucet
// key, so this is how both rails end up sharing the exact same dUSDC token.
const DUSDC_DISPENSER_ID = process.env.DARWIN_DUSDC_DISPENSER_ID;

// Allowlist of faucet IDs we'll dispense. Anything else → 400. Avoids the panel
// being repurposed to drain arbitrary faucets in the operator's store. Derived
// from the ACTIVE asset set (ASSET_FAUCETS follows NEXT_PUBLIC_MIDEN_V015) so it
// can't drift from the ids the frontend actually drips — a hardcoded V014 list
// silently rejected every V015 drip ("faucetId not in allowlist"). Plus Epoch's
// dUSDC, which is dispensed by transfer from DUSDC_DISPENSER_ID rather than minted.
const ALLOWED_FAUCETS = new Set([
  ...Object.values(ASSET_FAUCETS).map((f) => f.id),
  EPOCH_DUSDC_FAUCET_ID,
]);

// 1e18 = enough for one 1.0 unit drip of an 18-decimal asset (dETH/dDAI).
// 6-/8-decimal faucets (dUSDT/dWBTC) request much smaller numbers so the
// effective ceiling is per-faucet supply, not this constant.
const MAX_AMOUNT_PER_REQUEST = 1_000_000_000_000_000_000n;

function runMint(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    // Point the client at the dedicated asset-faucet store (which holds the
    // V015 faucet accounts + their signing keys) via HOME, if configured.
    // Falls back to the default HOME store otherwise.
    const faucetHome = process.env.DARWIN_FAUCET_MIDEN_HOME;
    const env = faucetHome ? { ...process.env, HOME: faucetHome } : process.env;
    const child = spawn(MIDEN_CLIENT, args, { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
  if (!rateLimit(req)) return rateLimited();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Proxy mode (Vercel) — forward to the operator's host with the
  // localtunnel bypass header so the warning interstitial is skipped.
  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/faucet/mint`, {
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
  // Sanity-check the target shape before it reaches spawn argv (defense in
  // depth — it's a single argv element so not injectable, but reject junk).
  if (!/^(0x)?[0-9a-zA-Z]{6,120}$/.test(target)) {
    return NextResponse.json({ error: "target has an invalid format" }, { status: 400 });
  }
  // Per-target drip cap: bound minting to a given wallet even across many
  // (spoofable-in-theory) source IPs, so the operator's testnet faucets
  // can't be slowly drained.
  if (!keyLimit(`mint:${faucetId}:${target}`, 5)) {
    return NextResponse.json(
      { error: "mint drip cap for this target reached — retry later" },
      { status: 429 },
    );
  }
  // Per-faucet cap: bound the TOTAL drain of a faucet across ALL targets,
  // so rotating the recipient wallet can't sidestep the per-target cap.
  if (!keyLimit(`mint:${faucetId}`, 60)) {
    return NextResponse.json(
      { error: "faucet drip cap reached — retry later" },
      { status: 429 },
    );
  }

  const targetHex = decodeBech32ToHex(target);

  // Epoch dUSDC is dispensed by TRANSFER from the reserve wallet, not minted
  // (we don't own Epoch's faucet key). Everything else is a faucet mint.
  const isDusdc = faucetId === EPOCH_DUSDC_FAUCET_ID;
  if (isDusdc && !DUSDC_DISPENSER_ID) {
    return NextResponse.json(
      { error: "dUSDC dispenser not configured (DARWIN_DUSDC_DISPENSER_ID)" },
      { status: 503 },
    );
  }

  if (!acquireSlot()) return busySlot();
  let stdout: string, stderr: string, code: number | null;
  try {
    // Keep the dedicated faucet store fresh — a stale/fresh store fails the
    // tx-input fetch ("block N not found"). Incremental after the first sync,
    // so this is fast. Best-effort: the mint itself surfaces real errors.
    await runMint(["sync"]);
    ({ stdout, stderr, code } = await runMint(
      isDusdc
        ? [
            "send",
            "-s", DUSDC_DISPENSER_ID!,
            "-t", targetHex,
            "-a", `${amount.toString()}::${faucetId}`,
            "-n", "public",
            "--force",
          ]
        : [
            "mint",
            "-t", targetHex,
            "-a", `${amount.toString()}::${faucetId}`,
            "-n", "public",
            "--force",
          ],
    ));
  } finally {
    releaseSlot();
  }

  if (code !== 0) {
    console.error("[faucet/mint] mint failed", code, stderr || stdout);
    // Surface the last interesting line — the miden-client banner
    // tends to wrap long blocks; the user just needs the verdict.
    const lastErr = (stderr + stdout)
      .split("\n")
      .filter((l) => /assertion|error|failed|✗|×/i.test(l))
      .slice(-3)
      .join(" / ");
    return NextResponse.json(
      { error: redact(lastErr) || `miden-client exit ${code}` },
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
