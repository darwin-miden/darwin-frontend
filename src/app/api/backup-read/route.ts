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
    | { suffix?: string; prefix?: string; controllerId?: string }
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

    // 2) all chunk words, 4 per exec
    const words: string[][] = [];
    for (let i = 0; i < nWords; i += WORDS_PER_EXEC) {
      const idx: bigint[] = [];
      for (let j = i; j < Math.min(i + WORDS_PER_EXEC, nWords); j++) idx.push(BigInt(j));
      const felts = await readBatch(idx);
      // felts are index0-word first ([0..3]=idx[0], [4..7]=idx[1], …)
      for (let k = 0; k < idx.length; k++) {
        const w = felts.slice(k * 4, k * 4 + 4).map((f) => (f ?? 0n).toString());
        while (w.length < 4) w.push("0");
        words.push(w);
      }
    }
    return new Response(JSON.stringify({ byteLen, words }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return jsonError(`backup-read failed: ${String(e).slice(0, 120)}`, 500);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
