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
import {
  Transaction,
  TransactionType,
} from "@miden-sdk/miden-wallet-adapter-base";
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

interface Props {
  basket: Basket;
}

// Asset faucet ids on Miden testnet (deploy 2026-05-14), with real
// decimals. `useSend.assetId` accepts any `AccountRef` form (hex,
// bech32, AccountId object).
const ASSET_FAUCETS: Record<string, { label: string; id: string; decimals: number }> = {
  "darwin-eth":  { label: "dETH",  id: "0xa095d9b3831e96206ff70c2218a6a9", decimals: 18 },
  "darwin-wbtc": { label: "dWBTC", id: "0x7a45cb24ada22120246bcf54196e12", decimals: 8  },
  "darwin-usdt": { label: "dUSDT", id: "0xd3789f451ddd4720602ba9eb1a268d", decimals: 6  },
  "darwin-dai":  { label: "dDAI",  id: "0xb526deb0408a29207e4f27ed57bf1a", decimals: 18 },
};

// v2 real-bodies controller — the one with a working `receive_asset`
// proc that the note's `call.0x75f6…` resolves to. v1
// (`0x171f46fecf1bca8005ae068a8dfe77`) doesn't have `receive_asset`,
// so the note would land in its inbox but never get consumed.
//
// Flow A fully verified end-to-end on Miden testnet 2026-05-17 via
// `cargo run -p darwin-protocol-account --bin flow_a_full`:
//   user tx     0x7116c2f040ccbb38435bef812b23c56d00ea3cff4838a0e7b1bfd8d8f45dc995
//   consumer tx 0xde449dfcbf4d182eff7b0122754f874019aff2498dbb768e8d1ce26039e689ac
//   note        0x24d9b1fc90d979c78321b9fc9293e413dada5b590e56c58375333f4c7e22f09b
//   both at block 792643. 100 dETH moved user → note → controller vault;
//   darwin::math::felt_div ran on-chain through the kernel's u64::div event.
const REAL_BODIES_CONTROLLER_ID = "0xa25aa0b00007688024b74b05a52aab";
const BASKET_CONTROLLER_ID: Record<string, string> = {
  DCC: REAL_BODIES_CONTROLLER_ID,
  DAG: REAL_BODIES_CONTROLLER_ID,
  DCO: REAL_BODIES_CONTROLLER_ID,
};

export function MidenDepositPanel({ basket }: Props) {
  const wallet = useMidenFiWallet();
  const { connected, address } = wallet;
  const { syncHeight } = useSyncState();
  const compile = useCompile();
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
    () =>
      basket.constituents
        .map((c) => ASSET_FAUCETS[c.faucetAlias])
        .filter((a): a is { label: string; id: string; decimals: number } =>
          Boolean(a),
        ),
    [basket],
  );

  const [assetIdx, setAssetIdx] = useState(0);
  const [amount, setAmount] = useState<string>("10");
  const asset = assetOptions[assetIdx];

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
      const txRequest = await buildDarwinNoteRequest(compile, {
        kind: "atomic-deposit",
        sender: address,
        controller: controllerId,
        faucetId: asset.id,
        amount: units,
      });

      // Use the MidenFi extension's custom-transaction path. The
      // extension renders its own popup which signs natively (handles
      // miden::protocol::auth::request internally), bypassing the
      // WebClient's prover-side auth chain that doesn't have a
      // MidenFi handler bound to it.
      setTxState((s) => ({ ...s, stage: "waiting for MidenFi popup" }));
      const customTx = Transaction.createCustomTransaction(
        address,
        controllerId,
        txRequest,
      );
      const txId = await wallet.requestTransaction({
        type: TransactionType.Custom,
        payload: customTx,
      });
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
          step={1}
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
        </span>
        {insufficient && (
          <span style={{ color: "#a01a1a" }}>
            need {amount} {asset?.label}, have {balanceHuman}
          </span>
        )}
      </div>

      <button
        onClick={handleSend}
        disabled={isLoading || !asset || insufficient || !walletAccount}
        style={{
          width: "100%",
          padding: "12px 16px",
          background:
            isLoading || insufficient || !walletAccount
              ? "var(--ink-3)"
              : "var(--ink)",
          color: "var(--paper)",
          border: 0,
          cursor:
            isLoading || insufficient || !walletAccount
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
          : `Deposit ${amount} ${asset?.label ?? ""} → ${basket.symbol}`}
      </button>

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
