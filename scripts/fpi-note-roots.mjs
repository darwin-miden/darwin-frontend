// Compute the FPI NAV note-script roots via @miden-sdk in Node (mock client, no
// network). These match the browser exactly (validated: this SDK reproduces the
// browser-verified 0x4c7980e6 root for the non-fpi note) — Rust can't, because the
// web SDK's libs differ. Use the printed roots with:
//   deploy_v13_fpi_faucet --allow-root <deposit> --allow-root <redeem> --deploy
//
// Run:  node scripts/fpi-note-roots.mjs   (from darwin-frontend)
import { readFileSync } from "node:fs";
import { MidenClient } from "@miden-sdk/miden-sdk";

const MASM = new URL("../src/lib/masm/", import.meta.url).pathname;
const read = (f) => readFileSync(MASM + f, "utf8");

// Same libraries as clientNote.ts NAV_NOTE_FPI_LIBRARIES.
const libraries = [
  { namespace: "darwin::math", code: read("math.masm"), linking: "static" },
  { namespace: "darwin::price_oracle", code: read("price_oracle.masm"), linking: "static" },
  { namespace: "darwin::pragma_fpi", code: read("pragma_fpi.masm"), linking: "static" },
];

const client = await MidenClient.createMock({});
for (const [label, file] of [
  ["nav_deposit_fpi", "nav_deposit_note_fpi.masm"],
  ["nav_redeem_fpi", "nav_redeem_note_fpi.masm"],
]) {
  const ns = await client.compile.noteScript({ code: read(file), libraries });
  console.log(`${label}  ${ns.root().toHex()}`);
}
