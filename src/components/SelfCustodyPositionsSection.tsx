"use client";

/**
 * Self-custody positions — the trustless controller's slot-10 entries
 * for the connected EVM address, one row per basket plus the legacy
 * flat slot. Pure HTTP reads (/api/position with the trustless
 * controllerId): no Miden hooks, no WASM client contention — safe to
 * mount next to any other portfolio section.
 *
 * Withdraw links hand off to /trustless/redeem?basket=SYM, which debits
 * the same (user, basket) key it displays here.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AccountId } from "@miden-sdk/miden-sdk";

import {
  BASKET_TOKEN_FAUCETS,
  type BasketSymbol,
} from "../lib/midenConstants";
import {
  TRUSTLESS_CONTROLLER_HEX,
  evmToUserIdFelts,
} from "../lib/trustlessController";

const DUSDC_DECIMALS = 6;

function formatDusdc(v: bigint): string {
  const whole = v / 10n ** BigInt(DUSDC_DECIMALS);
  const frac = (v % 10n ** BigInt(DUSDC_DECIMALS))
    .toString()
    .padStart(DUSDC_DECIMALS, "0")
    .slice(0, 2);
  return `${whole.toString()}.${frac}`;
}

type Row = {
  key: string;
  label: string;
  symbol: BasketSymbol | null;
  position: bigint;
  /** Credited by the NTX builder on the network controller. */
  network?: boolean;
};

export function SelfCustodyPositionsSection() {
  const { address, isConnected } = useAccount();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!address || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const { suffix, prefix } = evmToUserIdFelts(address);
      const targets: Array<{
        key: string;
        label: string;
        symbol: BasketSymbol | null;
        basketSuffix: string;
        basketPrefix: string;
      }> = Object.values(BASKET_TOKEN_FAUCETS).map((b) => {
        const id = AccountId.fromHex(b.id);
        return {
          key: b.symbol,
          label: b.symbol,
          symbol: b.symbol,
          basketSuffix: id.suffix().asInt().toString(),
          basketPrefix: id.prefix().asInt().toString(),
        };
      });
      targets.push({
        key: "flat",
        label: "Unallocated (demo slot)",
        symbol: null,
        basketSuffix: "0",
        basketPrefix: "0",
      });

      const results = await Promise.all(
        targets.map(async (t) => {
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
          if (!r.ok) throw new Error(`${t.label}: HTTP ${r.status}`);
          const j = (await r.json()) as { position?: string };
          return {
            key: t.key,
            label: t.label,
            symbol: t.symbol,
            position: j.position ? BigInt(j.position) : 0n,
          } satisfies Row;
        }),
      );
      // Network-rail positions (credited by the NTX builder on the
      // network controller) — separate read path; a failure here never
      // hides the NoAuth rows.
      const networkResults: Array<Row | null> = await Promise.all(
        targets
          .filter((t) => t.symbol !== null)
          .map(async (t): Promise<Row | null> => {
            try {
              const r = await fetch("/api/network-position", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  suffix: suffix.toString(),
                  prefix: prefix.toString(),
                  basketSuffix: t.basketSuffix,
                  basketPrefix: t.basketPrefix,
                }),
              });
              if (!r.ok) return null;
              const j = (await r.json()) as { position?: string };
              return {
                key: `${t.key}-network`,
                label: `${t.label} · network rail`,
                symbol: t.symbol,
                position: j.position ? BigInt(j.position) : 0n,
                network: true,
              } satisfies Row;
            } catch {
              return null;
            }
          }),
      );
      setRows([
        ...results,
        ...networkResults.filter((r): r is Row => r !== null),
      ]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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

  const nonZero = rows?.filter((r) => r.position > 0n) ?? [];
  const zeroCount = (rows?.length ?? 0) - nonZero.length;

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
          marginBottom: 12,
        }}
      >
        Self-custody positions
      </h2>
      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 14 }}>
        Written by your own browser against the <code>NoAuth</code>{" "}
        controller — or, for network-rail rows, credited by the Miden
        network itself (NTX builder). No Darwin server holds these.
        Withdraw bridges back to Sepolia USDC via Epoch.
      </p>

      {error && (
        <p style={{ fontSize: 12.5, color: "crimson", marginBottom: 10 }}>
          read failed: {error}
        </p>
      )}

      {rows === null && !error ? (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          {loading ? "reading controller slot-10…" : "—"}
        </p>
      ) : (
        <div
          style={{
            fontSize: 13,
            fontFamily: "var(--font-mono-stack)",
            border: "1px solid var(--rule)",
            background: "var(--paper-2)",
          }}
        >
          {nonZero.length === 0 && (
            <div style={{ padding: "10px 14px", color: "var(--ink-3)" }}>
              No self-custody position yet — use the Self-custody tab on a
              basket page to open one.
            </div>
          )}
          {nonZero.map((r) => (
            <div
              key={r.key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto",
                gap: 14,
                alignItems: "center",
                padding: "10px 14px",
                borderBottom: "1px dashed var(--rule)",
              }}
            >
              <span>{r.label}</span>
              <span>{formatDusdc(r.position)} dUSDC</span>
              <Link
                href={
                  r.symbol
                    ? `/trustless?basket=${r.symbol}${r.network ? "" : "&network=0"}`
                    : "/trustless?network=0"
                }
                style={{ textDecoration: "underline", color: "var(--ink-2)", fontSize: 12 }}
              >
                deposit
              </Link>
              <Link
                href={
                  r.symbol
                    ? `/trustless/redeem?basket=${r.symbol}${r.network ? "" : "&network=0"}`
                    : "/trustless/redeem?network=0"
                }
                style={{ textDecoration: "underline", color: "var(--ink)", fontSize: 12 }}
              >
                withdraw →
              </Link>
            </div>
          ))}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "8px 14px",
              color: "var(--ink-3)",
              fontSize: 12,
            }}
          >
            <span>
              {zeroCount > 0 ? `${zeroCount} empty slot(s) hidden` : ""}
            </span>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                border: 0,
                cursor: "pointer",
                textDecoration: "underline",
                color: "var(--ink-2)",
                fontSize: 12,
              }}
            >
              {loading ? "reading…" : "refresh"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
