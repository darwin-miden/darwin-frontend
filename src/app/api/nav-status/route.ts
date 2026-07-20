import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

import { rateLimit, rateLimited, redact } from "../../../lib/apiGuard";
import { basketFaucetId, isNavBasket } from "../../../lib/basketFaucets";

/**
 * GET /api/nav-status?basket=DCC
 *
 * Returns the NAV basket faucet's live on-chain state:
 *   { faucet, supply, vaultValueUsdX1e8, navPerShareUsd }
 *
 * navPerShareUsd = vault value / supply — the USD value of one basket share,
 * computed from the vault's REAL constituent holdings priced at the live feed
 * (compute_v). The portfolio multiplies a position's shares by this to get its
 * current value, so it tracks the NAV instead of the deposit amount.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;

const STATUS_BIN =
  process.env.DARWIN_NAV_STATUS_BIN ||
  "/Users/eden/data/darwin/repos/darwin-relay/target/release/nav_status";

function run(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(STATUS_BIN, args);
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });
}

export async function GET(req: Request) {
  if (!rateLimit(req)) return rateLimited();
  const basket = new URL(req.url).searchParams.get("basket") ?? "DCC";
  if (!isNavBasket(basket)) {
    return NextResponse.json({ error: "not a NAV basket" }, { status: 400 });
  }

  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/nav-status?basket=${basket}`, {
      headers: { "Bypass-Tunnel-Reminder": "1" },
    });
    return new NextResponse(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { stdout, code } = await run(["--faucet", basketFaucetId(basket)!]);
  if (code !== 0) {
    return NextResponse.json({ error: `nav_status exit ${code}` }, { status: 500 });
  }
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  try {
    return NextResponse.json(JSON.parse(lastLine));
  } catch {
    return NextResponse.json(
      { error: "couldn't parse nav_status", raw: redact(lastLine.slice(0, 200)) },
      { status: 500 },
    );
  }
}
