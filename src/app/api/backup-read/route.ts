/**
 * Read on-chain encrypted-backup chunks from the v8-noauth controller's
 * slot-10 StorageMap. Companion to the client-side write (which uses
 * set_user_position with backup-namespace keys). Reads the meta entry
 * (byteLen, nWords) plus each chunk word, batched 4 words per miden-client
 * exec (truncate_stack pins depth at 16 = 4 words), one sync up front.
 *
 * Body: { suffix, prefix, controllerId }  (base-10 u64 strings + 0x hex)
 * Returns: { byteLen, words: [[f0,f1,f2,f3], …] }  (all base-10 strings)
 *
 * Mac-proxied like /api/position (miden-client lives on the Mac). Read-only:
 * the controller is public, so this reads on-chain state — no keys involved.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";

const MAC_API_BASE = process.env.DARWIN_MAC_API_BASE;
const MIDEN_CLIENT =
  process.env.DARWIN_MIDEN_CLIENT_BIN ||
  "/Users/eden/Library/Application Support/midenup/toolchains/0.15.0/bin/miden-client";
// In-process Rust reader: one sync + in-memory get_map_item for every chunk.
// Replaces the per-chunk `miden-client exec` spawns (flat ~sync-time read,
// independent of backup size). Falls back to the exec loop if it fails.
const BACKUP_READ_BIN =
  process.env.DARWIN_BACKUP_READ_BIN ||
  "/Users/eden/data/darwin/repos/darwin-protocol/target/release/backup_read";
// If the store was synced within this many seconds (dedicated marker file), the
// reader skips its own ~400ms network sync — the (older) backup is already
// local. The restore flow fires a `warm` sync while the user signs, so the read
// that follows lands inside this window. 0 disables (always sync).
const BACKUP_READ_FRESH_SECS = process.env.DARWIN_BACKUP_READ_FRESH_SECS || "30";
const GET_USER_POSITION_MAST_ROOT =
  "0x47b239ea11ad0375cca5a082369f721729c6d63a1fb170e6b5be5755dd06301f";
// Must match src/lib/onchainBackup.ts.
const BACKUP_MAGIC = "15720690719117082606"; // 0xda2b1cead0c0ffee
const BACKUP_META_INDEX = "4294967295"; // 0xffffffff
const FELT_MAX = (1n << 64n) - (1n << 32n) + 1n;
const WORDS_PER_EXEC = 4; // truncate_stack keeps 16 felts

function jsonError(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** MASM reading up to 4 keys; leaves their value words (16 felts) on the stack. */
function buildBatchReadScript(
  suffix: bigint,
  prefix: bigint,
  indices: bigint[],
): string {
  // Push reads so indices[0] ends up on top ([0..3]); read in reverse.
  const reads = [...indices]
    .reverse()
    .map(
      (idx) =>
        `  push.${suffix} push.${prefix} push.${BACKUP_MAGIC} push.${idx}\n  call.${GET_USER_POSITION_MAST_ROOT}`,
    )
    .join("\n");
  return `use miden::core::sys\n\nbegin\n${reads}\n  exec.sys::truncate_stack\nend\n`;
}

/**
 * Fast path: run the in-process Rust reader (`backup_read <ctrl> <suf> <pre>`),
 * which syncs once then reads every chunk from the local store's slot-10 map
 * with plain get_map_item lookups — no per-chunk VM exec, no per-chunk process.
 * Returns { byteLen, words } on success, or null to fall back to the exec loop.
 */
function readViaBin(
  controllerId: string,
  suffix: string,
  prefix: string,
  env: NodeJS.ProcessEnv,
): Promise<{ byteLen: number; words: string[][] } | null> {
  return new Promise((resolve) => {
    const child = spawn(
      BACKUP_READ_BIN,
      [controllerId, suffix, prefix],
      {
        env: {
          ...env,
          MIDEN_NETWORK: "testnet",
          BACKUP_READ_FRESH_SECS,
        },
      },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const j = JSON.parse(stdout.trim());
        if (
          typeof j?.byteLen === "number" &&
          Array.isArray(j?.words) &&
          j.words.every(
            (w: unknown) =>
              Array.isArray(w) && w.length === 4 && w.every((f) => typeof f === "string"),
          )
        ) {
          resolve({ byteLen: j.byteLen, words: j.words });
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Warm the local store: run the reader in warm mode (force sync + write the
 * freshness marker, no chunk reads). Fired at the start of a restore while the
 * user signs, so the actual read a moment later skips its own sync. Resolves
 * when the sync completes (or fails — best-effort).
 */
function runWarm(
  controllerId: string,
  suffix: string,
  prefix: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(
      BACKUP_READ_BIN,
      [controllerId, suffix, prefix],
      // No FRESH_SECS ⇒ warm always syncs, guaranteeing a fresh marker.
      { env: { ...env, MIDEN_NETWORK: "testnet", BACKUP_READ_WARM: "1" } },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", () => (clearTimeout(timer), resolve()));
    child.on("close", () => (clearTimeout(timer), resolve()));
  });
}

function runSync(env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(MIDEN_CLIENT, ["sync"], { env });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => (clearTimeout(timer), resolve()));
    child.on("close", () => (clearTimeout(timer), resolve()));
  });
}

function runExec(
  scriptPath: string,
  controllerId: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      MIDEN_CLIENT,
      ["exec", "-a", controllerId, "-s", scriptPath],
      { env },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", () => {});
    child.on("error", () => (clearTimeout(timer), resolve({ stdout, code: -1 })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ stdout, code })));
  });
}

/** Parse "Result (N values):\n  [0]: x\n  [1]: y …" → felt bigints in order. */
function parseFelts(stdout: string): bigint[] {
  const out: bigint[] = [];
  const re = /\[(\d+)\]:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  const pairs: [number, bigint][] = [];
  while ((m = re.exec(stdout))) pairs.push([Number(m[1]), BigInt(m[2])]);
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [, v] of pairs) out.push(v);
  return out;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { suffix?: string; prefix?: string; controllerId?: string; warm?: boolean }
    | null;
  if (!body?.suffix || !body?.prefix)
    return jsonError("missing suffix/prefix");
  const controllerId = body.controllerId ?? "";
  if (!/^0x[0-9a-fA-F]{30}$/.test(controllerId))
    return jsonError("controllerId must be a Miden account hex");

  if (MAC_API_BASE) {
    const r = await fetch(`${MAC_API_BASE}/api/backup-read`, {
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

  const midenHome = process.env.DARWIN_MIDEN_HOME;
  const env = midenHome ? { ...process.env, HOME: midenHome } : process.env;

  // Warm mode: sync the store now (write the freshness marker) and return, so a
  // follow-up read skips its own sync. Fired while the user signs the restore.
  if (body.warm) {
    await runWarm(controllerId, body.suffix, body.prefix, env).catch(() => {});
    return new Response(JSON.stringify({ warmed: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fast path: single in-process Rust reader. Falls through to the per-chunk
  // exec loop below if the binary is missing or errors.
  const fast = await readViaBin(controllerId, body.suffix, body.prefix, env).catch(
    () => null,
  );
  if (fast) {
    return new Response(JSON.stringify(fast), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "darwin-bkr-"));
  try {
    await runSync(env).catch(() => undefined);

    const readBatch = async (indices: bigint[]): Promise<bigint[]> => {
      const sp = path.join(tmp, `r_${indices[0]}.masm`);
      await writeFile(sp, buildBatchReadScript(suffix, prefix, indices), "utf8");
      const { stdout, code } = await runExec(sp, controllerId, env);
      if (code !== 0) throw new Error(`exec failed (${code})`);
      return parseFelts(stdout);
    };

    // 1) meta entry → [byteLen, nWords, 0, 0]
    const meta = await readBatch([BigInt(BACKUP_META_INDEX)]);
    const byteLen = Number(meta[0] ?? 0n);
    const nWords = Number(meta[1] ?? 0n);
    if (!byteLen || !nWords)
      return new Response(JSON.stringify({ byteLen: 0, words: [] }), {
        headers: { "Content-Type": "application/json" },
      });

    // 2) all chunk words, 4 per exec — run execs CONCURRENTLY (each reads the
    // already-synced local store, so concurrent reads are safe) to cut the
    // ~40-exec sequential read (~40s) down to a handful of parallel waves.
    const batches: { at: number; idx: bigint[] }[] = [];
    for (let i = 0; i < nWords; i += WORDS_PER_EXEC) {
      const idx: bigint[] = [];
      for (let j = i; j < Math.min(i + WORDS_PER_EXEC, nWords); j++) idx.push(BigInt(j));
      batches.push({ at: i, idx });
    }
    const words: string[][] = new Array(nWords);
    // 14-core machine — 12 concurrent execs covers most backups in 1-2 waves.
    const CONCURRENCY = 12;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const b = batches[cursor++];
        if (!b) return;
        const felts = await readBatch(b.idx);
        for (let k = 0; k < b.idx.length; k++) {
          const w = felts.slice(k * 4, k * 4 + 4).map((f) => (f ?? 0n).toString());
          while (w.length < 4) w.push("0");
          words[b.at + k] = w;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return new Response(JSON.stringify({ byteLen, words }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(`backup-read failed: ${String(e).slice(0, 120)}`, 500);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
