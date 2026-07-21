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
import { useAccount, usePublicClient } from "wagmi";
import { formatUnits } from "viem";
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

import {
  BASKET_TOKEN_FAUCETS,
  EPOCH_DUSDC_FAUCET_ID,
  type BasketSymbol,
} from "../lib/midenConstants";
import { EPOCH_USDC_SEPOLIA } from "../lib/epoch";
import {
  TRUSTLESS_CONTROLLER_HEX,
  evmToUserIdFelts,
} from "../lib/trustlessController";
import { readActivity, timeAgo, type Activity } from "../lib/activityLog";
import { NAV_BASKETS, basketDecimals } from "../lib/basketFaucets";

// Minimal ERC-20 balanceOf — reads the connected wallet's Sepolia USDC.
const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

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

// NAV-priced baskets (value = shares × on-chain NAV-per-share) come from the
// single basket-faucet source of truth so deposit/portfolio/withdraw never
// drift apart. See lib/basketFaucets.

type Slot = { symbol: BasketSymbol; position: bigint };

export function PortfolioView() {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const publicClient = usePublicClient();
  const miden = useMidenFiWallet();
  const { connected: midenConnected, address: midenAddress } = miden;

  // Identity that owns the positions we display. The confidential position
  // lives on whichever rail the deposit was made from.
  const identity = (
    ethConnected ? evmAddress : midenConnected ? midenAddress : null
  ) as string | null;

  const [activity, setActivity] = useState<Activity[]>([]);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  // NAV baskets (e.g. DCC) — live USD value of one share, read on-chain.
  const [navPerShare, setNavPerShare] = useState<Record<string, number>>({});
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
    // NAV-per-share for NAV baskets (on-chain vault value / supply) so a
    // position is priced as shares × NAV, tracking the vault — not 1:1.
    for (const sym of NAV_BASKETS) {
      fetch(`/api/nav-status?basket=${sym}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          const nav = Number(d.navPerShareUsd);
          // V==0 (par — vault holds no priced constituents yet, e.g. right
          // after a deposit before the orchestrate seeds) reports 0. Treat as
          // $1/share so the position shows at par instead of vanishing.
          setNavPerShare((prev) => ({
            ...prev,
            [sym]: Number.isFinite(nav) && nav > 0 ? nav : 1,
          }));
        })
        .catch(() => {});
    }
    try {
      // USDC — the loose stablecoin held outside any basket. On the ETH rail
      // that's Sepolia USDC; on the MidenFi rail it's the dUSDC in the wallet.
      if (ethConnected && evmAddress && publicClient) {
        try {
          const bal = (await publicClient.readContract({
            address: EPOCH_USDC_SEPOLIA.address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [evmAddress as `0x${string}`],
          })) as bigint;
          setUsdc(Number(formatUnits(bal, EPOCH_USDC_SEPOLIA.decimals)));
        } catch {
          setUsdc(null);
        }
      } else if (midenConnected && miden.requestAssets) {
        try {
          const assets = await miden.requestAssets();
          const canon = (s: string) => {
            if (/^0x[0-9a-fA-F]+$/.test(s)) return s.toLowerCase();
            try {
              return AccountId.fromBech32(s).toString().toLowerCase();
            } catch {
              return s.toLowerCase();
            }
          };
          const want = canon(EPOCH_DUSDC_FAUCET_ID);
          const hit = assets.find((a) => canon(a.faucetId) === want);
          setUsdc(hit ? Number(hit.amount) / 10 ** DUSDC_DECIMALS : 0);
        } catch {
          setUsdc(null);
        }
      } else {
        setUsdc(null);
      }

      // Live slot-10 positions read only makes sense on the ETH-derived rail.
      if (!ethConnected || !evmAddress) {
        setSlots(null);
        return;
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, ethConnected, evmAddress, midenConnected, publicClient]);

  useEffect(() => {
    if (identity) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // Net position per basket, derived from activity (works for both rails),
  // refined by the live slot-10 read where we have it.
  const positions = useMemo(() => {
    const navSet = new Set<string>(NAV_BASKETS);
    const usdNet = new Map<string, number>(); // non-NAV: value == USD amount (1:1)
    const sharesNet = new Map<string, number>(); // NAV: basket-token base units
    for (const a of activity) {
      const sign = a.type === "deposit" ? 1 : -1;
      if (navSet.has(a.basket) && a.shares) {
        const cur = sharesNet.get(a.basket) ?? 0;
        sharesNet.set(a.basket, cur + sign * (Number(a.shares) || 0));
      } else {
        const cur = usdNet.get(a.basket) ?? 0;
        usdNet.set(a.basket, cur + sign * (Number(a.amount) || 0));
      }
    }
    const out = new Map<string, number>();
    // Token amount held per NAV basket (human units), so the row can show the
    // share count alongside its USD value — never conflating "98.87 DCC" (what
    // you hold) with "$99.63" (what it's worth).
    const tokens = new Map<string, number>();
    for (const [sym, v] of usdNet) out.set(sym, v);
    // NAV baskets: value = shares × on-chain NAV-per-share (tracks the vault).
    for (const [sym, shares] of sharesNet) {
      const nav = navPerShare[sym];
      if (nav != null && shares > 0) {
        const human = shares / 10 ** basketDecimals(sym);
        tokens.set(sym, human);
        out.set(sym, human * nav);
      }
    }
    // slot-10 refinement only for the non-NAV (System B) baskets.
    if (slots) {
      for (const s of slots) {
        if (s.position > 0n && !navSet.has(s.symbol)) {
          out.set(s.symbol, fromDusdc(s.position));
        }
      }
    }
    return [...out.entries()]
      .map(([symbol, value]) => ({
        symbol,
        value: Math.max(0, value),
        // NAV baskets: the on-chain share count. Non-NAV (1:1) baskets: 1 token
        // ≈ $1, so the token amount equals the USD value — show it too so every
        // row carries "<amount> <SYM>" under the symbol.
        tokenAmount: tokens.get(symbol) ?? Math.max(0, value),
      }))
      .filter((p) => p.value > 1e-6)
      .sort((a, b) => b.value - a.value);
  }, [activity, slots, navPerShare]);

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
        <>
          {/* basket positions */}
          {positions.length === 0 ? (
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
                  gridTemplateColumns: "1fr auto",
                  gap: 16,
                  padding: "9px 16px",
                  borderBottom: "1px solid var(--rule)",
                  ...HEAD,
                }}
              >
                <span>Basket</span>
                <span>Value</span>
              </div>
              {positions.map((p) => (
                <div
                  key={p.symbol}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 16,
                    alignItems: "center",
                    padding: "13px 16px",
                    borderBottom: "1px dashed var(--rule)",
                  }}
                >
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontWeight: 600 }}>{p.symbol}</span>
                    {p.tokenAmount != null && (
                      <span
                        style={{
                          fontFamily: "var(--font-mono-stack)",
                          fontSize: 12,
                          color: "var(--ink-3)",
                        }}
                      >
                        {p.tokenAmount.toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })}{" "}
                        {p.symbol}
                      </span>
                    )}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 14 }}>
                    ${usd(p.value)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* USDC — loose stablecoin held outside baskets */}
          <div
            style={{
              marginTop: 20,
              border: "1px solid var(--rule)",
              background: "var(--paper-2)",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 16,
                padding: "9px 16px",
                borderBottom: "1px solid var(--rule)",
                ...HEAD,
              }}
            >
              <span>Stablecoin</span>
              <span>Balance</span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 16,
                alignItems: "center",
                padding: "13px 16px",
              }}
            >
              <span>
                <span style={{ fontWeight: 600 }}>
                  {ethConnected ? "USDC" : "dUSDC"}
                </span>
                <span style={{ color: "var(--ink-3)", fontSize: 12.5 }}>
                  {" "}
                  · {ethConnected ? "Sepolia" : "in your Miden wallet"}
                </span>
              </span>
              <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 14 }}>
                {usdc == null ? "—" : usd(usdc)}
              </span>
            </div>
          </div>
        </>
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
