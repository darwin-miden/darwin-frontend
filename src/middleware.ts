import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Two jobs:
 *  1. Edge-gate operator-only tooling: `/admin/*` (the drift dashboard) must never be
 *     reachable on the public production surface. A client-side `notFound()` only fires
 *     after hydration (the prerendered HTML still serves 200), so we 404 at the edge.
 *     Left reachable under `next dev` so the operator can use it locally.
 *  2. NONCE-based Content-Security-Policy. The derived Falcon signing key lives in the
 *     browser, so the CSP is the last line of defence against an injected script
 *     exfiltrating it. `script-src` now allows ONLY a per-request nonce (+ wasm/eval for
 *     the STARK prover / dev HMR) instead of `'unsafe-inline'` — an injected inline
 *     `<script>` no longer runs. Next reads the nonce from the CSP on the request headers
 *     and stamps its own bootstrap scripts with it automatically.
 */

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // NONCE replaces 'unsafe-inline'. 'wasm-unsafe-eval' for the STARK prover; in dev also
    // 'unsafe-eval' for React-Refresh/HMR (prod ships neither unsafe-inline nor unsafe-eval).
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
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

  // 2) per-request nonce CSP (base64 of 16 random bytes)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = buildCsp(nonce);

  // Next reads the nonce from the CSP set on the REQUEST headers and applies it to its
  // injected scripts; we also set it on the response so the browser enforces it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
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
