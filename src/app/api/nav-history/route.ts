/**
 * NAV history endpoint.
 *
 * Reads the snapshots SQLite db at `$DARWIN_NAV_HISTORY_DB` (default
 * ./nav-history.sqlite) populated by a sidecar that polls the on-chain
 * Pragma medians + the basket weights and records a NAV row every
 * 5 minutes. If the db is absent or empty, returns a synthetic
 * deterministic history so the frontend chart still renders during
 * dev / first run.
 *
 * Response shape:
 *   { source: "sqlite" | "synthetic", basket: "DCC", points: [{t, nav}] }
 */

import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const revalidate = 60;

interface Point {
  t: number; // unix-seconds
  nav: number;
}

interface Resp {
  source: "sqlite" | "synthetic";
  basket: string;
  points: Point[];
}

const KNOWN_BASKETS = new Set(["DCC", "DAG", "DCO", "DPP"]);

function synthetic(basket: string): Point[] {
  // Deterministic walk seeded by basket symbol — gives a stable demo
  // chart without requiring the polling sidecar to be running.
  let nav = 100;
  const out: Point[] = [];
  const now = Math.floor(Date.now() / 1000);
  let seed = 0;
  for (const ch of basket) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  for (let i = 30; i >= 0; i--) {
    const t = now - i * 24 * 3600;
    seed = (seed * 1103515245 + 12345) >>> 0;
    const step = (((seed >> 8) & 0xffff) / 0xffff - 0.5) * 1.5; // ±0.75%
    nav = Math.max(50, nav * (1 + step / 100));
    out.push({ t, nav: Math.round(nav * 100) / 100 });
  }
  return out;
}

async function fromSqlite(basket: string): Promise<Point[] | null> {
  const dbPath =
    process.env.DARWIN_NAV_HISTORY_DB ||
    path.join(process.cwd(), "nav-history.sqlite");
  try {
    await fs.access(dbPath);
  } catch {
    return null;
  }
  // Defer optional sqlite import until the file is present, so prod
  // builds without the db don't need better-sqlite3 in deps.
  try {
    // Use eval-import to avoid TS compile-time dep on better-sqlite3
    // (optional runtime dep — only loaded when the db exists).
    const mod = await (Function("return import('better-sqlite3')")() as Promise<{
      default: new (
        filename: string,
        options?: { readonly?: boolean },
      ) => {
        prepare: (sql: string) => {
          all: (...params: unknown[]) => unknown[];
        };
        close: () => void;
      };
    }>).catch(() => null);
    if (!mod) return null;
    const Database = mod.default;
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        "SELECT t, nav FROM nav_history WHERE basket = ? ORDER BY t ASC LIMIT 500",
      )
      .all(basket) as Array<{ t: number; nav: number }>;
    db.close();
    if (rows.length === 0) return null;
    return rows.map((r) => ({ t: r.t, nav: r.nav }));
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const basket = (url.searchParams.get("basket") || "DCC").toUpperCase();
  if (!KNOWN_BASKETS.has(basket)) {
    return Response.json(
      { error: `unknown basket symbol: ${basket}` },
      { status: 400 },
    );
  }

  const sqlite = await fromSqlite(basket);
  const body: Resp = sqlite
    ? { source: "sqlite", basket, points: sqlite }
    : { source: "synthetic", basket, points: synthetic(basket) };
  return Response.json(body);
}
