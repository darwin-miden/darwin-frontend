/**
 * Client-side confidential note-building — the decentralization step that moves
 * the NAV deposit note construction OFF the server (/api/confidential-note) and
 * into the browser.
 *
 * Enabled by the network-note primitives shipped in @miden-sdk 0.15.5+
 * (web-sdk PR #230). The browser flow is:
 *   1. useCompile().noteScript(...)   → compile the NAV deposit script client-side
 *      (into the exact MAST root the faucet allowlists — see below).
 *   2. read the faucet's live supply + vault value V on-chain (to price the mint).
 *   3. build the private payback P2ID recipient (a specific serial we keep so we
 *      can reconstruct + consume the minted note afterwards).
 *   4. useCreateNetworkNote({ target: faucet, script, inputs, assetId, amount })
 *      → builds the Public note (NetworkAccountTarget attachment) AND submits it.
 *
 * The compiled script's `.root()` MUST equal the root allowlisted in the faucet's
 * `AuthNetworkAccount` set. The note is the `@note_script pub proc main` form
 * required by miden-standards 0.14.5+ (the 0.14 `begin/end` form is rejected by
 * the 0.15.x compiler) — verified headless to compile to
 * 0x4c7980e6700642199e845d7423aaa04d2744019f3a5c4c3fbb5c53d6d8831783.
 */
import navDepositNoteMasm from "./masm/nav_deposit_note.masm";
import mathMasm from "./masm/math.masm";
import priceOracleMasm from "./masm/price_oracle.masm";

/** The `@note_script`-form NAV deposit script (0.15.x), compiled client-side. */
export const NAV_DEPOSIT_NOTE_MASM: string = navDepositNoteMasm;

/**
 * The two darwin libraries the deposit script links, statically, in the order the
 * native builder uses (math first — price_oracle references it). Shape matches
 * `useCompile().noteScript({ libraries })`.
 */
export const NAV_NOTE_LIBRARIES = [
  { namespace: "darwin::math", code: mathMasm, linking: "static" as const },
  { namespace: "darwin::price_oracle", code: priceOracleMasm, linking: "static" as const },
];

/** Signature of the `noteScript` compiler from `useCompile()`. */
type CompileNoteScript = (opts: {
  code: string;
  libraries?: Array<{ namespace: string; code: string; linking: "static" | "dynamic" }>;
}) => Promise<{ root: () => { toHex: () => string } }>;

/**
 * Compile the NAV deposit note script in the browser. Pass `noteScript` from
 * `useCompile()`. The returned NoteScript's `.root().toHex()` must match the
 * faucet's allowlisted root.
 */
export async function compileNavDepositScript(noteScript: CompileNoteScript) {
  return noteScript({ code: NAV_DEPOSIT_NOTE_MASM, libraries: NAV_NOTE_LIBRARIES });
}
