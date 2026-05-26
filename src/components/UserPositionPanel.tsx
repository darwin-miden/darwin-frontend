"use client";

/**
 * Reads the connected EVM wallet's on-Miden position from the v6
 * controller's slot 10 (user_positions StorageMap). Bypasses the
 * relay's off-chain SQL accounting — the on-chain controller state
 * is the source of truth.
 *
 * Driven by useExecuteProgram against the controller, calling
 * `get_user_position` via its MAST root and reading the top of the
 * resulting stack as the position amount.
 *
 * Hidden unless an ETH wallet is connected.
 */

import { useAccount as useWagmiAccount } from "wagmi";
import { useCompile, useExecuteProgram } from "@miden-sdk/react";
import { useCallback, useEffect, useState } from "react";

import { CONTROLLER_ID, buildUserPositionScript } from "../lib/midenController";

export function UserPositionPanel() {
  const { address, isConnected } = useWagmiAccount();
  const compile = useCompile();
  const exec = useExecuteProgram();
  const [position, setPosition] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address || !compile.isReady) return;
    setError(null);
    try {
      const script = await compile.txScript({
        code: buildUserPositionScript(address),
      });
      const result = await exec.execute({
        accountId: CONTROLLER_ID,
        script,
      });
      // Stack top after get_user_position = first felt of the
      // position_word. We pushed [0, 0, suffix, prefix], called
      // get_user_position which returned the value word. truncate_stack
      // left 16 elements; the first slot is the lower felt.
      const top = result.stack?.[0];
      if (typeof top === "bigint") {
        setPosition(top);
      } else if (typeof top === "number") {
        setPosition(BigInt(top));
      } else if (typeof top === "string") {
        setPosition(BigInt(top));
      } else {
        setPosition(0n);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [address, compile, exec]);

  useEffect(() => {
    if (!isConnected || !address) {
      setPosition(null);
      return;
    }
    void refresh();
  }, [isConnected, address, refresh]);

  if (!isConnected) return null;

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
          marginBottom: 14,
        }}
      >
        On-chain position (controller slot 10)
      </h2>

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        Authoritative per-user position read from the controller's
        on-chain StorageMap (slot 10). Bypasses the relay's off-chain
        SQL — the controller is the source of truth.
      </p>

      <div
        style={{
          padding: "12px 14px",
          background: "var(--paper-2)",
          fontFamily: "var(--font-mono-stack)",
          fontSize: 13,
        }}
      >
        <div style={{ marginBottom: 6 }}>
          controller: <code>{CONTROLLER_ID}</code>
        </div>
        <div style={{ marginBottom: 6 }}>
          user:       <code>{address}</code>
        </div>
        <div>
          position:{" "}
          {position === null ? (
            <span style={{ color: "var(--ink-3)" }}>—</span>
          ) : (
            <strong>{position.toString()}</strong>
          )}{" "}
          <button
            onClick={() => void refresh()}
            disabled={!compile.isReady || exec.isLoading}
            style={{
              marginLeft: 12,
              padding: "4px 10px",
              fontSize: 11,
              background: "var(--ink)",
              color: "var(--paper)",
              border: 0,
              cursor: "pointer",
            }}
          >
            {exec.isLoading ? "…" : "refresh"}
          </button>
        </div>
      </div>

      {error && (
        <pre
          style={{
            marginTop: 10,
            padding: 8,
            background: "#fff0f0",
            fontSize: 11,
            color: "#a01a1a",
          }}
        >
          {error}
        </pre>
      )}
    </section>
  );
}
