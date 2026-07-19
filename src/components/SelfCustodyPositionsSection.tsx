"use client";

/**
 * Self-custody portfolio — the connected wallet's confidential basket positions
 * plus an activity timeline.
 *
 * Positions are the controller's slot-10 entries for the connected EVM address
 * (one row per basket), read over plain HTTP (/api/position) — no Miden hooks,
 * no WASM contention. The mint is 1:1 with the dUSDC collateral, so a position's
 * value in USD is just its size. The activity timeline is the local deposit/
 * withdraw log (see activityLog.ts) so a wallet that has netted back to zero
 * still shows its history.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AccountId } from "@miden-sdk/miden-sdk";

import { BASKET_TOKEN_FAUCETS, type BasketSymbol } from "../lib/midenConstants";
import {
  TRUSTLESS_CONTROLLER_HEX,
  evmToUserIdFelts,
} from "../lib/trustlessController";
import { readActivity, timeAgo, type Activity } from "../lib/activityLog";

const DUSDC_DECIMALS = 6;

function fmt(v: bigint): string {
  const whole = v / 10n ** BigInt(DUSDC_DECIMALS);
  const frac = (v % 10n ** BigInt(DUSDC_DECIMALS))
    .toString()
    .padStart(DUSDC_DECIMALS, "0")
    .slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}

type Row = { symbol: BasketSymbol; position: bigint };

export function SelfCustodyPositionsSection() {
  const { address, isConnected } = useAccount();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [now, setNow] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!address || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setActivity(readActivity(address));
    setNow(Date.now());
    try {
      const { suffix, prefix } = evmToUserIdFelts(address);
      const targets = Object.values(BASKET_TOKEN_FAUCETS).map((b) => {
        const id = AccountId.fromHex(b.id);
        return {
          symbol: b.symbol,
          basketSuffix: id.suffix().asInt().toString(),
          basketPrefix: id.prefix().asInt().toString(),
        };
      });
      const results = await Promise.all(
        targets.map(async (t): Promise<Row> => {
          try {
            const r = await fetch("/api/position", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                suffix: suffix.toString(),
                prefix: prefix.toString(),
                basketSuffix: t.basketSuffix,
                basketPrefix: t.basketPrefix,
                controllerId: TRUSTLESS_CONTROLLER_HEX,
              }),
            });
            const j = r.ok ? ((await r.json()) as { position?: string }) : {};
            return { symbol: t.symbol, position: j.position ? BigInt(j.position) : 0n };
          } catch {
            return { symbol: t.symbol, position: 0n };
          }
        }),
      );
      setRows(results);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [address]);

  useEffect(() => {
    if (isConnected && address) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address]);

  if (!isConnected) return null;

  const open = rows?.filter((r) => r.position > 0n) ?? [];
  const total = open.reduce((s, r) => s + r.position, 0n);

  const HEAD: React.CSSProperties = {
    fontSize: 12,
    fontFamily: "var(--font-mono-stack)",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
  };

  return (
    <section style={{ marginTop: 40 }}>
      {/* value summary */}
      <div
        style={{
          border: "1px solid var(--ink)",
          background: "var(--paper-2)",
          padding: "22px 24px",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={HEAD}>Total value</div>
          <div
            style={{
              fontSize: "clamp(2rem, 4vw, 2.8rem)",
              fontWeight: 500,
              letterSpacing: "-0.02em",
              lineHeight: 1,
              marginTop: 8,
              fontFamily: "var(--font-mono-stack)",
            }}
          >
            ${rows === null ? "—" : fmt(total)}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 6 }}>
            {open.length === 0
              ? "No open position"
              : `${open.length} basket${open.length > 1 ? "s" : ""} · confidential, on Miden`}
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            background: "transparent",
            border: "1px solid var(--rule)",
            padding: "6px 12px",
            cursor: loading ? "default" : "pointer",
            fontFamily: "var(--font-mono-stack)",
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          {loading ? "reading…" : "refresh"}
        </button>
      </div>

      {/* open positions */}
      {open.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...HEAD, marginBottom: 10 }}>Open positions</div>
          <div style={{ border: "1px solid var(--rule)", background: "var(--paper-2)" }}>
            {open.map((r) => (
              <div
                key={r.symbol}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 16,
                  alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: "1px dashed var(--rule)",
                }}
              >
                <span style={{ fontWeight: 600 }}>{r.symbol}</span>
                <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 14 }}>
                  {fmt(r.position)}{" "}
                  <span style={{ color: "var(--ink-3)" }}>≈ ${fmt(r.position)}</span>
                </span>
                <Link
                  href={`/baskets/${r.symbol.toLowerCase()}#selfcustody`}
                  style={{ fontSize: 12.5, color: "var(--ink)", textDecoration: "underline" }}
                >
                  withdraw →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* activity timeline */}
      <div style={{ marginTop: 28 }}>
        <div style={{ ...HEAD, marginBottom: 10 }}>Activity</div>
        {activity.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
            No activity yet — open a position from the{" "}
            <Link href="/baskets" style={{ borderBottom: "1px dotted var(--rule)" }}>
              baskets page
            </Link>
            .
          </p>
        ) : (
          <div style={{ border: "1px solid var(--rule)", background: "var(--paper-2)" }}>
            {activity.map((a, i) => (
              <div
                key={`${a.ts}-${i}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 14,
                  alignItems: "center",
                  padding: "11px 16px",
                  borderBottom:
                    i < activity.length - 1 ? "1px dashed var(--rule)" : "none",
                  fontSize: 13.5,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    color: a.type === "deposit" ? "var(--orange)" : "var(--ink-2)",
                    fontWeight: 600,
                  }}
                >
                  {a.type === "deposit" ? "↓" : "↑"}
                </span>
                <span>
                  {a.type === "deposit" ? "Deposited" : "Withdrew"}{" "}
                  <strong style={{ fontFamily: "var(--font-mono-stack)" }}>
                    {a.amount}
                  </strong>{" "}
                  {a.type === "deposit" ? "USDC → " : ""}
                  {a.basket}
                  {a.type === "withdraw" ? " → USDC" : ""}
                  <span style={{ color: "var(--ink-3)" }}> · {timeAgo(a.ts, now)}</span>
                </span>
                {a.tx ? (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${a.tx}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: 12,
                      color: "var(--ink-2)",
                      borderBottom: "1px dotted var(--rule)",
                    }}
                  >
                    tx ↗
                  </a>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
