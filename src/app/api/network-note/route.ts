import { NextResponse } from "next/server";

/**
 * POST /api/network-note — RETIRED.
 *
 * The old network/slot-10 deposit rail built an atomic_deposit note that
 * credited a controller slot-10 position from emitter-controlled storage
 * felts (deposit_value * fee_factor / nav_scale) decoupled from the real
 * drained collateral — an attacker could inflate their position while
 * depositing ~nothing. Superseded by the collateral-bound confidential
 * rail (/api/confidential-note), which mints 1:1 from the REAL drained
 * dUSDC and asserts the collateral is dUSDC. Permanently disabled.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "retired — use /api/confidential-note" },
    { status: 410 },
  );
}
