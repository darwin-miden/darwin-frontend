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
  /** The Public deposit note to emit (NetworkAccountTarget attachment). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  depositNote: any;
  /** The private P2ID payback note (reconstruct + consume after the mint). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paybackNote: any;
  noteId: string;
  paybackId: string;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = sdk as any;

  const faucet = AccountId.fromHex(params.faucet);
  const sender = AccountId.fromHex(params.sender);
  const recipient = AccountId.fromHex(params.recipient);
  const dusdc = AccountId.fromHex(params.dusdcFaucet);

  // Private P2ID payback (a specific serial we keep to reconstruct + consume it).
  const paybackSerial = randWord(sdk);
  const p2idStorage = new NoteStorage([recipient.suffix(), recipient.prefix(), new Felt(0n), new Felt(0n)]);
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
    depositNote,
    paybackNote,
    noteId: depositNote.id().toString(),
    paybackId: paybackNote.id().toString(),
  };
}
