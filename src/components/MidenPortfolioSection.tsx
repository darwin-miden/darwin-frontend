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
  useTransactionHistory,
  useSyncState,
} from "@miden-sdk/react";

// Same source of truth as MidenDepositPanel: testnet faucet IDs from
// darwin-baskets/state/testnet.toml. Symbol + decimals make the
// table render without an extra round-trip to `useAssetMetadata`.
const FAUCETS: { label: string; id: string; decimals: number }[] = [
  { label: "dETH",  id: "0xa095d9b3831e96206ff70c2218a6a9", decimals: 6 },
  { label: "dWBTC", id: "0x7a45cb24ada22120246bcf54196e12", decimals: 6 },
  { label: "dUSDT", id: "0xd3789f451ddd4720602ba9eb1a268d", decimals: 6 },
  { label: "dDAI",  id: "0xb526deb0408a29207e4f27ed57bf1a", decimals: 6 },
];

const V2_CONTROLLER_ID = "0xa25aa0b00007688024b74b05a52aab";

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

      <div
        style={{
          marginTop: 24,
          padding: "16px 20px",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--ink-3)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>Redeem from controller</h3>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 13,
            lineHeight: 1.55,
            margin: "8px 0 0",
          }}
        >
          The v2 controller (
          <code>{V2_CONTROLLER_ID.slice(0, 14)}…</code>) emits a private
          payout note per constituent on redeem. The browser-side flow
          (custom note from <code>RedeemNote.masp</code>) lands in the
          next release. In the meantime, hit{" "}
          <a
            href={`https://testnet.midenscan.com/account/${V2_CONTROLLER_ID}`}
            target="_blank"
            rel="noreferrer"
            style={{ borderBottom: "1px dotted var(--rule)" }}
          >
            the controller on Midenscan
          </a>{" "}
          to inspect open positions.
        </p>
      </div>

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
