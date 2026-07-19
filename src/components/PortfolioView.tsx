"use client";

/**
 * Portfolio — a single view that works for whichever wallet is connected
 * (ETH-derived self-custody rail, or a native MidenFi wallet).
 *
 * Everything is driven by the local activity log (deposits/withdraws), so it
 * works for both rails and survives a position that has netted back to zero:
 *   - value chart (cumulative value over time),
 *   - open positions (net per basket; for the ETH rail the live slot-10 read
 *     refines it),
 *   - an activity timeline.
 *
 * Layout is Polymarket-style: a value header + chart, then Positions / Activity
 * tabs — in the site's paper/ink theme.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { AccountId } from "@miden-sdk/miden-sdk";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { BASKET_TOKEN_FAUCETS, type BasketSymbol } from "../lib/midenConstants";
import {
  TRUSTLESS_CONTROLLER_HEX,
  evmToUserIdFelts,
} from "../lib/trustlessController";
import { readActivity, timeAgo, type Activity } from "../lib/activityLog";

const DUSDC_DECIMALS = 6;
const RANGES = [
  { key: "1D", ms: 864e5 },
  { key: "1W", ms: 7 * 864e5 },
  { key: "1M", ms: 30 * 864e5 },
  { key: "ALL", ms: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

function usd(v: number): string {
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function fromDusdc(v: bigint): number {
  return Number(v) / 10 ** DUSDC_DECIMALS;
}

type Slot = { symbol: BasketSymbol; position: bigint };

export function PortfolioView() {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const { connected: midenConnected, address: midenAddress } =
    useMidenFiWallet();

  // Identity that owns the positions we display. The confidential position
  // lives on whichever rail the deposit was made from.
  const identity = (
    ethConnected ? evmAddress : midenConnected ? midenAddress : null
  ) as string | null;

  const [activity, setActivity] = useState<Activity[]>([]);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [now, setNow] = useState<number>(0);
  const [range, setRange] = useState<RangeKey>("ALL");
  const [tab, setTab] = useState<"positions" | "activity">("positions");
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!identity || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setNow(Date.now());
    setActivity(readActivity(identity));
    // Live slot-10 read only makes sense for the ETH-derived rail.
    if (!ethConnected || !evmAddress) {
      setSlots(null);
      setLoading(false);
      inFlight.current = false;
      return;
    }
    try {
      const { suffix, prefix } = evmToUserIdFelts(evmAddress);
      const targets = Object.values(BASKET_TOKEN_FAUCETS).map((b) => {
        const id = AccountId.fromHex(b.id);
        return {
          symbol: b.symbol,
          basketSuffix: id.suffix().asInt().toString(),
          basketPrefix: id.prefix().asInt().toString(),
        };
      });
      const rows = await Promise.all(
        targets.map(async (t): Promise<Slot> => {
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
            return {
              symbol: t.symbol,
              position: j.position ? BigInt(j.position) : 0n,
            };
          } catch {
            return { symbol: t.symbol, position: 0n };
          }
        }),
      );
      setSlots(rows);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [identity, ethConnected, evmAddress]);

  useEffect(() => {
    if (identity) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // Net position per basket, derived from activity (works for both rails),
  // refined by the live slot-10 read where we have it.
  const positions = useMemo(() => {
    const net = new Map<string, number>();
    for (const a of activity) {
      const cur = net.get(a.basket) ?? 0;
      const amt = Number(a.amount) || 0;
      net.set(a.basket, cur + (a.type === "deposit" ? amt : -amt));
    }
    if (slots) {
      for (const s of slots) {
        if (s.position > 0n) net.set(s.symbol, fromDusdc(s.position));
      }
    }
    return [...net.entries()]
      .map(([symbol, value]) => ({ symbol, value: Math.max(0, value) }))
      .filter((p) => p.value > 1e-6)
      .sort((a, b) => b.value - a.value);
  }, [activity, slots]);

  const totalValue = positions.reduce((s, p) => s + p.value, 0);

  // Value-over-time series from the activity log (cumulative), oldest→newest.
  const chart = useMemo(() => {
    const evts = [...activity].sort((a, b) => a.ts - b.ts);
    let running = 0;
    const pts = evts.map((a) => {
      running += (a.type === "deposit" ? 1 : -1) * (Number(a.amount) || 0);
      return { t: a.ts, v: Math.max(0, running) };
    });
    // Anchor the line to "now" at the current total.
    if (now) pts.push({ t: now, v: totalValue });
    const cutoff =
      range === "ALL"
        ? 0
        : now - (RANGES.find((r) => r.key === range)?.ms ?? Infinity);
    const filtered = pts.filter((p) => p.t >= cutoff);
    // Always give the chart at least two points so it renders a line.
    return filtered.length >= 2
      ? filtered
      : [{ t: (now || Date.now()) - 864e5, v: 0 }, { t: now || Date.now(), v: totalValue }];
  }, [activity, now, totalValue, range]);

  if (!identity) return null;

  const HEAD: React.CSSProperties = {
    fontSize: 11,
    fontFamily: "var(--font-mono-stack)",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--ink-3)",
  };

  return (
    <section style={{ marginTop: 32 }}>
      {/* value + chart header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 1fr) 2fr",
          gap: 0,
          border: "1px solid var(--ink)",
          background: "var(--paper-2)",
        }}
      >
        <div
          style={{
            padding: "24px 26px",
            borderRight: "1px solid var(--rule)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={HEAD}>Positions value</div>
            <div
              style={{
                fontSize: "clamp(2.2rem, 4.5vw, 3rem)",
                fontWeight: 500,
                letterSpacing: "-0.025em",
                lineHeight: 1,
                marginTop: 10,
                fontFamily: "var(--font-mono-stack)",
              }}
            >
              ${usd(totalValue)}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 8 }}>
              {ethConnected ? "ETH-derived self-custody" : "MidenFi wallet"} ·
              confidential on Miden
            </div>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            style={{
              alignSelf: "flex-start",
              marginTop: 16,
              background: "transparent",
              border: "1px solid var(--rule)",
              padding: "5px 12px",
              cursor: loading ? "default" : "pointer",
              fontFamily: "var(--font-mono-stack)",
              fontSize: 11.5,
              color: "var(--ink-2)",
            }}
          >
            {loading ? "reading…" : "refresh"}
          </button>
        </div>
        <div style={{ padding: "16px 20px 12px", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              gap: 6,
              justifyContent: "flex-end",
              marginBottom: 4,
            }}
          >
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                style={{
                  background: range === r.key ? "var(--ink)" : "transparent",
                  color: range === r.key ? "var(--paper)" : "var(--ink-3)",
                  border: "1px solid var(--rule)",
                  padding: "2px 9px",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 11,
                }}
              >
                {r.key}
              </button>
            ))}
          </div>
          <div style={{ width: "100%", height: 180 }}>
            <ResponsiveContainer>
              <AreaChart data={chart} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pv" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--orange)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--orange)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" hide />
                <YAxis hide domain={[0, "auto"]} />
                <Tooltip
                  contentStyle={{
                    background: "var(--paper)",
                    border: "1px solid var(--rule)",
                    fontSize: 12,
                  }}
                  labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                  formatter={(v) => [`$${usd(Number(v))}`, "value"]}
                />
                <Area
                  type="stepAfter"
                  dataKey="v"
                  stroke="var(--orange)"
                  strokeWidth={2}
                  fill="url(#pv)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* tabs */}
      <div style={{ display: "flex", gap: 22, margin: "26px 0 14px" }}>
        {(["positions", "activity"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: "transparent",
              border: 0,
              borderBottom:
                tab === t ? "2px solid var(--ink)" : "2px solid transparent",
              padding: "0 0 6px",
              cursor: "pointer",
              fontSize: 15,
              fontWeight: 600,
              color: tab === t ? "var(--ink)" : "var(--ink-3)",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "positions" ? (
        positions.length === 0 ? (
          <p style={{ fontSize: 13.5, color: "var(--ink-3)" }}>
            No open position — deposit from a{" "}
            <Link href="/baskets" style={{ borderBottom: "1px dotted var(--rule)" }}>
              basket page
            </Link>{" "}
            to open one.
          </p>
        ) : (
          <div style={{ border: "1px solid var(--rule)", background: "var(--paper-2)" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto",
                gap: 16,
                padding: "9px 16px",
                borderBottom: "1px solid var(--rule)",
                ...HEAD,
              }}
            >
              <span>Basket</span>
              <span>Value</span>
              <span />
            </div>
            {positions.map((p) => (
              <div
                key={p.symbol}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 16,
                  alignItems: "center",
                  padding: "13px 16px",
                  borderBottom: "1px dashed var(--rule)",
                }}
              >
                <span style={{ fontWeight: 600 }}>{p.symbol}</span>
                <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 14 }}>
                  ${usd(p.value)}
                </span>
                <Link
                  href={`/baskets/${p.symbol.toLowerCase()}#selfcustody`}
                  style={{ fontSize: 12.5, color: "var(--ink)", textDecoration: "underline" }}
                >
                  withdraw →
                </Link>
              </div>
            ))}
          </div>
        )
      ) : activity.length === 0 ? (
        <p style={{ fontSize: 13.5, color: "var(--ink-3)" }}>
          No activity yet — your deposits and withdraws will show up here.
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
                padding: "12px 16px",
                borderBottom:
                  i < activity.length - 1 ? "1px dashed var(--rule)" : "none",
                fontSize: 13.5,
              }}
            >
              <span
                aria-hidden
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  fontWeight: 700,
                  color: a.type === "deposit" ? "var(--orange)" : "var(--ink-2)",
                }}
              >
                {a.type === "deposit" ? "↓" : "↑"}
              </span>
              <span>
                {a.type === "deposit" ? "Deposited" : "Withdrew"}{" "}
                <strong style={{ fontFamily: "var(--font-mono-stack)" }}>
                  {a.amount}
                </strong>{" "}
                {a.type === "deposit" ? `USDC → ${a.basket}` : `${a.basket} → USDC`}
                <span style={{ color: "var(--ink-3)" }}>
                  {" "}
                  · {timeAgo(a.ts, now)}
                </span>
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
    </section>
  );
}
