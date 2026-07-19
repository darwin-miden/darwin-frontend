"use client";

/**
 * Miden-native deposit panel. Mirrors the ETH-side `DepositPanel`
 * shape but talks directly to Miden via the Miden Web SDK — no
 * relay, no AggLayer hop, no wrapped ERC20.
 *
 * Flow: user picks an asset they hold on Miden (dETH, dWBTC, dUSDT,
 * dDAI from the testnet faucets), enters an amount, signs a P2ID
 * note from their MidenFi wallet to the basket controller. The
 * controller consumes the note in a separate tx and credits the
 * user's basket-token position.
 *
 * For the initial launch we keep the UX intentionally simple: one asset
 * at a time. a future iteration will swap `useSend` for `useCompile` + a custom
 * multi-asset DepositNote built from the bundled .masp package.
 */

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import { AccountId } from "@miden-sdk/miden-sdk";
import { useSyncState } from "@miden-sdk/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Basket } from "../lib/baskets";
import { logActivity } from "../lib/activityLog";

interface Props {
  basket: Basket;
}

import {
  ASSET_FAUCETS as ASSET_FAUCET_CATALOGUE,
  BASKET_TOKEN_FAUCETS,
  EPOCH_DUSDC_FAUCET_ID,
  FEE_ROUTING_CONTROLLER_ID,
  type BasketSymbol as MidenBasketSymbol,
} from "../lib/midenConstants";

// Reshape into the local <label, id, decimals> shape this panel uses.
// `useSend.assetId` accepts any `AccountRef` form (hex, bech32,
// AccountId object).
const ASSET_FAUCETS: Record<string, { label: string; id: string; decimals: number }> =
  Object.fromEntries(
    Object.entries(ASSET_FAUCET_CATALOGUE).map(([slug, a]) => [
      slug,
      { label: a.symbol, id: a.id, decimals: a.decimals },
    ]),
  );

// Basket-token faucet IDs from the central registry. The
// atomic-deposit-v2 script reads the basket faucet's (suffix, prefix)
// felts and uses them as the basket_id half of the slot-10 map key.
const BASKET_TOKEN_FAUCET: Record<string, string> = Object.fromEntries(
  Object.entries(BASKET_TOKEN_FAUCETS).map(([sym, f]) => [sym, f.id]),
);
const BASKET_CONTROLLER_ID: Record<string, string> = Object.fromEntries(
  (Object.keys(BASKET_TOKEN_FAUCETS) as MidenBasketSymbol[]).map((s) => [
    s,
    FEE_ROUTING_CONTROLLER_ID,
  ]),
);

// Constituent faucet -> spot price (USD), keyed by AccountId hex.
const ASSET_PRICE_USD: Record<string, number> = Object.fromEntries(
  Object.values(ASSET_FAUCET_CATALOGUE).map((a) => [a.id, a.referencePriceUsd]),
);
const BASKET_TOKEN_DECIMALS = 8;

// Suggest a deposit amount that lands around ~$50 of value, so the
// default field is the same order of magnitude whether the user picks
// dWBTC ($60k) or dUSDT ($1). A flat default of "10" would mean $20k
// for dETH and $600k for dWBTC — both well beyond what testnet
// faucets dispense and visually wrong.
function defaultAmountFor(asset: { id: string }): string {
  const price = ASSET_PRICE_USD[asset.id] ?? 1;
  const raw = 50 / price;
  if (raw >= 10) return Math.round(raw).toString();
  if (raw >= 1) return raw.toFixed(1);
  if (raw >= 0.1) return raw.toFixed(2);
  if (raw >= 0.01) return raw.toFixed(3);
  return raw.toFixed(4);
}

// Economic minimum per deposit, in human-asset units. Anchored to
// roughly $1 of value across the board:
//   * 30 bps protocol fee + 2 Miden txs behind each deposit (user
//     note tx + controller drain tx) means anything under ~$1 is
//     dominated by overhead — fee on a $0.50 deposit is <$0.002
//     and the per-tx prover time (~1.5s in browser) is the same
//     whether the user deposits $0.50 or $50.
//   * Round numbers picked by hand instead of computed from price so
//     the gate stays stable when price feed moves (we don't want the
//     UI to slide between "0.000016" and "0.000018" depending on
//     today's BTC quote).
const MIN_AMOUNT_HUMAN: Record<string, string> = Object.fromEntries(
  Object.values(ASSET_FAUCET_CATALOGUE).map((a) => [a.id, a.minAmountHuman]),
);

// dUSDC (Epoch's — the SAME token the Sepolia rail delivers). Not a basket
// constituent; offered as a stable collateral so both rails share one token.
// It's a $1 stable, so the deposit math values it 1:1 with USD. 6-dec.
const DUSDC_OPTION = { label: "dUSDC", id: EPOCH_DUSDC_FAUCET_ID, decimals: 6 };
ASSET_PRICE_USD[DUSDC_OPTION.id] = 1;
MIN_AMOUNT_HUMAN[DUSDC_OPTION.id] = "1";

function minAmountUnitsFor(asset: { id: string; decimals: number }): bigint {
  const human = MIN_AMOUNT_HUMAN[asset.id] ?? "0";
  const microHuman = BigInt(Math.floor(parseFloat(human) * 1_000_000));
  return (microHuman * 10n ** BigInt(asset.decimals)) / 1_000_000n;
}

function formatUnits(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = units % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

// Derive the felts the atomic_deposit_note_v2 script reads from
// storage so its `mint = deposit_value * fee_factor / nav_scale` runs
// in correct dimensional units.
//
// Goal:
//   mint_basket_base = (amount_asset_base * asset_price_usd / basket_nav_usd)
//                      * 10^(basket_dec - asset_dec)
//                      * fee
//
// Implementation: deposit_value carries `amount * asset_price_usd` and
// nav_scale absorbs the basket NAV plus the decimal alignment.
//   deposit_value = amount * asset_price
//   fee_factor    = 9970                                          (0.9970 in 1e4 fp)
//   nav_scale     = basket_nav * 10000 * 10^(asset_dec - basket_dec)
// → mint = amount * asset_price * 9970 / (basket_nav * 10000 * 10^(asset_dec-basket_dec))
//        = amount * asset_price * 10^(basket_dec - asset_dec) * 0.9970 / basket_nav ✓
//
// For dUSDT (6 dec) → DCC (8 dec) @ NAV $30126:
//   nav_scale = 30126 * 10000 * 10^(6-8) = 30126 * 100 ≈ 3_012_600
//   for amount = 10e6 (10 dUSDT @ $1):
//   mint = 10e6 * 1 * 9970 / 3_012_600 ≈ 33_090 base units = 0.000331 DCC
//   ⇒ value 0.000331 × $30126 ≈ $9.97  ✓
function computeStorageFelts(
  amountAssetBase: bigint,
  assetDecimals: number,
  assetPriceUsd: number,
  basketNavUsd: number,
): [bigint, bigint, bigint] {
  // Derivation:
  //   mint_basket_base = amount * asset_price * 10^(basket_dec - asset_dec) / basket_nav
  //   with fee:        = above × 9970/10000
  // The on-chain script computes `mint = deposit_value × fee / nav_scale`
  // (felt_div is integer division), so we pre-pack the units into
  // (deposit_value, nav_scale) such that the divide lands on the right
  // integer mint.
  //
  //   deposit_value = amount × asset_price
  //   nav_scale     = basket_nav × 10000 / 10^(basket_dec - asset_dec)
  //
  // For dUSDT (6 dec, $1) → DCC (8 dec) @ NAV $30126:
  //   nav_scale = 30126 × 10000 / 100 = 3_012_600
  //   amount = 10e6, fee = 9970:
  //   mint = 10e6 × 1 × 9970 / 3_012_600 = 33_090 base units = 0.000331 DCC
  //   ⇒ value 0.000331 × $30126 ≈ $9.97  ✓
  const depositValue = amountAssetBase * BigInt(Math.round(assetPriceUsd));
  const navFlat = BigInt(Math.max(1, Math.round(basketNavUsd)));
  const basketMinusAssetDec = BASKET_TOKEN_DECIMALS - assetDecimals;

  let navScale = navFlat * 10_000n;
  if (basketMinusAssetDec > 0) {
    // asset has fewer decimals than basket (dUSDT 6 → 8) — divide
    navScale = navScale / 10n ** BigInt(basketMinusAssetDec);
    if (navScale === 0n) navScale = 1n;
  } else if (basketMinusAssetDec < 0) {
    // asset has more decimals than basket (dETH 18 → 8) — multiply
    navScale = navScale * 10n ** BigInt(-basketMinusAssetDec);
  }
  return [depositValue, 9_970n, navScale];
}

export function MidenDepositPanel({ basket }: Props) {
  const wallet = useMidenFiWallet();
  const { connected, address } = wallet;
  const { syncHeight } = useSyncState();
  // useTransaction() drives the WebClient's transaction prover directly,
  // which raises `miden::protocol::auth::request` for the wallet to
  // sign — but the MidenFi extension hasn't wired its auth handler on
  // that path (assertion 1324136…). Use wallet.requestTransaction with
  // a Custom payload instead: the extension's own UI signs natively.
  const [txState, setTxState] = useState<{
    isLoading: boolean;
    stage: string | null;
    txId: string | null;
    error: string | null;
  }>({ isLoading: false, stage: null, txId: null, error: null });

  // The deposit is signed + proved by MidenFi (wallet.requestTransaction), so we
  // do NOT hydrate the WebClient's account store — for a private MidenFi wallet
  // that import fails ("account is private, details cannot be retrieved") and
  // used to jam the panel on "loading balance…" with a 0 balance. Read
  // the balance straight from MidenFi instead (below), exactly like the faucet.

  const assetOptions = useMemo(
    () => [
      // dUSDC first — the shared, bridge-identical collateral. Deposit the
      // dUSDC you already hold (from the faucet), no per-constituent picking.
      DUSDC_OPTION,
      ...basket.constituents
        .map((c) => ASSET_FAUCETS[c.faucetAlias])
        .filter((a): a is { label: string; id: string; decimals: number } =>
          Boolean(a),
        ),
    ],
    [basket],
  );

  const [assetIdx, setAssetIdx] = useState(0);
  const asset = assetOptions[assetIdx];
  const [amount, setAmount] = useState<string>(() =>
    asset ? defaultAmountFor(asset) : "0",
  );
  // Re-suggest a price-aware default when the user switches asset —
  // "0.025 dETH" and "50 dUSDT" carry the same USD weight, so reusing
  // the previous numeric value across assets is almost always wrong.
  const [lastDefaultAssetId, setLastDefaultAssetId] = useState<string | null>(
    asset?.id ?? null,
  );
  useEffect(() => {
    if (!asset) return;
    if (asset.id === lastDefaultAssetId) return;
    setAmount(defaultAmountFor(asset));
    setLastDefaultAssetId(asset.id);
  }, [asset, lastDefaultAssetId]);

  // Per-asset wallet balance, read straight from MidenFi (requestAssets) — the
  // wallet is a private account the web client can't read. Match the selected
  // asset's faucet id, canonicalising hex/bech32 on both sides. `balanceLoaded`
  // gates the button so a click before the balance is known can't fire a doomed
  // tx (and so the button doesn't jam on a never-loading web-client account).
  const [assetBalance, setAssetBalance] = useState<bigint>(0n);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const refreshBalance = useCallback(async () => {
    if (!wallet.requestAssets || !asset) return;
    try {
      const assets = await wallet.requestAssets();
      const canon = (s: string) => {
        if (/^0x[0-9a-fA-F]+$/.test(s)) return s.toLowerCase();
        try {
          return AccountId.fromBech32(s).toString().toLowerCase();
        } catch {
          return s.toLowerCase();
        }
      };
      const want = canon(asset.id);
      const hit = assets.find((a) => canon(a.faucetId) === want);
      setAssetBalance(hit ? BigInt(hit.amount) : 0n);
      setBalanceLoaded(true);
    } catch {
      /* keep last known balance */
    }
  }, [wallet, asset]);
  useEffect(() => {
    if (connected) void refreshBalance();
  }, [connected, refreshBalance]);

  const balanceHuman = useMemo(() => {
    if (!asset) return "0";
    const base = 10n ** BigInt(asset.decimals);
    const whole = assetBalance / base;
    const frac = assetBalance % base;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(asset.decimals, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  }, [asset, assetBalance]);

  const requestedUnits: bigint = useMemo(() => {
    if (!asset) return 0n;
    const base = 10n ** BigInt(asset.decimals);
    const microHuman = BigInt(Math.floor(parseFloat(amount || "0") * 1_000_000));
    return (microHuman * base) / 1_000_000n;
  }, [asset, amount]);

  const insufficient = !!asset && requestedUnits > assetBalance;
  const minUnits = useMemo(
    () => (asset ? minAmountUnitsFor(asset) : 0n),
    [asset],
  );
  const belowMin =
    !!asset && requestedUnits > 0n && requestedUnits < minUnits;
  const minHuman = useMemo(
    () => (asset ? formatUnits(minUnits, asset.decimals) : "0"),
    [asset, minUnits],
  );

  if (!connected || !address) {
    return (
      <div
        style={{
          padding: "1.2rem 1.4rem",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>Connect a Miden wallet</h3>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 14,
            lineHeight: 1.55,
            marginTop: 8,
            marginBottom: 0,
          }}
        >
          For the Miden-native path you need a Miden wallet (MidenFi browser
          extension, Para, or Turnkey). Click <em>Connect Miden</em> in the
          top nav. Already on Ethereum? Switch to the <em>Ethereum (Sepolia)</em>
          {" "}tab and the relay handles everything.
        </p>
      </div>
    );
  }

  async function handleSend() {
    if (!asset || !address) return;
    if (!wallet.requestTransaction || !wallet.requestConsume) {
      setTxState({
        isLoading: false,
        stage: null,
        txId: null,
        error: "wallet does not expose requestTransaction/requestConsume",
      });
      return;
    }
    // The confidential rail deposits dUSDC collateral and mints basket tokens
    // 1:1 from the REAL drained collateral (audit-hardened) into a private note.
    // Only dUSDC is supported for now.
    if (asset.id !== EPOCH_DUSDC_FAUCET_ID) {
      setTxState({
        isLoading: false,
        stage: null,
        txId: null,
        error: "Miden-wallet deposits take dUSDC — pick dUSDC (mint it on /faucet).",
      });
      return;
    }
    const units = requestedUnits; // dUSDC base units
    setTxState({ isLoading: true, stage: "building deposit", txId: null, error: null });
    try {
      const { AccountId, Address, Note, NoteArray, TransactionRequestBuilder } =
        await import("@miden-sdk/miden-sdk");
      // MidenFi hands a bech32 Address (account id + `_interface`); extract the
      // bare account id hex the confidential builder expects.
      let hexId = address;
      if (!/^0x[0-9a-fA-F]+$/.test(address)) {
        try {
          hexId = AccountId.fromBech32(address).toString();
        } catch {
          hexId = Address.fromBech32(address).accountId().toString();
        }
      }
      const b64ToBytes = (b: string) =>
        Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

      // 1. Build the confidential deposit note (drains dUSDC → mints basket
      //    tokens into a PRIVATE payback note for the recipient).
      const r = await fetch("/api/confidential-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: hexId,
          recipient: hexId,
          basket: basket.symbol,
          amount: units.toString(),
        }),
      });
      const built = (await r.json()) as {
        noteB64?: string;
        paybackId?: string;
        paybackFileB64?: string;
        paybackNoteB64?: string;
        mintAmount?: string;
        faucetId?: string;
        error?: string;
      };
      if (!r.ok || !built.noteB64 || !built.paybackFileB64 || !built.paybackId) {
        throw new Error(built.error ?? `confidential-note API ${r.status}`);
      }

      // 2. Emit the deposit note from the MidenFi wallet (it carries the dUSDC).
      setTxState((s) => ({ ...s, stage: "sign deposit in MidenFi" }));
      const depositNote = Note.deserialize(b64ToBytes(built.noteB64));
      const emitReq = new TransactionRequestBuilder()
        .withOwnOutputNotes(new NoteArray([depositNote]))
        .build();
      await wallet.requestTransaction!(
        Transaction.createCustomTransaction(address, built.faucetId!, emitReq),
      );

      // 3. Wait for the network to mint the basket-token payback, polling the
      //    node for its id (a read, no wallet prompt) so we claim as soon as
      //    it's committed instead of a blind wait.
      setTxState((s) => ({ ...s, stage: "network minting your position…" }));
      let ready = false;
      for (let i = 0; i < 50 && !ready; i++) {
        try {
          const st = await fetch(`/api/note-status?id=${built.paybackId}`);
          const j = await st.json();
          if (j.committed) ready = true;
        } catch {
          /* not committed yet */
        }
        if (!ready) await new Promise((res) => setTimeout(res, 3_000));
      }
      if (!ready) {
        throw new Error(
          "the network hasn't minted your position yet — wait a few seconds and click again",
        );
      }

      // 4. Claim the private minted-token note: import its details into the
      //    wallet (a private/confidential note can't be discovered on-chain, so
      //    MidenFi needs the note staged), then consume it. Two prompts — the
      //    unavoidable cost of a CONFIDENTIAL balance (a public payout, like the
      //    faucet, skips the import; but that would expose the balance).
      setTxState((s) => ({ ...s, stage: "sign import in MidenFi" }));
      try {
        await wallet.importPrivateNote?.(b64ToBytes(built.paybackFileB64));
      } catch {
        /* may already be imported */
      }
      setTxState((s) => ({ ...s, stage: "sign claim in MidenFi" }));
      const txId = await wallet.requestConsume!({
        faucetId: built.faucetId!,
        noteId: built.paybackId,
        noteType: "private",
        amount: Number(built.mintAmount ?? units),
      });
      if (wallet.waitForTransaction) {
        await wallet.waitForTransaction(txId, 90_000).catch(() => {});
      }
      setTxState({ isLoading: false, stage: null, txId, error: null });
      logActivity(address, {
        type: "deposit",
        basket: basket.symbol,
        amount,
      });
      void refreshBalance();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setTxState({ isLoading: false, stage: null, txId: null, error: msg });
      console.error("miden confidential deposit failed", e);
    }
  }

  const isLoading = txState.isLoading;
  const stage = txState.stage;
  const result = txState.txId ? { transactionId: txState.txId } : null;
  const error = txState.error ? { message: txState.error } : null;

  return (
    <div
      style={{
        padding: "1.2rem 1.4rem",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>
        Miden-native deposit → {basket.symbol}
      </h3>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 13,
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 8,
        }}
      >
        Deposit dUSDC from your MidenFi wallet (
        <code>{address.slice(0, 10)}…</code>). The Miden network drains your
        collateral and mints {basket.symbol} tokens 1:1 into a{" "}
        <strong>private note</strong> you consume — confidential balance,
        no server, no operator. Because the balance is private, claiming it
        takes two prompts (import + consume) after the deposit.
      </p>
      <p
        style={{
          color: "var(--ink-3)",
          fontSize: 11,
          fontFamily: "var(--font-mono-stack)",
          marginTop: 0,
          marginBottom: 14,
        }}
      >
        same pipeline verified end-to-end on testnet:{" "}
        <a
          href="https://testnet.midenscan.com/tx/0x7116c2f040ccbb38435bef812b23c56d00ea3cff4838a0e7b1bfd8d8f45dc995"
          target="_blank"
          rel="noreferrer"
          style={{ borderBottom: "1px dotted var(--rule)" }}
        >
          user tx
        </a>{" "}
        +{" "}
        <a
          href="https://testnet.midenscan.com/tx/0xde449dfcbf4d182eff7b0122754f874019aff2498dbb768e8d1ce26039e689ac"
          target="_blank"
          rel="noreferrer"
          style={{ borderBottom: "1px dotted var(--rule)" }}
        >
          consumer tx
        </a>{" "}
        @ block 792643
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <select
          value={assetIdx}
          onChange={(e) => setAssetIdx(parseInt(e.target.value, 10))}
          style={{
            padding: "10px 12px",
            fontFamily: "var(--font-mono-stack)",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
          }}
        >
          {assetOptions.map((a, i) => (
            <option key={a.id} value={i}>
              {a.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={0}
          step="any"
          style={{
            flex: 1,
            padding: "10px 12px",
            fontFamily: "var(--font-mono-stack)",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
          }}
        />
      </div>

      <div
        style={{
          marginBottom: 8,
          fontSize: 11,
          fontFamily: "var(--font-mono-stack)",
          color: "var(--ink-3)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>
          your {asset?.label ?? ""} balance:{" "}
          <span style={{ color: insufficient ? "#a01a1a" : "var(--ink-2)" }}>
            {balanceHuman}
          </span>
          <span style={{ marginLeft: 12, color: "var(--ink-3)" }}>
            min {minHuman} {asset?.label ?? ""} (~$1)
          </span>
        </span>
        {insufficient ? (
          <span style={{ color: "#a01a1a" }}>
            need {amount} {asset?.label}, have {balanceHuman}
          </span>
        ) : belowMin ? (
          <span style={{ color: "#a01a1a" }}>
            below min ({minHuman} {asset?.label})
          </span>
        ) : null}
      </div>

      <button
        onClick={handleSend}
        disabled={
          isLoading || !asset || insufficient || belowMin || !balanceLoaded
        }
        style={{
          width: "100%",
          padding: "12px 16px",
          background:
            isLoading || insufficient || belowMin || !balanceLoaded
              ? "var(--ink-3)"
              : "var(--ink)",
          color: "var(--paper)",
          border: 0,
          cursor:
            isLoading || insufficient || belowMin || !balanceLoaded
              ? "not-allowed"
              : "pointer",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        {isLoading
          ? `${stage ?? "Working"}…`
          : !balanceLoaded
          ? "loading balance…"
          : insufficient
          ? `Insufficient ${asset?.label ?? ""} — mint from faucet first`
          : belowMin
          ? `Min deposit ${minHuman} ${asset?.label ?? ""} (~$1) — fees dominate below`
          : `Deposit ${amount} ${asset?.label ?? ""} → ${basket.symbol}`}
      </button>

      {insufficient && balanceLoaded && (
        <a
          href="/faucet"
          className="nav-cta"
          style={{
            display: "inline-block",
            marginTop: 12,
            fontSize: 13,
            textDecoration: "none",
          }}
        >
          Get test {asset?.label ?? "tokens"} from the faucet →
        </a>
      )}

      {result?.transactionId && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--ink-3)" }}>
          Tx submitted: <code>{result.transactionId.slice(0, 16)}…</code>
        </p>
      )}

      {error && (
        <pre
          style={{
            marginTop: 10,
            padding: 10,
            background: "#fff0f0",
            fontSize: 11,
            overflowX: "auto",
            color: "#a01a1a",
          }}
        >
          {String(error.message ?? error)}
        </pre>
      )}

      <p
        style={{
          marginTop: 12,
          fontSize: 11,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
        }}
      >
        sync: {syncHeight ? `block ${syncHeight}` : "…"}
      </p>
    </div>
  );
}
