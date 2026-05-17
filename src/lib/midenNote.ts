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
  FeltArray,
  FungibleAsset,
  Linking,
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

export type DarwinNoteKind = "atomic-deposit" | "atomic-redeem";

const NOTE_SOURCE: Record<DarwinNoteKind, string> = {
  "atomic-deposit": "/notes/atomic_deposit_note.masm",
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
}

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
  const [noteCode, mathCode] = await Promise.all([
    getDarwinNoteSource(opts.kind),
    getDarwinMathSource(),
  ]);

  const script = await compile.noteScript({
    code: noteCode,
    libraries: [
      {
        namespace: "darwin::math",
        code: mathCode,
        linking: Linking.Dynamic,
      },
    ],
  });

  const senderId = AccountId.fromHex(opts.sender);
  const controllerId = AccountId.fromHex(opts.controller);
  const faucetId = AccountId.fromHex(opts.faucetId);

  const asset = new FungibleAsset(faucetId, opts.amount);
  const assets = new NoteAssets([asset]);

  const storage = new NoteStorage(new FeltArray());

  const recipient = new NoteRecipient(randomSerialNum(), script, storage);

  const tag = NoteTag.withAccountTarget(controllerId);
  const metadata = new NoteMetadata(senderId, NoteType.Private, tag);

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
