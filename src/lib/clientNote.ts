/**
 * Client-side confidential note-building — the decentralization step that moves
 * the NAV deposit note construction OFF the server (/api/confidential-note) and
 * into the browser.
 *
 * Enabled by the network-note primitives shipped in @miden-sdk 0.15.5+
 * (web-sdk PR #230). Validated headless: this construction builds the exact
 * faithful note that send_nav_deposit.rs builds (payback P2ID at a specific
 * serial + the 9 storage felts + a NetworkAccountTarget attachment), and
 * `depositNote.isNetworkNote() === true` so the NTB will route + consume it.
 *
 * The note is the `@note_script pub proc main` form required by miden-standards
 * 0.14.5+ (the 0.14 `begin/end` form is rejected by the 0.15.x compiler). Its
 * MAST root MUST be allowlisted in the faucet's `AuthNetworkAccount` set (deploy
 * with `--allow-root <root>`). Verified deterministic root:
 *   0x4c7980e6700642199e845d7423aaa04d2744019f3a5c4c3fbb5c53d6d8831783
 */
import navDepositNoteMasm from "./masm/nav_deposit_note.masm";
import navRedeemNoteMasm from "./masm/nav_redeem_note.masm";
import dripNoteMasm from "./masm/drip_note.masm";
import mathMasm from "./masm/math.masm";
import priceOracleMasm from "./masm/price_oracle.masm";
// FPI variants (trustless price via Pragma execute_foreign_procedure — no keeper).
import navDepositNoteFpiMasm from "./masm/nav_deposit_note_fpi.masm";
import navRedeemNoteFpiMasm from "./masm/nav_redeem_note_fpi.masm";
import pragmaFpiMasm from "./masm/pragma_fpi.masm";
// Server-free network backup: the browser-compiled backup_write note + the pack
// helpers/keys it shares with the on-chain backup read.
import backupWriteNoteMasm from "./masm/backup_write_note.masm";
import { BACKUP_META_INDEX, packBytesToWords } from "./onchainBackup";

/** The `@note_script`-form NAV deposit script (0.15.x), compiled client-side. */
export const NAV_DEPOSIT_NOTE_MASM: string = navDepositNoteMasm;

/** The `@note_script`-form NAV redeem script (0.15.x), compiled client-side. */
export const NAV_REDEEM_NOTE_MASM: string = navRedeemNoteMasm;

/**
 * The `@note_script`-form permissionless drip request (0.15.x) — dUSDC + 5-dUSDC
 * payout baked in. Its root (0x429409c1…) must be allowlisted on the dispenser.
 */
export const DRIP_NOTE_MASM: string = dripNoteMasm;

/**
 * The two darwin libraries the deposit script links, statically, in the order the
 * native builder uses (math first — price_oracle references it). Shape matches
 * `useCompile().noteScript({ libraries })`.
 */
export const NAV_NOTE_LIBRARIES = [
  { namespace: "darwin::math", code: mathMasm, linking: "static" as const },
  { namespace: "darwin::price_oracle", code: priceOracleMasm, linking: "static" as const },
];

/**
 * FPI-basket libraries: the note reads live Pragma medians via
 * execute_foreign_procedure (pragma_fpi) and prices against them via
 * price_oracle::compute_v_fpi. The prices are handed to compute_v_fpi ACROSS THE
 * `call` ON THE STACK — the note writes them to mem[230..232] in its own context,
 * but compute_v is `call`ed (fresh memory context) and cannot see that memory, so
 * the note reads them back and pushes them. This uses the SAME consolidated
 * `price_oracle.masm` as the keeper path (it exports both compute_v and
 * compute_v_fpi); the old `price_oracle_fpi.masm` — whose compute_v read mem
 * directly and therefore priced cash-only across the call — was retired.
 * math first (referenced by both), then the price oracle + the pragma FPI loader.
 */
export const NAV_NOTE_FPI_LIBRARIES = [
  { namespace: "darwin::math", code: mathMasm, linking: "static" as const },
  { namespace: "darwin::price_oracle", code: priceOracleMasm, linking: "static" as const },
  { namespace: "darwin::pragma_fpi", code: pragmaFpiMasm, linking: "static" as const },
];

/** Signature of the `noteScript` compiler from `useCompile()`. */
type CompileNoteScript = (opts: {
  code: string;
  libraries?: Array<{ namespace: string; code: string; linking: "static" | "dynamic" }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) => Promise<any>;

/**
 * Compile the NAV deposit note script in the browser. Pass `noteScript` from
 * `useCompile()`. The returned NoteScript's `.root().toHex()` must match the
 * faucet's allowlisted root.
 */
export async function compileNavDepositScript(noteScript: CompileNoteScript) {
  return noteScript({ code: NAV_DEPOSIT_NOTE_MASM, libraries: NAV_NOTE_LIBRARIES });
}

/** Compile the NAV redeem note script in the browser (root must be allowlisted). */
export async function compileNavRedeemScript(noteScript: CompileNoteScript) {
  return noteScript({ code: NAV_REDEEM_NOTE_MASM, libraries: NAV_NOTE_LIBRARIES });
}

/** FPI-basket note scripts (trustless Pragma price, no keeper). Roots differ from
 *  the feed-based notes, so the FPI faucet must allowlist THESE roots. */
export const NAV_DEPOSIT_NOTE_FPI_MASM: string = navDepositNoteFpiMasm;
export const NAV_REDEEM_NOTE_FPI_MASM: string = navRedeemNoteFpiMasm;

/** Compile the FPI NAV deposit note (reads Pragma live via execute_foreign_procedure). */
export async function compileNavDepositScriptFpi(noteScript: CompileNoteScript) {
  return noteScript({ code: NAV_DEPOSIT_NOTE_FPI_MASM, libraries: NAV_NOTE_FPI_LIBRARIES });
}

/** Compile the FPI NAV redeem note. */
export async function compileNavRedeemScriptFpi(noteScript: CompileNoteScript) {
  return noteScript({ code: NAV_REDEEM_NOTE_FPI_MASM, libraries: NAV_NOTE_FPI_LIBRARIES });
}

/** Compile the drip request script in the browser (no darwin libs; standard only). */
export async function compileDripScript(noteScript: CompileNoteScript) {
  return noteScript({ code: DRIP_NOTE_MASM });
}

export interface ClientDripNote {
  /** Drip request note bytes, base64 — emit as an own-output-note. */
  noteB64: string;
  /** Precomputed id of the PUBLIC P2ID payout the dispenser will create. */
  payoutId: string;
  noteId: string;
}

/** dUSDC the dispenser drips per request (baked into drip_note.masm), 6-dec. */
export const DRIP_AMOUNT = 5_000_000n;

/**
 * Build a permissionless dUSDC drip request ENTIRELY client-side — the browser
 * port of build_drip_note.rs. The note carries no asset; storage is [requester
 * suffix, prefix, serial(4)]. Emit it as an own-output-note: the NTB runs it
 * against the dispenser, which mints a PUBLIC P2ID payout (5 dUSDC) tagged for
 * the requester — discovered + consumed by the wallet on sync (no payout file
 * needed). `payoutId` is precomputed so the caller can poll for it.
 */
export async function buildClientDripNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dripScript: any,
  params: { requester: string; dusdcFaucet: string; dispenser: string },
): Promise<ClientDripNote> {
  const sdk = await import("@miden-sdk/miden-sdk");
  const {
    AccountId,
    NoteStorage,
    NoteScript,
    NoteRecipient,
    NoteType,
    NoteTag,
    NoteMetadata,
    NoteAssets,
    FungibleAsset,
    NetworkAccountTarget,
    Note,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = sdk as any;

  const requester = AccountId.fromHex(params.requester);
  const dusdc = AccountId.fromHex(params.dusdcFaucet);
  const dispenser = AccountId.fromHex(params.dispenser);
  const serial = randWord(sdk);

  // Drip request: no asset, storage [suffix, prefix, serial(4)], attached to the
  // dispenser network account.
  const storage = mkStorage(sdk, [requester.suffix(), requester.prefix(), ...serial.toFelts()]);
  const dripNote = Note.withAttachments(
    new NoteAssets([]),
    new NoteMetadata(requester, NoteType.Public, NoteTag.withAccountTarget(dispenser)),
    new NoteRecipient(randWord(sdk), normalizeScript(NoteScript, dripScript), storage),
    [new NetworkAccountTarget(dispenser).toAttachment()],
  );

  // Precompute the PUBLIC P2ID payout id (dispenser → requester, 5 dUSDC, same
  // serial) so it matches the on-chain payout the drip creates.
  const payoutRecipient = new NoteRecipient(
    serial,
    NoteScript.p2id(),
    mkStorage(sdk, [requester.suffix(), requester.prefix()]),
  );
  const payoutNote = new Note(
    new NoteAssets([new FungibleAsset(dusdc, DRIP_AMOUNT)]),
    new NoteMetadata(dispenser, NoteType.Public, NoteTag.withAccountTarget(requester)),
    payoutRecipient,
  );

  return {
    noteB64: toB64(dripNote.serialize()),
    payoutId: payoutNote.id().toString(),
    noteId: dripNote.id().toString(),
  };
}

// View-call tx scripts: `call` the faucet's own procs so they run in the faucet
// account context (the same Invocation:call the deposit note uses). Executed via
// executeProgram — a LOCAL view (no proof, no submit, no key), reading exactly
// what the deposit note settles against.
const SUPPLY_TX_MASM = `use miden::core::sys
use miden::standards::faucets::fungible
begin
    call.fungible::get_token_supply
    exec.sys::truncate_stack
end
`;
const COMPUTE_V_TX_MASM = `use miden::core::sys
use darwin::price_oracle
begin
    call.price_oracle::compute_v
    exec.sys::truncate_stack
end
`;

/** Live NAV state of a basket faucet: supply S and vault value V (USD*1e8). */
export interface FaucetNav {
  supply: bigint;
  vaultValue: bigint;
}

/** Signature of the `txScript` compiler from `useCompile()`. */
type CompileTxScript = (opts: {
  code: string;
  libraries?: Array<{ namespace: string; code: string; linking: "static" | "dynamic" }>;
}) => Promise<unknown>;

/** Signature of `execute` from `useExecuteProgram()` — returns the 16-felt stack. */
type ExecuteProgram = (opts: {
  accountId: string;
  script: unknown;
  /** Foreign accounts referenced by the script (e.g. Pragma for an FPI read). */
  foreignAccounts?: (string | unknown)[];
  skipSync?: boolean;
}) => Promise<{ stack: bigint[] }>;

/**
 * Pragma oracle account on Miden testnet — the foreign account the FPI note reads
 * medians from via execute_foreign_procedure. Its id is hardcoded in
 * pragma_fpi.masm (PRAGMA_PRE/SUF). A LOCAL FPI read must supply it to
 * executeProgram's `foreignAccounts` (the network's NTB loads it lazily on-chain;
 * a local view call can't, so we provide it explicitly).
 */
export const PRAGMA_ORACLE_ID = "0x7ad4aa02b1816c117e32853e210c28";

/** Pre-compiled NAV-read scripts (supply + compute_v). */
export interface NavReadScripts {
  supplyScript: unknown;
  vScript: unknown;
}

/**
 * Compile the two NAV-read tx scripts in the BROWSER via `useCompile().txScript`.
 * Split from the exec step because the compiler does NOT self-lock — the caller
 * runs this inside runExclusive, while the exec (readFaucetNavBrowser) runs
 * OUTSIDE it (useExecuteProgram self-locks; nesting would deadlock).
 */
export async function compileNavReadScripts(txScript: CompileTxScript): Promise<NavReadScripts> {
  const [supplyScript, vScript] = await Promise.all([
    txScript({ code: SUPPLY_TX_MASM }),
    txScript({ code: COMPUTE_V_TX_MASM, libraries: NAV_NOTE_LIBRARIES }),
  ]);
  return { supplyScript, vScript };
}

/**
 * Browser equivalent of `readFaucetNav`, using the flat web-client hooks instead
 * of the Node wrapper API (`client.accounts/compile/transactions` don't exist on
 * the WebClient). Runs the pre-compiled scripts as local view calls via
 * `useExecuteProgram` — which self-locks, so this MUST be called OUTSIDE any
 * runExclusive block. The faucet account must already be imported (do it under
 * the lock beforehand, e.g. via ensureSignerAccountLoaded).
 */
export async function readFaucetNavBrowser(
  executeProgram: ExecuteProgram,
  faucetId: string,
  scripts: NavReadScripts,
): Promise<FaucetNav> {
  const supplyRes = await executeProgram({ accountId: faucetId, script: scripts.supplyScript, skipSync: true });
  const vRes = await executeProgram({ accountId: faucetId, script: scripts.vScript, skipSync: true });
  const top = (r: { stack: bigint[] }): bigint => BigInt(r.stack?.[0] ?? 0n);
  const supply = top(supplyRes);
  const vaultValue = top(vRes);
  // Safety net: an empty read (both 0) means either the faucet isn't synced, the
  // client couldn't run the view call, or the stack ordering isn't what we expect.
  // Any of those would mint against a wrong NAV — so bail and let the caller fall
  // back to the (proven) server build instead of stranding funds in a bad note.
  // A live basket always has supply>0; a genuinely-fresh faucet (both 0) is also
  // correctly handled server-side, so this is safe either way.
  if (supply === 0n && vaultValue === 0n) {
    throw new Error("empty NAV read (faucet unsynced or unexpected stack shape) — using server build");
  }
  return { supply, vaultValue };
}

/**
 * The FPI compute_v view. The deposit note prices at V by running two ops before
 * it drains the collateral: `exec.pragma_fpi::load_prices` (reads the 3 live
 * medians via execute_foreign_procedure into mem[230..232]) then
 * `call.price_oracle::compute_v` (the faucet's own FPI oracle, which sources
 * prices from that memory). Reproducing that EXACT sequence here yields the exact
 * pre-deposit V the note settles against — so even at S>0 the client mint
 * prediction is felt-exact (matching whatever the on-chain note computes, whether
 * or not the exec→call boundary shares memory: identical MASM ⇒ identical V).
 */
const COMPUTE_V_FPI_TX_MASM = `use miden::core::sys
use darwin::pragma_fpi
use darwin::price_oracle
begin
    exec.pragma_fpi::load_prices
    call.price_oracle::compute_v
    exec.sys::truncate_stack
end
`;

/**
 * FPI variant of {@link compileNavReadScripts}: the compute_v view links the FPI
 * libraries (pragma_fpi + the FPI price oracle) and runs load_prices first.
 */
export async function compileNavReadScriptsFpi(txScript: CompileTxScript): Promise<NavReadScripts> {
  const [supplyScript, vScript] = await Promise.all([
    txScript({ code: SUPPLY_TX_MASM }),
    txScript({ code: COMPUTE_V_FPI_TX_MASM, libraries: NAV_NOTE_FPI_LIBRARIES }),
  ]);
  return { supplyScript, vScript };
}

/**
 * Pragma's single testnet publisher account for the CURRENT oracle iteration.
 * get_median reads its `pragma::publisher::entries` map, keyed by the pair word
 * [0,0,0,index], so a local FPI read must supply it as a foreign account carrying
 * those keys. Verbatim from darwin-relay/pragma/read_pragma.rs (the working Rust
 * reader) — Pragma rotates both the oracle and publisher between iterations, so
 * these two constants move together.
 */
export const PRAGMA_PUBLISHER_ID = "0x6d37b2d4aedd697140338bb31c67e3";

/** Pragma's publisher entries storage-map slot. */
const PRAGMA_ENTRIES_SLOT = "pragma::publisher::entries";

/**
 * DCC constituent Pragma pair indices, in the order pragma_fpi.masm::load_prices
 * reads them: BTC=1 (prices the dWBTC constituent — Pragma testnet publishes BTC,
 * not WBTC, and DCC is BTC exposure), ETH=2, USDT=4. The read must expose the
 * publisher's entries for exactly these pairs (a get_median for an un-exposed pair
 * can't resolve its get_map_item and the FPI read faults).
 */
const FPI_PAIR_INDICES = [1n, 2n, 4n];

/**
 * The foreign-account descriptors get_median needs for a LOCAL FPI read: the
 * oracle (no storage requirement — AccountStorageRequirements::default) plus the
 * publisher, with its entries map keyed on each queried pair word. Mirrors
 * read_pragma.rs's ForeignAccount setup exactly. Both accounts must already be
 * imported (importAccountById) so the client holds their public state.
 */
async function pragmaFpiForeignAccounts(): Promise<unknown[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = (await import("@miden-sdk/miden-sdk")) as any;
  const keys = FPI_PAIR_INDICES.map(
    (idx) => new sdk.Word(new BigUint64Array([0n, 0n, 0n, idx])),
  );
  const entriesReq = sdk.AccountStorageRequirements.fromSlotAndKeysArray([
    new sdk.SlotAndKeys(PRAGMA_ENTRIES_SLOT, keys),
  ]);
  return [
    { id: PRAGMA_PUBLISHER_ID, storage: entriesReq },
    PRAGMA_ORACLE_ID, // oracle needs no storage req (default) — see read_pragma.rs
  ];
}

/**
 * FPI variant of {@link readFaucetNavBrowser}. The compute_v view runs
 * execute_foreign_procedure(get_median) against Pragma, which reads the oracle AND
 * its publisher's entries — so BOTH must be supplied to the local execution via
 * `foreignAccounts` with the right storage requirements (a local view call can't
 * lazily load foreign accounts the way the on-chain NTB does). Returns the exact S
 * and Pragma-priced V the on-chain note settles against — no par fallback needed at
 * S>0. Like the feed read, an all-zero result throws so the caller can fall back.
 */
export async function readFaucetNavBrowserFpi(
  executeProgram: ExecuteProgram,
  faucetId: string,
  scripts: NavReadScripts,
): Promise<FaucetNav> {
  const foreignAccounts = await pragmaFpiForeignAccounts();
  const supplyRes = await executeProgram({ accountId: faucetId, script: scripts.supplyScript, skipSync: true });
  const vRes = await executeProgram({
    accountId: faucetId,
    script: scripts.vScript,
    foreignAccounts,
    skipSync: true,
  });
  const top = (r: { stack: bigint[] }): bigint => BigInt(r.stack?.[0] ?? 0n);
  const supply = top(supplyRes);
  const vaultValue = top(vRes);
  // Reject any INCONSISTENT read, not just the all-zero one. If S>0 the faucet has
  // minted shares, so V MUST be >0 (a live vault); V==0 there means a Pragma leg
  // resolved to 0 or the publisher wasn't synced. computeMintAmount would then price at
  // PAR while the on-chain note prices at real NAV → mint mismatch → unconsumable
  // payback → stranded funds. S==0 (genuinely fresh faucet, first deposit) is the only
  // case where par is correct, and both being 0 is the unsynced case.
  if (vaultValue === 0n && supply !== 0n) {
    throw new Error("inconsistent FPI NAV read (S>0 but V=0 — Pragma unsynced) — retry");
  }
  if (supply === 0n && vaultValue === 0n) {
    throw new Error("empty FPI NAV read (faucet unsynced or Pragma unavailable) — retry");
  }
  return { supply, vaultValue };
}

/**
 * Read a NAV faucet's live S (get_token_supply) and V (compute_v) ON-CHAIN,
 * fully client-side — the browser equivalent of nav_status.rs. `client` is the
 * @miden-sdk MidenClient. Imports the faucet's public state, then runs the two
 * proc roots as local view calls. These are the exact values the deposit note
 * settles against, so feeding them to computeMintAmount predicts the mint
 * felt-exact (par only holds while S==0 — a fresh faucet's first deposit).
 */
export async function readFaucetNav(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  faucetId: string,
): Promise<FaucetNav> {
  const sdk = await import("@miden-sdk/miden-sdk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { AccountId } = sdk as any;
  const faucet = AccountId.fromHex(faucetId);
  await client.accounts.getOrImport(faucetId); // fetch the faucet's public state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const felt0 = (arr: any): bigint => {
    const f = arr.at ? arr.at(0) : arr[0];
    return BigInt(f.asInt ? f.asInt() : f.toString());
  };
  const supplyScript = await client.compile.txScript({ code: SUPPLY_TX_MASM });
  const supply = felt0(await client.transactions.executeProgram({ account: faucet, script: supplyScript }));
  const vScript = await client.compile.txScript({ code: COMPUTE_V_TX_MASM, libraries: NAV_NOTE_LIBRARIES });
  const vaultValue = felt0(await client.transactions.executeProgram({ account: faucet, script: vScript }));
  return { supply, vaultValue };
}

// A random note serial (Word of 4 felts) with the high bit cleared, matching the
// native rand_word (& 0xFFFF_FFFE_FFFF_FFFF) so every felt is in-field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function randWord(sdk: any) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const view = new DataView(bytes.buffer);
  const felts = [];
  for (let i = 0; i < 4; i++) {
    const v = view.getBigUint64(i * 8, true) & 0xffff_fffe_ffff_ffffn;
    felts.push(new sdk.Felt(v));
  }
  return sdk.Word.newFromFelts(felts);
}

// A NoteScript from useCompile() is bound to the web-client's (worker) WASM
// instance; a constructor from a freshly `import()`-ed sdk rejects it with
// "expected instance of rh". Round-trip through this sdk's (de)serializer to rebind
// it to the local instance. No-op if it's already local (or lacks serialize).
// A NoteScript from useCompile() may be bound to the web-client's worker WASM
// instance; round-trip through this sdk's (de)serializer to rebind it. No-op if it's
// already local or lacks serialize.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeScript(NoteScriptCls: any, script: any): any {
  try {
    if (typeof script?.serialize === "function" && typeof NoteScriptCls?.deserialize === "function") {
      return NoteScriptCls.deserialize(script.serialize());
    }
  } catch {
    /* fall through — use the original script */
  }
  return script;
}

// NoteStorage requires a FeltArray, NOT a plain Felt[]. A plain array throws
// "expected instance of rh" in the browser's st WASM build (the node build coerced
// silently, which is why this only failed in the browser). Always wrap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkStorage(sdk: any, felts: any[]): any {
  return new sdk.NoteStorage(new sdk.FeltArray(felts));
}

/** Chunk-Words per backup note — MUST match backup_write_note.masm's unrolled count. */
const BACKUP_CHUNKS_PER_NOTE = 24;

/**
 * The backup_write network note-script (@note_script form), compiled client-side.
 * It calls set_user_position by MAST root, so it links NO darwin libraries — its
 * root (0xb5237847…) matches the deployed backup controller's allowlist.
 */
export const BACKUP_WRITE_NOTE_MASM: string = backupWriteNoteMasm;

/** Compile the backup_write note-script in the browser (no libraries). */
export async function compileBackupWriteScript(noteScript: CompileNoteScript): Promise<unknown> {
  return noteScript({ code: backupWriteNoteMasm });
}

/**
 * Build the N backup network notes (serialized b64) that persist `encryptedBytes`
 * into the backup controller's slot-10 StorageMap, keyed by (suffix, prefix) — the
 * server-free replacement for /api/backup-write (the Mac relay).
 *
 * Payload = the packed chunk Words, then a meta entry [byteLen, nWords] at
 * BACKUP_META_INDEX. Batched BACKUP_CHUNKS_PER_NOTE per note; the last note's spare
 * slots pad with the meta entry REPEATED — idempotent (same key, same value), never
 * a zero-index chunk (that would clobber chunk 0). Each note is a no-asset network
 * note carrying the entries as storage inputs + a NetworkAccountTarget at the
 * controller, so the NTB consumes it and applies the 24 set_user_position writes.
 * Emit ALL notes in ONE tx (withOwnOutputNotes): the NTB may consume them in any
 * order, but recovery's AES-GCM decrypt fails on a partial read, so the caller just
 * retries until every chunk has landed.
 */
export async function buildBackupNotes(
  backupScript: unknown,
  params: {
    signer: string;
    controller: string;
    suffix: bigint;
    prefix: bigint;
    encryptedBytes: Uint8Array;
  },
): Promise<{ notesB64: string[]; nWords: number }> {
  const sdk = await import("@miden-sdk/miden-sdk");
  const {
    AccountId,
    NoteScript,
    NoteRecipient,
    NoteType,
    NoteTag,
    NoteMetadata,
    NoteAssets,
    NetworkAccountTarget,
    Note,
    Felt,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = sdk as any;

  const signer = AccountId.fromHex(params.signer);
  const controller = AccountId.fromHex(params.controller);
  const script = normalizeScript(NoteScript, backupScript);

  const words = packBytesToWords(params.encryptedBytes);
  const meta = {
    index: BACKUP_META_INDEX,
    value: [BigInt(params.encryptedBytes.length), BigInt(words.length), 0n, 0n],
  };
  const entries: { index: bigint; value: bigint[] }[] = words.map((w, i) => ({
    index: BigInt(i),
    value: w,
  }));
  entries.push(meta);
  while (entries.length % BACKUP_CHUNKS_PER_NOTE !== 0) entries.push(meta);

  const notesB64: string[] = [];
  for (let start = 0; start < entries.length; start += BACKUP_CHUNKS_PER_NOTE) {
    const batch = entries.slice(start, start + BACKUP_CHUNKS_PER_NOTE);
    // storage felts: [suffix, prefix, (index, f0, f1, f2, f3) × 24] = 122 felts,
    // exactly the mem[100..221] layout backup_write_note.masm reads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const felts: any[] = [new Felt(params.suffix), new Felt(params.prefix)];
    for (const e of batch) {
      felts.push(
        new Felt(e.index),
        new Felt(e.value[0] ?? 0n),
        new Felt(e.value[1] ?? 0n),
        new Felt(e.value[2] ?? 0n),
        new Felt(e.value[3] ?? 0n),
      );
    }
    const note = Note.withAttachments(
      new NoteAssets([]),
      new NoteMetadata(signer, NoteType.Public, NoteTag.withAccountTarget(controller)),
      new NoteRecipient(randWord(sdk), script, mkStorage(sdk, felts)),
      [new NetworkAccountTarget(controller).toAttachment()],
    );
    notesB64.push(toB64(note.serialize()));
  }
  return { notesB64, nWords: words.length };
}

/**
 * Emit the encrypted account-file backup as network notes — the server-free
 * replacement for writeOnchainBackupViaMac. Builds the chunk notes and submits
 * them in ONE transaction (withOwnOutputNotes) via the client's worker-forwarded
 * submit path (proves off the main thread → no UI freeze); the NTB then consumes
 * each note and applies its writes to the backup controller. Returns nWords.
 *
 * `backupScript` must be pre-compiled by the caller via useCompile().noteScript
 * (the WebClient has no compile namespace) — see compileBackupWriteScript.
 */
export async function writeOnchainBackupViaNetwork(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  backupScript: unknown;
  signer: string;
  controller: string;
  suffix: bigint;
  prefix: bigint;
  encryptedBytes: Uint8Array;
}): Promise<number> {
  // Build (WASM note construction) + submit under ONE lock: submitNewTransaction is
  // the raw client method (the useTransaction hook is what normally self-locks), and
  // any concurrent WASM op (e.g. the background balance poll) would double-borrow the
  // client's RefCell and panic "already borrowed" — the same hazard as the FPI buy.
  return params.runExclusive(async () => {
    const { notesB64, nWords } = await buildBackupNotes(params.backupScript, {
      signer: params.signer,
      controller: params.controller,
      suffix: params.suffix,
      prefix: params.prefix,
      encryptedBytes: params.encryptedBytes,
    });
    const sdk = await import("@miden-sdk/miden-sdk");
    const {
      AccountId,
      Note,
      NoteArray,
      TransactionRequestBuilder,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } = sdk as any;
    const notes = notesB64.map((b64) =>
      Note.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    );
    const request = new TransactionRequestBuilder()
      .withOwnOutputNotes(new NoteArray(notes))
      .build();
    await params.client.submitNewTransaction(AccountId.fromHex(params.signer), request);
    return nWords;
  });
}

// DCC mint fee = 30 bps; the on-chain note uses net = D*100*(10000-30)/10000.
const FEE_COMPLEMENT = 9970n;

/**
 * The exact shares the network will mint for `amount` dUSDC, from the faucet's
 * live `supply` (S) and vault value `V` (both from /api/nav-status). Mirrors
 * send_nav_deposit.rs / the on-chain note byte-for-byte:
 *   net = amount * 100 * (10000 - fee_bps) / 10000        (USD*1e8, after fee)
 *   shares = (S == 0 || V == 0) ? net : net * S / V        (integer division)
 * Integer division matches the note's `felt_div` for these in-field operands.
 */
export function computeMintAmount(amount: bigint, supply: bigint, vaultValue: bigint): bigint {
  const net = (amount * 100n * FEE_COMPLEMENT) / 10000n;
  if (supply > 0n && vaultValue > 0n) return (net * supply) / vaultValue;
  return net;
}

/**
 * The dUSDC the network will release for burning `shares` (basket token, 8-dec),
 * from live `supply` (S) and vault value `V`. Mirrors nav_redeem_note.masm:
 *   V == 0 (par, unpriced vault) → release = shares / 100            (8-dec → 6-dec)
 *   else                        → release = shares * V / S / 100      (pro-rata NAV)
 * Integer division matches the note's felt_div. Needed to reconstruct the payback
 * dUSDC note at the exact released amount so it stays consumable.
 */
export function computeReleaseAmount(shares: bigint, supply: bigint, vaultValue: bigint): bigint {
  if (vaultValue === 0n || supply === 0n) return shares / 100n;
  return (shares * vaultValue) / supply / 100n;
}

export interface ClientDepositParams {
  /** Basket faucet (network account) the note targets, hex. */
  faucet: string;
  /** Executing sender (the user's Miden account), hex. */
  sender: string;
  /** Recipient of the minted shares (usually === sender), hex. */
  recipient: string;
  /** dUSDC faucet id, hex. */
  dusdcFaucet: string;
  /** dUSDC collateral drained by the note, base units (6-dec). */
  amount: bigint;
  /** Shares minted into the payback, read from the faucet's live NAV on-chain. */
  mintAmount: bigint;
}

export interface ClientDepositNote {
  /** Public deposit note bytes, base64 — emit as an own-output-note. */
  noteB64: string;
  /** Payback NoteFile bytes, base64 — import + consume once the network mints. */
  paybackFileB64: string;
  noteId: string;
  paybackId: string;
}

// Chunked base64 of a byte array (avoids the arg-count blowup of btoa(String
// .fromCharCode(...big))).
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Build the confidential NAV deposit note ENTIRELY client-side — the faithful
 * port of send_nav_deposit.rs. `navScript` is the compiled NoteScript from
 * `compileNavDepositScript`. Returns the deposit note (to emit via
 * `useCreateNetworkNote` / own-output-note) and the payback P2ID note (kept so it
 * can be reconstructed + consumed once the network mints it).
 *
 * fee_factor / nav_scale are 1 (legacy no-ops on-chain, kept for storage parity).
 */
export async function buildClientDepositNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  navScript: any,
  params: ClientDepositParams,
): Promise<ClientDepositNote> {
  const sdk = await import("@miden-sdk/miden-sdk");
  const {
    AccountId,
    Felt,
    NoteStorage,
    NoteScript,
    NoteRecipient,
    NoteType,
    NoteTag,
    NoteMetadata,
    NoteAssets,
    FungibleAsset,
    NetworkAccountTarget,
    Note,
    NoteFile,
    OutputNote,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = sdk as any;

  const faucet = AccountId.fromHex(params.faucet);
  const sender = AccountId.fromHex(params.sender);
  const recipient = AccountId.fromHex(params.recipient);
  const dusdc = AccountId.fromHex(params.dusdcFaucet);

  // Private P2ID payback (a specific serial we keep to reconstruct + consume it).
  // Storage is EXACTLY the standard P2idNoteStorage layout — [suffix, prefix], 2
  // felts, no padding (miden_standards P2idNoteStorage::NUM_ITEMS == 2). Any extra
  // felt still yields a valid recipient digest (so the note id matches + import
  // finds it) but makes the minted note UN-consumable — the P2ID script asserts
  // exactly 2 storage items.
  const paybackSerial = randWord(sdk);
  const p2idStorage = mkStorage(sdk, [recipient.suffix(), recipient.prefix()]);
  const paybackRecipient = new NoteRecipient(paybackSerial, NoteScript.p2id(), p2idStorage);
  const paybackTag = NoteTag.withAccountTarget(recipient);
  const paybackNote = new Note(
    new NoteAssets([new FungibleAsset(faucet, params.mintAmount)]),
    new NoteMetadata(faucet, NoteType.Private, paybackTag),
    paybackRecipient,
  );

  // Deposit note storage = 9 felts the on-chain script reads at offsets 100..108:
  // payback recipient digest (100..103), note_type=Private (104), payback tag
  // (105), collateral amount (106), fee_factor=1 (107), nav_scale=1 (108).
  const digest = paybackRecipient.digest().toFelts();
  const inputs = [
    ...digest,
    new Felt(0n), // NoteType::Private
    new Felt(BigInt(paybackTag.asU32())),
    new Felt(params.amount),
    new Felt(1n), // fee_factor
    new Felt(1n), // nav_scale
  ];
  // navScript may be compiled in the web-client's worker WASM instance; rebind it
  // to this sdk instance so the NoteRecipient constructor accepts it (no-op locally).
  const navScriptLocal = normalizeScript(NoteScript, navScript);
  const depositRecipient = new NoteRecipient(randWord(sdk), navScriptLocal, mkStorage(sdk, inputs));

  // Public note carrying the dUSDC collateral, tagged + attached to the network
  // faucet so the NTB drains it + mints shares.
  const depositNote = Note.withAttachments(
    new NoteAssets([new FungibleAsset(dusdc, params.amount)]),
    new NoteMetadata(sender, NoteType.Public, NoteTag.withAccountTarget(faucet)),
    depositRecipient,
    [new NetworkAccountTarget(faucet).toAttachment()],
  );

  return {
    noteB64: toB64(depositNote.serialize()),
    // NoteFile.fromOutputNote wants an OutputNote — wrap the Note via OutputNote.full.
    paybackFileB64: toB64(NoteFile.fromOutputNote(OutputNote.full(paybackNote)).serialize()),
    noteId: depositNote.id().toString(),
    paybackId: paybackNote.id().toString(),
  };
}

export interface ClientRedeemParams {
  /** Basket faucet (network account) the redeem note targets, hex. */
  faucet: string;
  /** Redeemer (sender + payback recipient), hex. */
  redeemer: string;
  /** dUSDC faucet id, hex (the released collateral). */
  dusdcFaucet: string;
  /** Basket-token shares to burn, base units (8-dec). */
  shares: bigint;
  /** dUSDC released to the payback, from the faucet's live NAV (6-dec). */
  release: bigint;
}

/**
 * Build the confidential NAV redeem note ENTIRELY client-side — the inverse of
 * buildClientDepositNote and the faithful port of send_nav_redeem.rs. The note
 * carries the SHARES to burn; the network burns them, prices the pro-rata claim
 * at the live NAV, and releases dUSDC into the private P2ID payback. Storage
 * embeds the payback recipient (100..103), note_type/tag (104/105), and the
 * dUSDC release asset KEY+VALUE (108..115) whose amount felt is patched on-chain.
 */
export async function buildClientRedeemNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redeemScript: any,
  params: ClientRedeemParams,
): Promise<ClientDepositNote> {
  const sdk = await import("@miden-sdk/miden-sdk");
  const {
    AccountId,
    Felt,
    NoteStorage,
    NoteScript,
    NoteRecipient,
    NoteType,
    NoteTag,
    NoteMetadata,
    NoteAssets,
    FungibleAsset,
    NetworkAccountTarget,
    Note,
    NoteFile,
    OutputNote,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = sdk as any;

  const faucet = AccountId.fromHex(params.faucet);
  const redeemer = AccountId.fromHex(params.redeemer);
  const dusdc = AccountId.fromHex(params.dusdcFaucet);

  // Private P2ID payback carrying the ACTUAL released dUSDC (canonical 2-felt
  // storage — see buildClientDepositNote).
  const paybackSerial = randWord(sdk);
  const p2idStorage = mkStorage(sdk, [redeemer.suffix(), redeemer.prefix()]);
  const paybackRecipient = new NoteRecipient(paybackSerial, NoteScript.p2id(), p2idStorage);
  const paybackTag = NoteTag.withAccountTarget(redeemer);
  const paybackNote = new Note(
    new NoteAssets([new FungibleAsset(dusdc, params.release)]),
    new NoteMetadata(faucet, NoteType.Private, paybackTag),
    paybackRecipient,
  );

  // Storage = 16 felts: payback digest (100..103), note_type Private (104), tag
  // (105), pad (106,107), dUSDC release asset KEY (108..111) + VALUE (112..115).
  // The amount at 112 is a placeholder the on-chain note patches to the real
  // NAV-priced release; the payback above carries that exact `release`.
  const releaseAsset = new FungibleAsset(dusdc, params.release);
  const digest = paybackRecipient.digest().toFelts();
  const inputs = [
    ...digest,
    new Felt(0n), // note_type Private
    new Felt(BigInt(paybackTag.asU32())),
    new Felt(0n), // 106 pad
    new Felt(0n), // 107 pad
    ...releaseAsset.vaultKey().toFelts(), // 108..111 dUSDC KEY
    ...releaseAsset.intoWord().toFelts(), // 112..115 dUSDC VALUE (amount patched on-chain)
  ];
  // Rebind the hook-compiled script to this sdk instance — see normalizeScript.
  const redeemScriptLocal = normalizeScript(NoteScript, redeemScript);
  const redeemRecipient = new NoteRecipient(randWord(sdk), redeemScriptLocal, mkStorage(sdk, inputs));

  // Public note carrying the shares to burn, tagged + attached to the faucet.
  const redeemNote = Note.withAttachments(
    new NoteAssets([new FungibleAsset(faucet, params.shares)]),
    new NoteMetadata(redeemer, NoteType.Public, NoteTag.withAccountTarget(faucet)),
    redeemRecipient,
    [new NetworkAccountTarget(faucet).toAttachment()],
  );

  return {
    noteB64: toB64(redeemNote.serialize()),
    paybackFileB64: toB64(NoteFile.fromOutputNote(OutputNote.full(paybackNote)).serialize()),
    noteId: redeemNote.id().toString(),
    paybackId: paybackNote.id().toString(),
  };
}
