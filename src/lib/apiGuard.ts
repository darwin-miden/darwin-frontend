import { NextResponse } from "next/server";

/**
 * Shared hardening for the /api routes that spawn native Rust/CLI
 * subprocesses. These routes are reachable unauthenticated over the
 * public tunnel, so without a guard an attacker can (a) fork-bomb the
 * operator's machine with unbounded concurrent 30–60s processes, (b)
 * spam a state-changing faucet, or (c) hammer the shared sqlite store
 * into "database is locked". This module provides a PROCESS-GLOBAL
 * concurrency semaphore (shared across every route that imports it — a
 * single module instance in the Node server) plus a best-effort per-IP
 * rate limit, and a path redactor so subprocess errors don't leak the
 * operator's filesystem layout back over HTTP.
 */

// Global cap on concurrent native subprocesses across ALL spawn routes.
const MAX_INFLIGHT = Number(process.env.DARWIN_MAX_INFLIGHT || 4);
let inFlight = 0;

// Fixed-window per-IP rate limit (in-memory, best-effort — resets on
// server restart; good enough to blunt a flood, not a substitute for a
// real gateway limiter).
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.DARWIN_RATE_LIMIT || 20);
const hits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  // Cloudflare sets cf-connecting-ip to the true client IP at the edge and
  // overwrites any client-supplied value, so it can't be spoofed from the
  // outside — unlike x-forwarded-for, whose first token the client fully
  // controls (which would let an attacker rotate the rate-limit key). Use
  // cf-connecting-ip first; XFF is only a spoofable last-resort fallback.
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xrip = req.headers.get("x-real-ip");
  if (xrip) return xrip.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}

/** True if the request is within its per-IP window budget. */
export function rateLimit(req: Request): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    // Opportunistic GC so the map can't grow unbounded.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    return true;
  }
  cur.count += 1;
  return cur.count <= MAX_PER_WINDOW;
}

/**
 * Take one global subprocess slot; false if already at MAX_INFLIGHT.
 * Pair every successful acquire with a releaseSlot() in a finally.
 */
export function acquireSlot(): boolean {
  if (inFlight >= MAX_INFLIGHT) return false;
  inFlight += 1;
  return true;
}

export function releaseSlot(): void {
  if (inFlight > 0) inFlight -= 1;
}

/** Standard 503 response when the subprocess pool is saturated. */
export function busySlot(): NextResponse {
  return NextResponse.json(
    { error: "server busy (max concurrent jobs) — retry shortly" },
    { status: 503 },
  );
}

// Per-key fixed-window limiter (independent of the per-IP one) — e.g. a
// drip cap keyed by faucet-mint target so a single target can't be spammed
// even across many source IPs.
const keyHits = new Map<string, { count: number; resetAt: number }>();
export function keyLimit(key: string, maxPerWindow: number, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const cur = keyHits.get(key);
  if (!cur || now > cur.resetAt) {
    keyHits.set(key, { count: 1, resetAt: now + windowMs });
    if (keyHits.size > 5000) {
      for (const [k, v] of keyHits) if (now > v.resetAt) keyHits.delete(k);
    }
    return true;
  }
  cur.count += 1;
  return cur.count <= maxPerWindow;
}

/** Standard 429 response for a rate-limited request. */
export function rateLimited(): NextResponse {
  return NextResponse.json(
    { error: "rate limit exceeded — slow down" },
    { status: 429 },
  );
}

/**
 * Strip absolute operator paths (and thus the OS username / toolchain
 * layout) out of a subprocess error string before it goes over HTTP.
 */
export function redact(s: string): string {
  return s.replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"']*)?/g, "<path>");
}
