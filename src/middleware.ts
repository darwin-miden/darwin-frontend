import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Two jobs:
 *  1. Edge-gate operator-only tooling: `/admin/*` (the drift dashboard) must never be
 *     reachable on the public production surface. A client-side `notFound()` only fires
 *     after hydration (the prerendered HTML still serves 200), so we 404 at the edge.
 *     Left reachable under `next dev` so the operator can use it locally.
 *  2. Content-Security-Policy. `script-src` uses 'unsafe-inline' (not a nonce): Next
 *     STATICALLY prerenders the pages (e.g. /para), and a per-request middleware nonce
 *     cannot be injected into already-baked HTML — a nonce CSP then blocks the static
 *     pages' inline bootstrap scripts, so React never hydrates → blank page. Allowing
 *     inline scripts keeps the app working while the rest of the CSP (default-src 'self',
 *     object-src/frame-ancestors 'none', a connect-src allowlist, …) still constrains it.
 */

function buildCsp(): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // 'unsafe-inline' (see header note — nonce CSP is incompatible with static prerender).
    // 'wasm-unsafe-eval' for the STARK prover; dev adds 'unsafe-eval' for React-Refresh/HMR.
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline `style=` attributes are used throughout (React inline styles); nonce-ing every
    // one isn't feasible, so style-src keeps 'unsafe-inline' (styles can't exfil a key).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-src 'self' blob: https://*.getpara.com https://*.usecapsule.com",
    [
      "connect-src 'self' blob: data:",
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://ethereum-rpc.publicnode.com",
      "https://*.miden.io",
      "https://faucet.testnet.miden.io",
      "https://testnet-dev.epochprotocol.xyz",
      "https://11155111.rpc.thirdweb.com",
      "https://miden-testnet-bridge.dev.eu-north-3.gateway.fm",
      "https://api.coingecko.com",
      "wss://relay.walletconnect.com",
      "https://*.walletconnect.com",
      "https://*.walletconnect.org",
      "https://*.reown.com",
      "https://*.getpara.com",
      "wss://*.getpara.com",
      "https://*.usecapsule.com",
      "wss://*.usecapsule.com",
    ].join(" "),
    "upgrade-insecure-requests",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  // 1) operator-only /admin gate
  if (request.nextUrl.pathname.startsWith("/admin")) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Not Found", { status: 404 });
    }
    return NextResponse.next();
  }

  // 2) Content-Security-Policy on the response.
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", buildCsp());
  return response;
}

export const config = {
  // Run on every route EXCEPT Next's static assets, images, and the favicon (they need no
  // nonce and skipping them keeps the middleware cheap).
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
