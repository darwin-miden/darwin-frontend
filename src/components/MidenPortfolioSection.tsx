"use client";

/**
 * Miden-side portfolio panel rendered on /portfolio next to the
 * Sepolia ERC20 view. Shows:
 *
 *   - which Miden wallet is connected (or a connect CTA);
 *   - the user's fungible balances for each constituent faucet
 *     (dETH, dWBTC, dUSDT, dDAI);
 *   - the last few transactions the in-browser client synced;
 *   - a deep-link to the v2 controller on the Miden explorer.
 *
 * Reads everything through `@miden-sdk/react` hooks, which hit the
 * WASM client + IndexedDB store. No server roundtrip.
 *
 * The Miden-native redeem flow (controller emits per-constituent
 * payout notes) is wired in the next iteration once we ship the
 * RedeemNote.masp package as a static asset; for now this section
 * shows the read view and links out to the deposit panel.
 */

import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import {
  useAccount,
  useCompile,
  useConsume,
  useNotes,
  useTransaction,
  useTransactionHistory,
  useSyncState,
} from "@miden-sdk/react";
import { useState } from "react";

import { buildDarwinNoteRequest } from "../lib/midenNote";

import {
  basketBySymbol,
  type BasketSymbol,
} from "../lib/baskets";
import { basketNav, usePrices } from "../lib/prices";

// Same source of truth as MidenDepositPanel: testnet faucet IDs from
// the 2026-05-14 deploy (miden_testnet_state.md). Hardcoding symbol
// + decimals avoids an extra round-trip to `useAssetMetadata`.
const FAUCETS: { label: string; id: string; decimals: number }[] = [
  { label: "dETH",  id: "0xa095d9b3831e96206ff70c2218a6a9", decimals: 18 },
  { label: "dWBTC", id: "0x7a45cb24ada22120246bcf54196e12", decimals: 8  },
  { label: "dUSDT", id: "0xd3789f451ddd4720602ba9eb1a268d", decimals: 6  },
  { label: "dDAI",  id: "0xb526deb0408a29207e4f27ed57bf1a", decimals: 18 },
];

// Basket-token faucets — what gets minted to the user when their
// deposit settles. Reading these tells the user how much of each
// basket they own on the Miden side.
const BASKET_TOKEN_FAUCETS: { symbol: string; id: string; decimals: number }[] = [
  { symbol: "DCC", id: "0x2066f2da1f91ba202af5251d39101c", decimals: 8 },
  { symbol: "DAG", id: "0xfb6811fd6399df206d44f62800620d", decimals: 8 },
  { symbol: "DCO", id: "0xbe4efc6729eb3220423b7d6d6a0942", decimals: 8 },
];

// v2 real-bodies controller — the one with a working `receive_asset`.
// Flow A end-to-end verified on testnet 2026-05-17:
//   user tx     0x7116c2f0…45dc995 (block 792643)
//   consumer tx 0xde449dfc…39e689ac (block 792643)
//   note        0x24d9b1fc…7e22f09b
const REAL_BODIES_CONTROLLER_ID = "0xa25aa0b00007688024b74b05a52aab";
const BASKET_CONTROLLER_ID: Record<string, string> = {
  DCC: REAL_BODIES_CONTROLLER_ID,
  DAG: REAL_BODIES_CONTROLLER_ID,
  DCO: REAL_BODIES_CONTROLLER_ID,
};

function fmtUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const frac = amount % base;
  if (frac === 0n) return integer.toString();
  return `${integer}.${frac
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "")}`;
}

export function MidenPortfolioSection() {
  const { connected, address } = useMidenFiWallet();
  const { syncHeight } = useSyncState();
  const accountResult = useAccount(address ?? undefined);
  const controllerVault = useAccount(REAL_BODIES_CONTROLLER_ID);
  const history = useTransactionHistory({});

  if (!connected || !address) {
    return (
      <section style={{ marginTop: 48 }}>
        <h2
          style={{
            fontSize: 14,
            fontFamily: "var(--font-mono-stack)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            borderBottom: "1px solid var(--ink)",
            paddingBottom: 8,
            marginBottom: 20,
          }}
        >
          Miden-native positions
        </h2>
        <div
          style={{
            padding: "20px 24px",
            background: "var(--paper-2)",
            borderLeft: "3px solid var(--orange)",
          }}
        >
          <p
            style={{
              color: "var(--ink-2)",
              fontSize: 14,
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            Connect a Miden wallet (top nav → <em>Connect Miden</em>) to see
            balances of the basket constituent faucets and route a Miden-
            native deposit straight to the controller — no relay hop.
          </p>
        </div>
      </section>
    );
  }

  const balances = FAUCETS.map((f) => ({
    ...f,
    amount: accountResult.getBalance(f.id),
  }));

  const prices = usePrices();
  const notesQuery = useNotes({ accountId: address ?? undefined });
  const { consume, isLoading: consuming, stage: consumeStage } = useConsume();
  const compile = useCompile();
  const redeemTx = useTransaction();
  const [burningSymbol, setBurningSymbol] = useState<string | null>(null);

  const basketBalances = BASKET_TOKEN_FAUCETS.map((b) => {
    const amount = accountResult.getBalance(b.id);
    const manifest = basketBySymbol(b.symbol as BasketSymbol);
    const nav = basketNav(manifest, prices.data);
    const human = Number(amount) / 10 ** b.decimals;
    const usd = nav == null ? null : human * nav;
    return {
      ...b,
      amount,
      controller: BASKET_CONTROLLER_ID[b.symbol],
      usd,
    };
  });

  return (
    <section style={{ marginTop: 48 }}>
      <h2
        style={{
          fontSize: 14,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          borderBottom: "1px solid var(--ink)",
          paddingBottom: 8,
          marginBottom: 20,
        }}
      >
        Miden-native positions
      </h2>

      <p
        style={{
          fontSize: 13,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
          marginBottom: 16,
        }}
      >
        wallet <code>{address}</code> · synced to block{" "}
        {syncHeight || "…"}
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr
            style={{
              borderBottom: "1px solid var(--rule)",
              color: "var(--ink-3)",
              fontSize: 11,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            <th style={{ textAlign: "left", padding: "10px 12px" }}>Asset</th>
            <th style={{ textAlign: "right", padding: "10px 12px" }}>
              Wallet balance
            </th>
            <th style={{ textAlign: "left", padding: "10px 12px" }}>
              Faucet ID
            </th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => (
            <tr
              key={b.id}
              style={{ borderBottom: "1px solid var(--rule-2)" }}
            >
              <td style={{ padding: "14px 12px", fontWeight: 500 }}>
                {b.label}
              </td>
              <td
                style={{
                  padding: "14px 12px",
                  textAlign: "right",
                  fontFamily: "var(--font-mono-stack)",
                  color: b.amount > 0n ? "var(--ink)" : "var(--ink-3)",
                }}
              >
                {fmtUnits(b.amount, b.decimals)}
              </td>
              <td
                style={{
                  padding: "14px 12px",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 12,
                  color: "var(--ink-3)",
                }}
              >
                {b.id.slice(0, 14)}…
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3
        style={{
          marginTop: 32,
          fontSize: 12,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        Basket positions (Miden basket-token faucets)
      </h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr
            style={{
              borderBottom: "1px solid var(--rule)",
              color: "var(--ink-3)",
              fontSize: 11,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            <th style={{ textAlign: "left", padding: "10px 12px" }}>Basket</th>
            <th style={{ textAlign: "right", padding: "10px 12px" }}>
              Position
            </th>
            <th style={{ textAlign: "right", padding: "10px 12px" }}>
              USD value
            </th>
            <th style={{ textAlign: "left", padding: "10px 12px" }}>
              Controller
            </th>
          </tr>
        </thead>
        <tbody>
          {basketBalances.map((b) => (
            <tr key={b.id} style={{ borderBottom: "1px solid var(--rule-2)" }}>
              <td style={{ padding: "14px 12px", fontWeight: 500 }}>
                {b.symbol}
              </td>
              <td
                style={{
                  padding: "14px 12px",
                  textAlign: "right",
                  fontFamily: "var(--font-mono-stack)",
                  color: b.amount > 0n ? "var(--ink)" : "var(--ink-3)",
                }}
              >
                {fmtUnits(b.amount, b.decimals)}
              </td>
              <td
                style={{
                  padding: "14px 12px",
                  textAlign: "right",
                  fontFamily: "var(--font-mono-stack)",
                  color: b.amount > 0n ? "var(--ink)" : "var(--ink-3)",
                }}
              >
                {b.usd == null
                  ? "—"
                  : b.usd >= 1
                    ? `$${b.usd.toFixed(2)}`
                    : `$${b.usd.toFixed(4)}`}
              </td>
              <td
                style={{
                  padding: "14px 12px",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 12,
                }}
              >
                <a
                  href={`https://testnet.midenscan.com/account/${b.controller}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: "var(--ink-3)",
                    borderBottom: "1px dotted var(--rule)",
                  }}
                >
                  {b.controller?.slice(0, 14)}…
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3
        style={{
          marginTop: 32,
          fontSize: 12,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        Controller vault (aggregate state, all users)
      </h3>
      <p
        style={{
          fontSize: 12,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
          marginTop: 0,
          marginBottom: 10,
        }}
      >
        v2 real-bodies <code>{REAL_BODIES_CONTROLLER_ID}</code> — read via
        useAccount() from your browser-side Miden client. The controller's
        per-user storage map lands in M4 once the controller exposes
        addressable position slots; for now this aggregate vault state
        is the on-chain truth.
      </p>
      {controllerVault.isLoading ? (
        <p style={{ color: "var(--ink-3)", fontSize: 12 }}>loading vault…</p>
      ) : controllerVault.assets.length === 0 ? (
        <p style={{ color: "var(--ink-3)", fontSize: 12 }}>
          vault is empty (no successful deposits consumed yet).
        </p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            marginBottom: 8,
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: "1px solid var(--rule)",
                color: "var(--ink-3)",
                fontSize: 11,
                fontFamily: "var(--font-mono-stack)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              <th style={{ textAlign: "left", padding: "8px 12px" }}>Asset</th>
              <th style={{ textAlign: "right", padding: "8px 12px" }}>
                Vault balance
              </th>
            </tr>
          </thead>
          <tbody>
            {controllerVault.assets.map((a) => {
              // Try to label known faucets; fall back to short hex.
              const knownConst = FAUCETS.find(
                (f) => f.id.toLowerCase() === a.assetId.toLowerCase(),
              );
              const knownBasket = BASKET_TOKEN_FAUCETS.find(
                (f) => f.id.toLowerCase() === a.assetId.toLowerCase(),
              );
              const label =
                knownConst?.label ??
                knownBasket?.symbol ??
                a.assetId.slice(0, 12) + "…";
              const decimals =
                knownConst?.decimals ?? knownBasket?.decimals ?? 0;
              return (
                <tr
                  key={a.assetId}
                  style={{ borderBottom: "1px solid var(--rule-2)" }}
                >
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{ fontWeight: 500 }}>{label}</span>{" "}
                    <span
                      style={{
                        color: "var(--ink-3)",
                        fontFamily: "var(--font-mono-stack)",
                        fontSize: 11,
                      }}
                    >
                      {a.assetId.slice(0, 14)}…
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      textAlign: "right",
                      fontFamily: "var(--font-mono-stack)",
                    }}
                  >
                    {fmtUnits(a.amount, decimals)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3
        style={{
          marginTop: 32,
          fontSize: 12,
          fontFamily: "var(--font-mono-stack)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        Redeem (burn basket-token, controller emits payout notes)
      </h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
        }}
      >
        {basketBalances.map((b) => {
          const isBurning = burningSymbol === b.symbol && redeemTx.isLoading;
          return (
            <button
              key={b.symbol}
              disabled={b.amount === 0n || redeemTx.isLoading}
              onClick={async () => {
                if (!address || !b.controller) return;
                setBurningSymbol(b.symbol);
                try {
                  // Burn the whole position as a first iteration —
                  // partial redeems land once the note accepts a
                  // user-supplied amount via advice inputs.
                  await redeemTx.execute({
                    accountId: address,
                    request: () =>
                      buildDarwinNoteRequest(compile, {
                        kind: "atomic-redeem",
                        sender: address,
                        controller: b.controller!,
                        faucetId: b.id,
                        amount: b.amount,
                      }),
                  });
                } catch (e) {
                  console.error("miden redeem failed", e);
                }
              }}
              style={{
                padding: "10px 12px",
                background:
                  b.amount === 0n
                    ? "var(--paper-2)"
                    : isBurning
                      ? "var(--ink-3)"
                      : "var(--ink)",
                color:
                  b.amount === 0n
                    ? "var(--ink-3)"
                    : "var(--paper)",
                border:
                  b.amount === 0n
                    ? "1px solid var(--rule)"
                    : 0,
                cursor: b.amount === 0n ? "not-allowed" : "pointer",
                fontSize: 12,
                textAlign: "left",
              }}
            >
              <div style={{ fontWeight: 500 }}>
                Burn all {b.symbol}
              </div>
              <div
                style={{
                  fontSize: 11,
                  marginTop: 2,
                  fontFamily: "var(--font-mono-stack)",
                  opacity: 0.85,
                }}
              >
                {isBurning
                  ? `${redeemTx.stage ?? "redeeming"}…`
                  : b.amount === 0n
                    ? "no position"
                    : `${fmtUnits(b.amount, b.decimals)} units`}
              </div>
            </button>
          );
        })}
      </div>
      {redeemTx.error && (
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
          {String(redeemTx.error.message ?? redeemTx.error)}
        </pre>
      )}
      {redeemTx.result?.transactionId && (
        <p
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono-stack)",
          }}
        >
          redeem tx <code>{redeemTx.result.transactionId.slice(0, 18)}…</code>{" "}
          — payout notes land in the Inbox below once committed.
        </p>
      )}

      <section style={{ marginTop: 32 }}>
        <h3
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            margin: "0 0 10px",
          }}
        >
          Inbox — claimable notes ({notesQuery.consumableNotes.length})
        </h3>
        {notesQuery.isLoading ? (
          <p style={{ color: "var(--ink-3)", fontSize: 12 }}>loading…</p>
        ) : notesQuery.consumableNotes.length === 0 ? (
          <p style={{ color: "var(--ink-3)", fontSize: 12 }}>
            nothing to claim. Deposits and redeems will land here as
            private notes that you sign to materialize the asset in your
            wallet.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {notesQuery.consumableNoteSummaries.slice(0, 6).map((n) => (
              <li
                key={n.id}
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 12,
                  color: "var(--ink-2)",
                  padding: "6px 0",
                  borderBottom: "1px dotted var(--rule-2)",
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <code style={{ flex: 1 }}>{n.id.slice(0, 18)}…</code>
                <span style={{ color: "var(--ink-3)" }}>
                  {n.assets.length} asset
                  {n.assets.length === 1 ? "" : "s"}
                </span>
                <button
                  onClick={() =>
                    consume({
                      accountId: address!,
                      notes: [n.id],
                    }).catch((e) => console.error("consume", e))
                  }
                  disabled={consuming}
                  style={{
                    padding: "4px 10px",
                    background: consuming ? "var(--ink-3)" : "var(--ink)",
                    color: "var(--paper)",
                    border: 0,
                    cursor: consuming ? "not-allowed" : "pointer",
                    fontSize: 11,
                  }}
                >
                  {consuming ? `${consumeStage ?? "claiming"}…` : "Claim"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h3
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            margin: "0 0 10px",
          }}
        >
          Recent Miden transactions
        </h3>
        {history.isLoading ? (
          <p style={{ color: "var(--ink-3)", fontSize: 12 }}>loading…</p>
        ) : history.records.length === 0 ? (
          <p style={{ color: "var(--ink-3)", fontSize: 12 }}>
            no transactions yet — sign one from any basket page.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {history.records.slice(0, 5).map((r) => {
              const idHex = r.id().toHex();
              const st = r.transactionStatus();
              const label = st.isCommitted()
                ? `committed @ block ${st.getBlockNum()}`
                : st.isDiscarded()
                  ? "discarded"
                  : "pending";
              return (
                <li
                  key={idHex}
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: 12,
                    color: "var(--ink-2)",
                    padding: "6px 0",
                    borderBottom: "1px dotted var(--rule-2)",
                  }}
                >
                  <code>{idHex.slice(0, 18)}…</code> · {label}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
