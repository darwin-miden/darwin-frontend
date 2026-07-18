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
import {
  useAccount,
  useCompile,
  useImportAccount,
  useSyncState,
} from "@miden-sdk/react";
import { useEffect, useMemo, useState } from "react";

import type { Basket } from "../lib/baskets";
import { buildDarwinNoteRequest } from "../lib/midenNote";
import { basketNav, usePrices } from "../lib/prices";

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
  const compile = useCompile();
  const prices = usePrices();
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

  // The MidenFi extension only hands us the wallet address; it doesn't
  // hydrate the WebClient's local account store. tx.execute() needs
  // an account record in that store to sign + prove, otherwise it
  // fails with "account data wasn't found for account id 0x…". The
  // pattern: query useAccount(address) to see if the record is already
  // local; if not, importAccount({type: "id", accountId}) fetches it
  // from the network and stores it. Runs once per wallet connection.
  const {
    account: walletAccount,
    isLoading: walletAccountLoading,
    getBalance,
  } = useAccount(address ?? undefined);
  const { importAccount, isImporting, error: importError } = useImportAccount();
  const [importTriedFor, setImportTriedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!address || walletAccountLoading || walletAccount) return;
    if (importTriedFor === address || isImporting) return;
    setImportTriedFor(address);
    importAccount({ type: "id", accountId: address }).catch((e) => {
      console.warn("[MidenDepositPanel] importAccount failed", e);
    });
  }, [
    address,
    walletAccount,
    walletAccountLoading,
    isImporting,
    importTriedFor,
    importAccount,
  ]);

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

  // Per-asset wallet balance (base units, asset-decimal scaled). Falls
  // back to 0 when the account record isn't loaded yet — the deposit
  // button validation below treats 0 the same as "not loaded" so a
  // mid-import click doesn't fire a doomed transaction.
  const assetBalance: bigint = useMemo(() => {
    if (!asset || !walletAccount) return 0n;
    try {
      return getBalance(asset.id);
    } catch {
      return 0n;
    }
  }, [asset, walletAccount, getBalance]);

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

  const controllerId = BASKET_CONTROLLER_ID[basket.symbol];

  async function handleSend() {
    if (!asset || !controllerId || !address) return;
    if (!wallet.requestTransaction) {
      setTxState({
        isLoading: false,
        stage: null,
        txId: null,
        error: "wallet.requestTransaction not available",
      });
      return;
    }
    const base = 10n ** BigInt(asset.decimals);
    const microHuman = BigInt(Math.floor(parseFloat(amount || "0") * 1_000_000));
    const units = (microHuman * base) / 1_000_000n;
    setTxState({ isLoading: true, stage: "building note", txId: null, error: null });
    try {
      // Resolve sender address to an AccountId (bech32 vs hex sniff)
      // even though we don't pass it to the wallet — buildDarwinNote
      // still needs the parsed form internally.
      const senderAccountId = /^0x[0-9a-f]+$/i.test(address)
        ? AccountId.fromHex(address)
        : AccountId.fromBech32(address);
      void senderAccountId;

      setTxState((s) => ({ ...s, stage: "compiling MASM" }));
      // Resolve basket NAV from the cached price feed; without it
      // the script defaults to amount × 9970 / 10000 which conflates
      // asset base units with basket base units and credits ~300×
      // the actual USD value of the deposit on a $30k-NAV basket.
      const basketNavUsd = basketNav(basket, prices.data) ?? null;
      const priceUsd = ASSET_PRICE_USD[asset.id] ?? null;
      const mathFelts =
        basketNavUsd && priceUsd
          ? computeStorageFelts(units, asset.decimals, priceUsd, basketNavUsd)
          : undefined;

      const txRequest = await buildDarwinNoteRequest(compile, {
        // v2 calls set_user_position after receive_asset so the
        // controller credits the user's slot-10 entry, which the
        // portfolio panel reads to display a non-zero basket
        // position. The 7-felt note storage (3 math + 2 user_id +
        // 2 basket_id felts) is filled by buildDarwinNoteRequest
        // automatically — basket_id ensures DCC/DAG/DCO deposits
        // hit distinct slot-10 entries instead of sharing one.
        kind: "atomic-deposit-v2",
        sender: address,
        controller: controllerId,
        faucetId: asset.id,
        amount: units,
        basketFaucetId: BASKET_TOKEN_FAUCET[basket.symbol],
        storageFelts: mathFelts,
      });

      // Use the MidenFi extension's custom-transaction path. The
      // extension renders its own popup which signs natively (handles
      // miden::protocol::auth::request internally), bypassing the
      // WebClient's prover-side auth chain that doesn't have a
      // MidenFi handler bound to it.
      setTxState((s) => ({ ...s, stage: "waiting for MidenFi popup" }));
      // Transaction.createCustomTransaction returns a fully-shaped
      // MidenTransaction ({type, payload}); pass it directly to
      // requestTransaction without wrapping.
      const midenTx = Transaction.createCustomTransaction(
        address,
        controllerId,
        txRequest,
      );
      const txId = await wallet.requestTransaction(midenTx);
      setTxState({ isLoading: false, stage: null, txId, error: null });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setTxState({ isLoading: false, stage: null, txId: null, error: msg });
      console.error("miden deposit failed", e);
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
        Compile <code>atomic_deposit_note.masm</code> in your browser,
        wrap your asset, and submit a STARK-proved transaction from your
        Miden wallet (<code>{address.slice(0, 10)}…</code>) to the{" "}
        {basket.symbol} controller (
        <code>{controllerId?.slice(0, 14)}…</code>).
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
          isLoading || !asset || insufficient || belowMin || !walletAccount
        }
        style={{
          width: "100%",
          padding: "12px 16px",
          background:
            isLoading || insufficient || belowMin || !walletAccount
              ? "var(--ink-3)"
              : "var(--ink)",
          color: "var(--paper)",
          border: 0,
          cursor:
            isLoading || insufficient || belowMin || !walletAccount
              ? "not-allowed"
              : "pointer",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        {isLoading
          ? `${stage ?? "Working"}…`
          : !walletAccount
          ? "loading wallet account…"
          : insufficient
          ? `Insufficient ${asset?.label ?? ""} — mint from faucet first`
          : belowMin
          ? `Min deposit ${minHuman} ${asset?.label ?? ""} (~$1) — fees dominate below`
          : `Deposit ${amount} ${asset?.label ?? ""} → ${basket.symbol}`}
      </button>

      {insufficient && walletAccount && (
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

      {(isImporting || importError) && (
        <p
          style={{
            marginTop: 8,
            fontSize: 11,
            color: importError ? "#a01a1a" : "var(--ink-3)",
            fontFamily: "var(--font-mono-stack)",
          }}
        >
          {isImporting
            ? "importing wallet account into local store…"
            : `import warning: ${String(importError?.message ?? importError)}`}
        </p>
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
