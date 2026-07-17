/**
 * Write the on-chain encrypted backup via the native miden-client (Mac-relay
 * path). The browser encrypts the account file locally (AES key derived from the
 * user's MetaMask signature — never leaves the browser) and POSTs ONLY the
 * ciphertext here; this route pipes it to the `backup_write` bin, which packs it
 * into 28-byte Words and writes them into the public NoAuth controller's slot-10
 * StorageMap. Proving runs natively (fast, no browser freeze), and the browser
 * worker's inability to track/apply the public controller is sidestepped.
 *
 * Confidentiality: the Mac sees only opaque AES ciphertext + public ids (the
 * controller is public, the user's key/wallet never touch the server). Companion
 * to /api/backup-read. Mac-proxied like /api/position (native client on the Mac).
 *
 * Body: { suffix, prefix, controllerId, ciphertextB64 }
 * Returns: { ok: true, nWords, byteLen } or { error }
 */

import { spawn } from "node:child_process";

export const runtime = "nodejs";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;
const BACKUP_WRITE_BIN =
  process.env.DARWIN_BACKUP_WRITE_BIN ||
  "/Users/eden/data/darwin/repos/darwin-protocol/target/release/backup_write";
const FELT_MAX = (1n << 64n) - (1n << 32n) + 1n;

function jsonError(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Spawn backup_write, pipe the ciphertext to stdin, parse its JSON stdout. */
function runWrite(
  controllerId: string,
  suffix: string,
  prefix: string,
  ciphertext: Buffer,
  env: NodeJS.ProcessEnv,
): Promise<{ ok?: boolean; nWords?: number; byteLen?: number; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      BACKUP_WRITE_BIN,
      [controllerId, suffix, prefix],
      { env: { ...env, MIDEN_NETWORK: "testnet" } },
    );
    let stdout = "";
    // Backup writes are several native proofs — allow generous time.
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    child.on("error", (e) => (clearTimeout(timer), resolve({ error: String(e) })));
    child.on("close", (code) => {
      clearTimeout(timer);
      // The bin prints exactly one JSON line last (spam goes to stderr).
      const line = stdout.trim().split("\n").filter(Boolean).pop() || "";
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ error: `write bin exited ${code}: ${line.slice(0, 120)}` });
      }
    });
    child.stdin.write(ciphertext);
    child.stdin.end();
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { suffix?: string; prefix?: string; controllerId?: string; ciphertextB64?: string }
    | null;
  if (!body?.suffix || !body?.prefix) return jsonError("missing suffix/prefix");
  if (!body?.ciphertextB64) return jsonError("missing ciphertextB64");
  const controllerId = body.controllerId ?? "";
  if (!/^0x[0-9a-fA-F]{30}$/.test(controllerId))
    return jsonError("controllerId must be a Miden account hex");

  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/backup-write`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Bypass-Tunnel-Reminder": "1" },
      body: JSON.stringify(body),
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let suffix: bigint, prefix: bigint;
  try {
    suffix = BigInt(body.suffix);
    prefix = BigInt(body.prefix);
  } catch {
    return jsonError("suffix/prefix must be base-10 bigints");
  }
  if ([suffix, prefix].some((f) => f < 0n || f >= FELT_MAX))
    return jsonError("suffix/prefix out of field range");

  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.from(body.ciphertextB64, "base64");
  } catch {
    return jsonError("ciphertextB64 must be base64");
  }
  if (ciphertext.length === 0) return jsonError("empty ciphertext");
  if (ciphertext.length > 1_000_000) return jsonError("ciphertext too large");

  const midenHome = process.env.DARWIN_MIDEN_HOME;
  const env = midenHome ? { ...process.env, HOME: midenHome } : process.env;
  const result = await runWrite(controllerId, body.suffix, body.prefix, ciphertext, env).catch(
    (e) => ({ ok: false, error: String(e) }),
  );
  const status = result?.ok ? 200 : 500;
  return new Response(JSON.stringify(result), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
