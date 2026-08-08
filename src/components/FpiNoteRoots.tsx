"use client";

/**
 * FPI faucet redeploy helper. Compiles the two FPI NAV notes with the SAME
 * @miden-sdk path the app emits them through (compileNavDepositScriptFpi /
 * compileNavRedeemScriptFpi) and shows their MAST roots. These are the roots to
 * pass to `deploy_v13_fpi_faucet --allow-root …` — computed by the web SDK, so
 * they match the network (a Rust computation does NOT, because of lib versions).
 *
 * Admin-only (rendered on /admin/drift).
 */

import { useCompile } from "@miden-sdk/react";
import { useEffect, useState } from "react";
import {
  compileNavDepositScriptFpi,
  compileNavRedeemScriptFpi,
} from "../lib/clientNote";

type WithRoot = { root: () => { toHex(): string } };

export function FpiNoteRoots() {
  const compile = useCompile();
  const [deposit, setDeposit] = useState<string>("");
  const [redeem, setRedeem] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!compile.isReady || started) return;
    setStarted(true);
    (async () => {
      try {
        const dep = (await compileNavDepositScriptFpi(
          compile.noteScript,
        )) as unknown as WithRoot;
        const red = (await compileNavRedeemScriptFpi(
          compile.noteScript,
        )) as unknown as WithRoot;
        setDeposit(dep.root().toHex());
        setRedeem(red.root().toHex());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [compile, started]);

  const cmd =
    deposit && redeem
      ? `cargo run -p darwin-protocol-account --features pragma-live --bin deploy_v13_fpi_faucet -- --symbol DCC --allow-root ${deposit} --allow-root ${redeem} --deploy`
      : "";

  return (
    <section style={{ marginTop: 48, fontFamily: "var(--font-mono-stack)" }}>
      <h2
        style={{
          fontSize: 14,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        FPI faucet redeploy — allowlist roots
      </h2>
      {error ? (
        <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          compile error: {error}
        </pre>
      ) : (
        <>
          <table style={{ fontSize: 13, borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={{ padding: "4px 16px 4px 0", opacity: 0.7 }}>
                  nav_deposit_fpi
                </td>
                <td>
                  <code>{deposit || "compiling…"}</code>
                </td>
              </tr>
              <tr>
                <td style={{ padding: "4px 16px 4px 0", opacity: 0.7 }}>
                  nav_redeem_fpi
                </td>
                <td>
                  <code>{redeem || "compiling…"}</code>
                </td>
              </tr>
            </tbody>
          </table>
          {cmd && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
                Ready-to-run deploy command:
              </div>
              <textarea
                readOnly
                value={cmd}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  width: "100%",
                  minHeight: 88,
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 12,
                  padding: 8,
                }}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
