// Gate the Para-derived Miden account's storageMode on NEXT_PUBLIC_PARA_PRIVATE.
//
// @miden-sdk/use-miden-para-react hardcodes `storageMode: AccountStorageMode.public()`
// in ParaSignerProviderInner's accountConfig, with no prop to override it. We can't do
// this via patch-package: its diff/apply is context-sensitive and the @miden-sdk
// tarballs get republished under the same version, so a patch regenerated locally
// fails to apply on Vercel's fresh install. A plain STRING replacement is context-free
// and version-proof, so we run it here as a postinstall step AFTER patch-package.
//
// Idempotent (skips if already replaced) and best-effort (never fails the install).
import { readFileSync, writeFileSync } from "node:fs";

const OLD = "storageMode: AccountStorageMode.public()";
const NEW =
  'storageMode: (typeof process !== "undefined" && process.env && process.env.NEXT_PUBLIC_PARA_PRIVATE === "1") ? AccountStorageMode.private() : AccountStorageMode.public()';

const files = [
  "node_modules/@miden-sdk/use-miden-para-react/dist/index.js",
  "node_modules/@miden-sdk/use-miden-para-react/dist/index.mjs",
];

for (const p of files) {
  try {
    const s = readFileSync(p, "utf8");
    if (s.includes(NEW)) {
      console.log(`[patch-para-private] already gated: ${p}`);
      continue;
    }
    if (!s.includes(OLD)) {
      console.warn(`[patch-para-private] anchor not found (SDK changed?): ${p}`);
      continue;
    }
    writeFileSync(p, s.replace(OLD, NEW));
    console.log(`[patch-para-private] gated storageMode: ${p}`);
  } catch (e) {
    console.warn(`[patch-para-private] skipped ${p}: ${e?.message ?? e}`);
  }
}
