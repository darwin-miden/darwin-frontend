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
  const storage = new NoteStorage([requester.suffix(), requester.prefix(), ...serial.toFelts()]);
  const dripNote = Note.withAttachments(
    new NoteAssets([]),
    new NoteMetadata(requester, NoteType.Public, NoteTag.withAccountTarget(dispenser)),
    new NoteRecipient(randWord(sdk), dripScript, storage),
    [new NetworkAccountTarget(dispenser).toAttachment()],
  );

  // Precompute the PUBLIC P2ID payout id (dispenser → requester, 5 dUSDC, same
  // serial) so it matches the on-chain payout the drip creates.
  const payoutRecipient = new NoteRecipient(
    serial,
    NoteScript.p2id(),
    new NoteStorage([requester.suffix(), requester.prefix()]),
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
  const p2idStorage = new NoteStorage([recipient.suffix(), recipient.prefix()]);
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
  const depositRecipient = new NoteRecipient(randWord(sdk), navScript, new NoteStorage(inputs));

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
    paybackFileB64: toB64(NoteFile.fromOutputNote(paybackNote).serialize()),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = sdk as any;

  const faucet = AccountId.fromHex(params.faucet);
  const redeemer = AccountId.fromHex(params.redeemer);
  const dusdc = AccountId.fromHex(params.dusdcFaucet);

  // Private P2ID payback carrying the ACTUAL released dUSDC (canonical 2-felt
  // storage — see buildClientDepositNote).
  const paybackSerial = randWord(sdk);
  const p2idStorage = new NoteStorage([redeemer.suffix(), redeemer.prefix()]);
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
  const redeemRecipient = new NoteRecipient(randWord(sdk), redeemScript, new NoteStorage(inputs));

  // Public note carrying the shares to burn, tagged + attached to the faucet.
  const redeemNote = Note.withAttachments(
    new NoteAssets([new FungibleAsset(faucet, params.shares)]),
    new NoteMetadata(redeemer, NoteType.Public, NoteTag.withAccountTarget(faucet)),
    redeemRecipient,
    [new NetworkAccountTarget(faucet).toAttachment()],
  );

  return {
    noteB64: toB64(redeemNote.serialize()),
    paybackFileB64: toB64(NoteFile.fromOutputNote(paybackNote).serialize()),
    noteId: redeemNote.id().toString(),
    paybackId: paybackNote.id().toString(),
  };
}
