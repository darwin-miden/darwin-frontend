import { NextResponse } from "next/server";

/**
 * Edge gate for operator-only tooling.
 *
 * `/admin/*` (the drift dashboard) must never be reachable on the public
 * production surface. A client-side `notFound()` inside the page only
 * fires after hydration, so the prerendered HTML still serves with a 200 —
 * this middleware returns a real 404 at the edge instead. Left reachable
 * under `next dev` (NODE_ENV !== "production") so the operator can still
 * use it locally.
 */
export function middleware() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not Found", { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/admin/:path*",
};
