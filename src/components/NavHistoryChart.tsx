"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Point {
  t: number;
  nav: number;
}

interface Resp {
  source: "coingecko-30d" | "synthetic";
  basket: string;
  points: Point[];
}

interface Props {
  basket: string;
}

export function NavHistoryChart({ basket }: Props) {
  const [resp, setResp] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    fetch(`/api/nav-history?basket=${encodeURIComponent(basket)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as Resp;
      })
      .then((j) => {
        if (!cancel) setResp(j);
      })
      .catch((e: unknown) => {
        if (!cancel) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
  }, [basket]);

  if (error) {
    return (
      <p style={{ fontSize: 12, color: "#a01a1a" }}>nav-history: {error}</p>
    );
  }
  if (!resp) {
    return (
      <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
        Loading NAV history…
      </p>
    );
  }

  const data = resp.points.map((p) => ({
    date: new Date(p.t * 1000).toISOString().slice(0, 10),
    nav: p.nav,
  }));

  return (
    <div style={{ width: "100%", height: 220 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--rule-2)" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "var(--ink-3)" }}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 10, fill: "var(--ink-3)" }}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--paper)",
              border: "1px solid var(--rule)",
              fontSize: 12,
            }}
            formatter={(v) =>
              typeof v === "number" ? v.toFixed(2) : String(v)
            }
          />
          <Line
            type="monotone"
            dataKey="nav"
            stroke="var(--orange)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
          marginTop: 6,
        }}
      >
        source: {resp.source} · {resp.points.length} points · 30d window
      </p>
    </div>
  );
}
