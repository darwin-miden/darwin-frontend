import { NextResponse } from "next/server";

/**
 * POST /api/network-redeem-note — RETIRED.
 *
 * The old network/slot-10 redeem rail built a note that debited a
 * (userEvm, basket) controller position and paid dUSDC out of the v9.3
 * controller's vault to an emitter-chosen recipient — with the position
 * key, payout amount and recipient all unauthenticated attacker input,
 * and the payout running unconditionally regardless of the (clamped)
 * debit. That is an unauthenticated cross-user vault drain.
 *
 * Redeem now runs on the collateral-bound confidential rail
 * (/api/confidential-redeem): it burns the user's OWN basket tokens and
 * the on-chain note pays out exactly that burned amount from the basket
 * faucet vault. This endpoint is permanently disabled.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "retired — use /api/confidential-redeem" },
    { status: 410 },
  );
}
