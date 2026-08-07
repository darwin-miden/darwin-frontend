// Context-free patches for @miden-sdk/use-miden-para-react, applied in postinstall.
//
// We do NOT use patch-package for this package: its diff/apply is context-sensitive
// and the @miden-sdk tarballs get republished under the same version, so a patch
// regenerated locally intermittently fails to apply on Vercel's fresh install. Plain,
// idempotent STRING replacements are context-free and version-proof.
//
// Two changes to ParaSignerProviderInner's accountConfig:
//   1. accountSeed = SHA-256(pubkey commitment) — a DETERMINISTIC seed so the Para
//      wallet derives the SAME Miden account id every connect. Upstream leaves it
//      unset ⇒ a random seed ⇒ a different id per connect, stranding funds. The seed
//      is only anti-collision salt for the id; security still comes from the Para MPC
//      key, so deriving it from the public commitment is safe.
//   2. storageMode gated on NEXT_PUBLIC_PARA_PRIVATE (private ⇒ confidential /para).
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "node_modules/@miden-sdk/use-miden-para-react/dist/index.js",
  "node_modules/@miden-sdk/use-miden-para-react/dist/index.mjs",
];

const SEED_ANCHOR = "publicKeyCommitment: commitmentBytes,";
const SEED_REPLACE =
  'publicKeyCommitment: commitmentBytes,\n              accountSeed: new Uint8Array(await crypto.subtle.digest("SHA-256", commitmentBytes instanceof Uint8Array ? commitmentBytes : new Uint8Array(commitmentBytes))),';

const SM_ANCHOR = "storageMode: AccountStorageMode.public()";
const SM_REPLACE =
  'storageMode: (typeof process !== "undefined" && process.env && process.env.NEXT_PUBLIC_PARA_PRIVATE === "1") ? AccountStorageMode.private() : AccountStorageMode.public()';

const failures = [];

for (const p of files) {
  try {
    let s = readFileSync(p, "utf8");
    let changed = false;

    // 1. deterministic account seed (idempotent: skip if accountSeed already present)
    if (!s.includes("accountSeed:")) {
      const n = s.split(SEED_ANCHOR).length - 1;
      if (n === 1) {
        s = s.replace(SEED_ANCHOR, SEED_REPLACE);
        changed = true;
      } else {
        console.warn(`[patch-para-private] seed anchor x${n} in ${p} — skipped`);
      }
    }

    // 2. storageMode gate (idempotent: skip if the flag is already wired)
    if (!s.includes("NEXT_PUBLIC_PARA_PRIVATE") && s.includes(SM_ANCHOR)) {
      s = s.replace(SM_ANCHOR, SM_REPLACE);
      changed = true;
    }

    if (changed) {
      writeFileSync(p, s);
      console.log(`[patch-para-private] patched ${p}`);
    } else {
      console.log(`[patch-para-private] already patched: ${p}`);
    }

    // VERIFY both transforms are present in the final output. A silent skip (SDK
    // republished with reformatted/reordered code so an anchor no longer matches) would
    // otherwise ship a RANDOM account seed (funds stranded per connect) or a PUBLIC
    // account (confidentiality lost) with no build error. Fail loudly instead.
    if (!s.includes("accountSeed:")) failures.push(`${p}: accountSeed not applied`);
    if (!s.includes("NEXT_PUBLIC_PARA_PRIVATE")) {
      failures.push(`${p}: storageMode gate not applied`);
    }
  } catch (e) {
    failures.push(`${p}: ${e?.message ?? e}`);
  }
}

if (failures.length) {
  console.error("[patch-para-private] REQUIRED PATCH MISSING:\n  " + failures.join("\n  "));
  // Hard-fail production/CI builds (Vercel sets NODE_ENV=production or CI=1): a missing
  // seed/storageMode patch silently strands funds or breaks confidentiality. Locally we
  // warn but don't block iteration.
  if (process.env.NODE_ENV === "production" || process.env.CI || process.env.VERCEL) {
    process.exit(1);
  }
}
