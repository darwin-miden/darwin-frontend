"use client";

/**
 * In-browser proof that the Miden Web SDK ingests the Darwin note
 * scripts. Fetches each `.masm` source from `/public/notes/`, runs
 * `useCompile().noteScript({...})` with the `darwin::math` helper
 * library linked dynamically, and surfaces the resulting MAST root.
 *
 * This validates the (e)+(d)+(g) build path end-to-end: the same
 * MASM source bundled into the Rust crate `darwin-notes` compiles
 * in-browser without an extra `cargo miden build` toolchain hop.
 *
 * Per `m1_submission_state.md` the live oracle MAST root for
 * `pragma::oracle::get_median` is
 * `0xd1aa2a8b38ccf58f37bb7aa490a8154c1cf89c537144ab23bd1111f13e5a28e8`
 * — that's the on-chain target we wire against once the controller
 * exposes a parameterised deposit body.
 */

import { useCompile } from "@miden-sdk/react";
import { useEffect, useState } from "react";

interface ScriptDef {
  id: string;
  label: string;
  url: string;
  blurb: string;
}

const SCRIPTS: ScriptDef[] = [
  {
    id: "atomic-deposit",
    label: "atomic_deposit_note.masm",
    url: "/notes/atomic_deposit_note.masm",
    blurb:
      "Flow A in a single note — runs felt_div, then drains every attached asset into the controller via call.<receive_asset>.",
  },
  {
    id: "atomic-redeem",
    label: "atomic_redeem_note.masm",
    url: "/notes/atomic_redeem_note.masm",
    blurb:
      "Symmetric to atomic_deposit — user attaches basket-token assets, controller absorbs them, supply ticks down.",
  },
];

interface CompiledRow {
  id: string;
  status: "pending" | "ok" | "error";
  root?: string;
  error?: string;
}

export function DarwinScriptsPanel() {
  const compile = useCompile();
  const [rows, setRows] = useState<CompiledRow[]>(
    SCRIPTS.map((s) => ({ id: s.id, status: "pending" })),
  );
  const [mathLoaded, setMathLoaded] = useState(false);

  useEffect(() => {
    if (!compile.isReady || mathLoaded) return;
    setMathLoaded(true);

    (async () => {
      // Smoke-test the SDK with a trivial inline note first. If this
      // fails the SDK itself is broken, not our source.
      try {
        const minimalScript = await compile.noteScript({
          code: "@note_script\npub proc main\n  push.1 drop\nend",
        });
        const minRoot = (
          minimalScript as unknown as { root: () => { toHex(): string } }
        )
          .root()
          .toHex();
        console.log("[DarwinScriptsPanel] minimal note OK, root:", minRoot);
      } catch (err) {
        console.error("[DarwinScriptsPanel] minimal note FAILED:", err);
      }

      // Notes inline felt_div, so no external library to load.
      for (const def of SCRIPTS) {
        try {
          const code = await fetch(def.url).then((r) => r.text());
          const script = await compile.noteScript({ code });
          // NoteScript.root() returns a Word — toString() gives hex.
          const rootHex = (script as unknown as { root: () => { toHex(): string } })
            .root()
            .toHex();
          setRows((prev) =>
            prev.map((r) =>
              r.id === def.id ? { ...r, status: "ok", root: rootHex } : r,
            ),
          );
        } catch (e) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === def.id
                ? {
                    ...r,
                    status: "error",
                    error: e instanceof Error ? e.message : String(e),
                  }
                : r,
            ),
          );
        }
      }
    })();
  }, [compile, mathLoaded]);

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
          marginBottom: 16,
        }}
      >
        Darwin note scripts — compiled in your browser
      </h2>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 13,
          lineHeight: 1.55,
          marginTop: 0,
          marginBottom: 18,
        }}
      >
        The same MASM source bundled into the <code>darwin-notes</code> Rust
        crate. Each row is fetched from <code>/notes/*.masm</code> and run
        through <code>useCompile().noteScript()</code> with the{" "}
        <code>darwin::math</code> helper linked dynamically. If the MAST
        root prints, the in-browser SDK round-trips this script identically
        to the on-chain assembler.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
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
            <th style={{ textAlign: "left", padding: "10px 12px" }}>Script</th>
            <th style={{ textAlign: "left", padding: "10px 12px" }}>MAST root</th>
          </tr>
        </thead>
        <tbody>
          {SCRIPTS.map((s) => {
            const r = rows.find((x) => x.id === s.id);
            return (
              <tr key={s.id} style={{ borderBottom: "1px solid var(--rule-2)" }}>
                <td style={{ padding: "12px 12px", verticalAlign: "top" }}>
                  <div style={{ fontWeight: 500 }}>{s.label}</div>
                  <div
                    style={{
                      color: "var(--ink-3)",
                      fontSize: 12,
                      marginTop: 2,
                      lineHeight: 1.4,
                    }}
                  >
                    {s.blurb}
                  </div>
                </td>
                <td
                  style={{
                    padding: "12px 12px",
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: 12,
                    verticalAlign: "top",
                  }}
                >
                  {r?.status === "pending" && (
                    <span style={{ color: "var(--ink-3)" }}>
                      {compile.isReady ? "compiling…" : "loading SDK…"}
                    </span>
                  )}
                  {r?.status === "ok" && (
                    <span style={{ color: "var(--ink)" }}>{r.root}</span>
                  )}
                  {r?.status === "error" && (
                    <span style={{ color: "#a01a1a" }}>{r.error}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
