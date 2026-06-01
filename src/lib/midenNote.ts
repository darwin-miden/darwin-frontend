/**
 * Helpers to build Darwin custom notes (atomic_deposit_note +
 * atomic_redeem_note) from the browser using the Miden Web SDK.
 *
 * The MASM sources live in `/public/notes/`. We fetch + cache them
 * once, compile via `useCompile().noteScript()` with the
 * `darwin::math` helper linked dynamically, then wrap the compiled
 * script in a `Note` with a fresh random serial number, an empty
 * note storage, and a sender + controller-targeted private
 * metadata header.
 *
 * The `TransactionRequest` returned by `buildDarwinNoteRequest` is
 * the right shape to pass to `useTransaction().execute({
 * accountId, request: () => req })` — the wallet runs the VM,
 * proves the STARK, and submits to the Miden RPC.
 */

import {
  AccountId,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequestBuilder,
  Word,
} from "@miden-sdk/miden-sdk";
import type { CompileNoteScriptOptions, NoteScript } from "@miden-sdk/miden-sdk";

// Minimal slice of `UseCompileResult` (or `NoteScriptCompiler`) — just
// the bit we actually need. Lets the helper accept the hook result
// from `useCompile()` directly without an `as` cast.
interface NoteScriptCompiler {
  noteScript(options: CompileNoteScriptOptions): Promise<NoteScript>;
}

export type DarwinNoteKind =
  | "atomic-deposit"      // v1 — receive_asset only, no slot-10 write
  | "atomic-deposit-v2"   // v2 — receive_asset + set_user_position (5 storage felts)
  | "atomic-redeem";

const NOTE_SOURCE: Record<DarwinNoteKind, string> = {
  "atomic-deposit": "/notes/atomic_deposit_note.masm",
  "atomic-deposit-v2": "/notes/atomic_deposit_note_v2.masm",
  "atomic-redeem": "/notes/atomic_redeem_note.masm",
};
const MATH_LIB_SOURCE = "/notes/darwin_math.masm";

let mathLibPromise: Promise<string> | null = null;
const noteSourceCache = new Map<DarwinNoteKind, string>();

async function fetchOnce(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.text();
}

export async function getDarwinNoteSource(kind: DarwinNoteKind): Promise<string> {
  const cached = noteSourceCache.get(kind);
  if (cached) return cached;
  const code = await fetchOnce(NOTE_SOURCE[kind]);
  noteSourceCache.set(kind, code);
  return code;
}

export async function getDarwinMathSource(): Promise<string> {
  if (!mathLibPromise) mathLibPromise = fetchOnce(MATH_LIB_SOURCE);
  return mathLibPromise;
}

function randomSerialNum(): Word {
  const buf = new BigUint64Array(4);
  crypto.getRandomValues(buf);
  return new Word(buf);
}

export interface BuildNoteOptions {
  kind: DarwinNoteKind;
  sender: string;       // hex AccountId of the user's wallet
  controller: string;   // hex AccountId of the per-basket controller
  faucetId: string;     // hex AccountId of the fungible asset (constituent or basket-token)
  amount: bigint;       // base units, asset-decimal scaled
  /**
   * v2-only: the basket-token faucet's hex AccountId. Its (suffix,
   * prefix) felts make the slot-10 map key per-(user, basket) so each
   * basket row in the portfolio reads its own balance. Without this,
   * every basket shares one slot and the UI lies — depositing into
   * DCC makes DAG and DCO appear positive too.
   */
  basketFaucetId?: string;
  /**
   * Optional override for the note storage felts the script reads via
   * `active_note::get_storage`:
   *   atomic-deposit    (3 felts) — [deposit_value, fee_factor, nav_scale]
   *   atomic-deposit-v2 (7 felts) — [deposit_value, fee_factor, nav_scale,
   *                                  user_id_suffix, user_id_prefix,
   *                                  basket_id_suffix, basket_id_prefix]
   *   atomic-redeem     (3 felts) — [burn_amount, gross_release_factor, scale]
   * If omitted, the math felts default to the Rust verification
   * constants (200e9 / 9970 / 1e10 for deposit, 100 / 9970 / 1 for
   * redeem); user_id + basket_id felts on v2 are derived from `sender`
   * and `basketFaucetId` automatically.
   */
  storageFelts?: bigint[];
}

const DEFAULT_MATH_STORAGE: Record<DarwinNoteKind, [bigint, bigint, bigint]> = {
  "atomic-deposit":    [200_000_000_000n, 9_970n, 10_000_000_000n],
  "atomic-deposit-v2": [200_000_000_000n, 9_970n, 10_000_000_000n],
  "atomic-redeem":     [100n, 9_970n, 1n],
};

/**
 * Compile the chosen Darwin note + assemble a one-asset Note headed
 * to the controller. The caller passes the result to
 * `TransactionRequestBuilder().withOwnOutputNotes(new
 * NoteArray([note])).build()`.
 */
export async function buildDarwinNote(
  compile: NoteScriptCompiler,
  opts: BuildNoteOptions,
): Promise<Note> {
  // The atomic notes now inline felt_div locally (the browser SDK
  // 0.14.x can't link external user libraries that themselves
  // `use` std-lib modules — verified failing with a "syntax error"
  // diagnostic at library parse time). Just feed the note source.
  const noteCode = await getDarwinNoteSource(opts.kind);

  const script = await compile.noteScript({ code: noteCode });

  // The MidenFi wallet hands us a bech32 address (mtst1…) while our
  // hardcoded controller + faucet ids are stored as raw hex strings.
  // Auto-detect format per arg so callers can pass either shape
  // without ceremony (and so a wallet-derived sender doesn't blow up
  // with "expected hex data length 32, found 49").
  const parseAccountRef = (s: string) =>
    s.startsWith("0x") || /^[0-9a-f]+$/i.test(s)
      ? AccountId.fromHex(s)
      : AccountId.fromBech32(s);
  const senderId = parseAccountRef(opts.sender);
  const controllerId = parseAccountRef(opts.controller);
  const faucetId = parseAccountRef(opts.faucetId);
  const basketFaucetParsed = opts.basketFaucetId
    ? parseAccountRef(opts.basketFaucetId)
    : null;

  const asset = new FungibleAsset(faucetId, opts.amount);
  const assets = new NoteAssets([asset]);

  // Pass the mint/release params through note storage. The script
  // reads them via `active_note::get_storage` and runs the
  // multiplication + felt_div on-chain. v2 also reads slots 3 and 4
  // as the user_id key for the slot-10 StorageMap write.
  //
  // For v2 deposits, default the deposit_value felt to the actual
  // asset amount so the credited slot-10 position scales with the
  // deposit (rather than the legacy 200e9 constant which credits a
  // fixed 199400 regardless of how much the user sent). fee_factor
  // (0.9970 in 1e4 fixed-point) and nav_scale stay at the Rust
  // verification defaults so mint_amount = amount * 9970 / 10000 —
  // i.e. the user's net basket-token credit at 1:1 NAV.
  let mathFelts: bigint[] = opts.storageFelts ?? DEFAULT_MATH_STORAGE[opts.kind];
  if (opts.kind === "atomic-deposit-v2" && !opts.storageFelts) {
    mathFelts = [opts.amount, 9_970n, 10_000n];
  }
  const feltArray = new FeltArray();
  for (const f of mathFelts) feltArray.push(new Felt(f));
  if (opts.kind === "atomic-deposit-v2" && mathFelts.length < 7) {
    // Derive the user_id key from the sender's AccountId so each
    // wallet writes to a distinct slot-10 entry and accumulates only
    // its own deposits. AccountId.suffix()/prefix() return Felt
    // objects whose underlying u64 is the key half the worker uses.
    const senderFelts = [senderId.suffix(), senderId.prefix()];
    for (const f of senderFelts) feltArray.push(f);
    // Append the basket_id half of the slot-10 key so each basket
    // owns its own entry. Falling back to zero zeros mirrors the
    // legacy single-slot behaviour — callers that omit basketFaucetId
    // get the old (buggy) shared-slot semantics.
    if (basketFaucetParsed) {
      feltArray.push(basketFaucetParsed.suffix());
      feltArray.push(basketFaucetParsed.prefix());
    } else {
      feltArray.push(new Felt(0n));
      feltArray.push(new Felt(0n));
    }
  }
  const storage = new NoteStorage(feltArray);

  const recipient = new NoteRecipient(randomSerialNum(), script, storage);

  const tag = NoteTag.withAccountTarget(controllerId);
  // Must be Public so the controller (any node syncing) can discover
  // and consume the note. With Private, only the sender's local store
  // has the note details — the controller never sees it and the
  // deposit silently dead-ends after the user tx commits.
  const metadata = new NoteMetadata(senderId, NoteType.Public, tag);

  return new Note(assets, metadata, recipient);
}

/**
 * Builds the full TransactionRequest in one shot — convenience
 * wrapper around `buildDarwinNote` for the typical "send this one
 * Darwin note" path.
 */
export async function buildDarwinNoteRequest(
  compile: NoteScriptCompiler,
  opts: BuildNoteOptions,
) {
  const note = await buildDarwinNote(compile, opts);
  return new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([note]))
    .build();
}
