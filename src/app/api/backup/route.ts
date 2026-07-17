/**
 * Encrypted store-backup endpoint. Stores ONLY ciphertext, keyed by the
 * derived Miden wallet id. It never sees the encryption key, the plaintext
 * store, or the balance — the blob is AES-GCM-encrypted client-side with a
 * MetaMask-derived key. See src/lib/storeBackup.ts.
 *
 * On Vercel (DARWIN_MAC_API_BASE set) this proxies to the Mac backend, which
 * persists the file (Vercel's fs is ephemeral). On the Mac it writes the file.
 */

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;
const DIR = path.join(os.homedir(), ".darwin", "backups");
const MAX_CIPHERTEXT = 30_000_000; // ~30 MB ceiling

// Only a 0x-hex wallet id — prevents any path traversal in the filename.
function safeKey(k: unknown): string | null {
  return typeof k === "string" && /^0x[0-9a-fA-F]{20,80}$/.test(k)
    ? k.toLowerCase()
    : null;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { key?: string; ciphertext?: string }
    | null;
  if (!body?.key || typeof body.ciphertext !== "string") {
    return NextResponse.json({ error: "missing key/ciphertext" }, { status: 400 });
  }
  if (body.ciphertext.length > MAX_CIPHERTEXT) {
    return NextResponse.json({ error: "backup too large" }, { status: 413 });
  }

  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "1" },
      body: JSON.stringify(body),
    });
    return new NextResponse(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const key = safeKey(body.key);
  if (!key) return NextResponse.json({ error: "bad key" }, { status: 400 });
  await fs.mkdir(DIR, { recursive: true });
  // Atomic write (tmp + rename) so a crash mid-write can't corrupt the backup.
  const dest = path.join(DIR, `${key}.enc`);
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body.ciphertext, "utf8");
  await fs.rename(tmp, dest);
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const rawKey = new URL(req.url).searchParams.get("key") ?? "";

  if (MAC_API_BASE) {
    const r = await fetch(
      `${MAC_API_BASE}/api/backup?key=${encodeURIComponent(rawKey)}`,
      { headers: { "Bypass-Tunnel-Reminder": "1" } },
    );
    return new NextResponse(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const key = safeKey(rawKey);
  if (!key) return NextResponse.json({ ciphertext: null });
  try {
    const data = await fs.readFile(path.join(DIR, `${key}.enc`), "utf8");
    return NextResponse.json({ ciphertext: data });
  } catch {
    return NextResponse.json({ ciphertext: null });
  }
}
