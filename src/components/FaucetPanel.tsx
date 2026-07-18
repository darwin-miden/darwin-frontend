"use client";

/**
 * Testnet faucet panel — two flows on one page.
 *
 * Flow A — happy path drip / claim per asset:
 *   1. POST /api/faucet/mint  — server-side miden-client CLI mint of a
 *      public P2ID from the operator faucet to the user wallet.
 *      Server responds with {txId, noteId}. ZERO wallet popup.
 *   2. UI captures the noteId, swaps the row's button to 'Claim <sym>'.
 *   3. Click Claim → wallet.requestConsume({faucetId, noteId,
 *      noteType, amount}) — ONE MidenFi popup, asset lands in vault.
 *
 * Flow B — inbox scan (recovery / external-source path):
 *   - Click 'Scan inbox' → wallet.requestConsumableNotes() — ONE
 *     popup, returns every consumable note the wallet knows about
 *     (Drips from earlier sessions, CLI mints, public notes from
 *     other dApps, anything).
 *   - Each result row has its own Claim button → wallet.requestConsume
 *     for that specific note → ONE popup per claim.
 *
 * IMPORTANT: requestConsumableNotes is NEVER called outside an
 * explicit user click on 'Scan inbox'. A previous version polled it
 * every 5s on mount, which the MidenFi extension surfaces as a
 * permission popup each time — flooded users with 12+ popups per
 * minute of idle.
 */

import type { InputNoteDetails } from "@miden-sdk/miden-wallet-adapter-base";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { useState } from "react";

import {
  ASSET_FAUCETS as ASSET_FAUCET_CATALOGUE,
  EPOCH_DUSDC_FAUCET_ID,
} from "../lib/midenConstants";

interface AssetSpec {
  symbol: string;
  faucetId: string;
  decimals: number;
  dripBase: bigint;     // amount per request, in base units
  dripHuman: string;    // pre-formatted "X.Y" for the button label
}

// Per-drip amounts sized to readable testnet denominations. All four
// constituents now sit at 6 or 8 decimals so every drip amount fits
// well inside `Number.MAX_SAFE_INTEGER` — there's no precision drift
// at the wallet API boundary, and a single felt-bound note can carry
// the full drip in one tx.
//
// 18-decimal versions of dETH / dDAI were retired in favour of 8 / 6
// dec testnet equivalents because real-DAI's 18 decimals against a
// u64 felt ceiling caps total supply at ~18 DAI across all users — a
// 1000-DAI drip is mathematically impossible there. The symbols stay
// the same so the UI reads as expected; decimals are a testnet-only
// convenience.
// Drip amounts hand-tuned per asset; faucet ids + decimals sourced
// from the central registry so a v0.15 migration is a one-file diff.
const DRIPS: Record<string, { dripBase: bigint; dripHuman: string }> = {
  dETH:  { dripBase: 100_000_000n,    dripHuman: "1"    }, // 1e8 = 1 dETH (~$2000)
  dWBTC: { dripBase: 10_000_000n,     dripHuman: "0.1"  }, // 1e7 = 0.1 dWBTC (~$6000)
  dUSDT: { dripBase: 1_000_000_000n,  dripHuman: "1000" }, // 1e9 = 1000 dUSDT
  dDAI:  { dripBase: 1_000_000_000n,  dripHuman: "1000" }, // 1e9 = 1000 dDAI
};
const ASSETS: AssetSpec[] = [
  // dUSDC first — the SAME Epoch token the Sepolia rail delivers, so both
  // rails share one collateral. It isn't minted (we don't own Epoch's faucet
  // key): the server dispenses it by transfer from a bridged reserve wallet.
  {
    symbol: "dUSDC",
    faucetId: EPOCH_DUSDC_FAUCET_ID,
    decimals: 6,
    dripBase: 5_000_000n, // 5 dUSDC
    dripHuman: "5",
  },
  ...Object.values(ASSET_FAUCET_CATALOGUE).map((a) => ({
    symbol: a.symbol,
    faucetId: a.id,
    decimals: a.decimals,
    ...DRIPS[a.symbol],
  })),
];

type DripStatus =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "minted"; txId: string; noteId: string; noteBytes?: string }
  | { kind: "claiming"; noteId: string }
  | { kind: "claimed"; noteId: string }
  | { kind: "err"; message: string };

type InboxStatus =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "scanned"; notes: InputNoteDetails[] }
  | { kind: "err"; message: string };

type ClaimStatus =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "claimed" }
  | { kind: "err"; message: string };

function formatBaseUnits(amountStr: string, decimals: number): string {
  try {
    const n = BigInt(amountStr);
    const base = 10n ** BigInt(decimals);
    const whole = n / base;
    const frac = n % base;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return amountStr;
  }
}

function lookupAsset(faucetId: string): AssetSpec | undefined {
  return ASSETS.find((a) => a.faucetId.toLowerCase() === faucetId.toLowerCase());
}

export function FaucetPanel() {
  const wallet = useMidenFiWallet();
  const { connected, address } = wallet;
  const [drips, setDrips] = useState<Record<string, DripStatus>>({});
  const [inbox, setInbox] = useState<InboxStatus>({ kind: "idle" });
  const [inboxClaims, setInboxClaims] = useState<Record<string, ClaimStatus>>({});

  if (!connected || !address) {
    return (
      <div
        style={{
          padding: "1.2rem 1.4rem",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
          maxWidth: 720,
        }}
      >
        <strong>Connect a Miden wallet</strong>
        <p style={{ color: "var(--ink-2)", fontSize: 14, marginTop: 8, marginBottom: 0 }}>
          Click <em>Connect Miden</em> in the top nav (MidenFi extension, Para,
          or Turnkey).
        </p>
      </div>
    );
  }

  // ---------- Flow A: per-asset Drip + Claim ----------

  async function drip(asset: AssetSpec) {
    setDrips((s) => ({ ...s, [asset.symbol]: { kind: "minting" } }));

    // dUSDC → PERMISSIONLESS dispenser: the user emits a drip request from their
    // OWN wallet; the network's NTX builder runs it against the on-chain
    // dispenser, which pays out 5 dUSDC. No server-side signing (unlike the mint
    // path below). The payout is a private note → claimed with its bytes.
    if (asset.faucetId === EPOCH_DUSDC_FAUCET_ID) {
      if (!address) return;
      try {
        const resp = await fetch("/api/drip-note", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requester: address }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.noteB64) {
          setDrips((s) => ({
            ...s,
            [asset.symbol]: { kind: "err", message: data.error ?? `HTTP ${resp.status}` },
          }));
          return;
        }
        const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
        const { Note, NoteArray, TransactionRequestBuilder } = await import(
          "@miden-sdk/miden-sdk"
        );
        const dripNote = Note.deserialize(b64ToBytes(data.noteB64));
        const txReq = new TransactionRequestBuilder()
          .withOwnOutputNotes(new NoteArray([dripNote]))
          .build();
        const midenTx = Transaction.createCustomTransaction(address, data.dispenser, txReq);
        await wallet.requestTransaction!(midenTx);
        setDrips((s) => ({
          ...s,
          [asset.symbol]: {
            kind: "minted",
            txId: data.noteId,
            noteId: data.payoutId,
            noteBytes: data.payoutNoteB64,
          },
        }));
      } catch (e) {
        setDrips((s) => ({
          ...s,
          [asset.symbol]: { kind: "err", message: String((e as Error).message ?? e) },
        }));
      }
      return;
    }

    try {
      const resp = await fetch("/api/faucet/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: address,
          faucetId: asset.faucetId,
          amount: asset.dripBase.toString(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.noteId) {
        setDrips((s) => ({
          ...s,
          [asset.symbol]: { kind: "err", message: data.error ?? `HTTP ${resp.status}` },
        }));
        return;
      }
      setDrips((s) => ({
        ...s,
        [asset.symbol]: { kind: "minted", txId: data.txId, noteId: data.noteId },
      }));
    } catch (e) {
      setDrips((s) => ({
        ...s,
        [asset.symbol]: { kind: "err", message: String((e as Error).message ?? e) },
      }));
    }
  }

  async function claimDrip(asset: AssetSpec, noteId: string, noteBytes?: string) {
    if (!wallet.requestConsume) {
      setDrips((s) => ({
        ...s,
        [asset.symbol]: { kind: "err", message: "wallet.requestConsume not available" },
      }));
      return;
    }
    setDrips((s) => ({ ...s, [asset.symbol]: { kind: "claiming", noteId } }));
    // Retry loop — the Miden Wallet extension's local store needs
    // sync ticks to discover a freshly-minted Public note. Without a
    // retry, clicking Claim right after Drip throws INVALID_PARAMS
    // 'Note with id … not found' because the extension's background
    // sync (when it runs at all) hasn't caught up yet. requestConsume
    // doesn't import the note itself, so we have to wait for it.
    //
    // Caps at ~60s wall-clock (12 × 5s) which covers cold-start sync
    // on testnet; if it's still missing the user can fall back to
    // 'Scan inbox' which forces a sync via popup.
    const MAX_ATTEMPTS = 12;
    const RETRY_DELAY_MS = 5_000;
    let lastErr: unknown = null;
    // Use Promise.catch instead of try/await + catch so the rejection
    // is settled at the promise layer. Next.js's dev error overlay
    // intercepts `throw`-inside-`await` even when the call site catches
    // — but a `.catch` handler closes the rejection before it reaches
    // the React event-handler stack the overlay scans. Production
    // builds wouldn't surface either form, but the overlay is loud in
    // dev so we route around it.
    const attemptConsume = (): Promise<{ ok: true } | { ok: false; err: unknown }> =>
      wallet.requestConsume!({
        faucetId: asset.faucetId,
        noteId,
        // dUSDC dispenser pays out a PRIVATE note → hand its bytes so MidenFi
        // imports it before consuming (public assets are discovered by sync).
        noteType: asset.faucetId === EPOCH_DUSDC_FAUCET_ID ? "private" : "public",
        amount: Number(asset.dripBase),
        ...(noteBytes ? { noteBytes } : {}),
      })
        .then(() => ({ ok: true as const }))
        .catch((err: unknown) => ({ ok: false as const, err }));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await attemptConsume();
      if (result.ok) {
        setDrips((s) => ({ ...s, [asset.symbol]: { kind: "claimed", noteId } }));
        return;
      }
      lastErr = result.err;
      const msg = String((result.err as Error).message ?? result.err);
      // Surface non-recoverable errors immediately (user rejection,
      // wallet locked, etc) — only the 'not found' race is worth
      // retrying.
      if (!/not found/i.test(msg)) break;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    const rawMsg = String((lastErr as Error).message ?? lastErr);
    const friendly = /not found/i.test(rawMsg)
      ? "wallet didn't sync this note in time — click 'Scan inbox' below to force a sync, then claim it from the result list"
      : rawMsg;
    setDrips((s) => ({
      ...s,
      [asset.symbol]: { kind: "err", message: friendly },
    }));
  }

  // ---------- Flow B: Scan inbox + Claim from results ----------

  async function scanInbox() {
    if (!wallet.requestConsumableNotes) {
      setInbox({ kind: "err", message: "wallet.requestConsumableNotes not available" });
      return;
    }
    setInbox({ kind: "scanning" });
    setInboxClaims({});
    try {
      const notes = await wallet.requestConsumableNotes();
      setInbox({ kind: "scanned", notes });
    } catch (e) {
      setInbox({ kind: "err", message: String((e as Error).message ?? e) });
    }
  }

  async function claimInbox(note: InputNoteDetails) {
    if (!wallet.requestConsume) return;
    const asset0 = note.assets[0];
    if (!asset0) {
      setInboxClaims((s) => ({
        ...s,
        [note.noteId]: { kind: "err", message: "note carries no asset" },
      }));
      return;
    }
    setInboxClaims((s) => ({ ...s, [note.noteId]: { kind: "claiming" } }));
    try {
      // Wallet may report noteType as a number, an enum, or the literal
      // strings "private" / "public" depending on SDK version. We
      // accept any shape and default to "public" when nothing matches
      // — safer than tagging a public note "private" (silently
      // mis-routes). v0.14 NoteType is 2-bit (1=Public, 2=Private);
      // v0.15 trims to 1-bit (0=Public, 1=Private). Hardcoding `=== 2`
      // would silently invert on v0.15, so match strings first.
      const raw: unknown = note.noteType;
      const rawStr =
        typeof raw === "string"
          ? raw.toLowerCase()
          : typeof raw === "number"
            ? String(raw)
            : "";
      const isPrivate =
        rawStr === "private" ||
        rawStr === "1" || // v0.15 numeric Private
        rawStr === "2";   // v0.14 numeric Private (legacy)
      await wallet.requestConsume({
        faucetId: asset0.faucetId,
        noteId: note.noteId,
        noteType: isPrivate ? "private" : "public",
        amount: Number(asset0.amount),
      });
      setInboxClaims((s) => ({ ...s, [note.noteId]: { kind: "claimed" } }));
    } catch (e) {
      setInboxClaims((s) => ({
        ...s,
        [note.noteId]: { kind: "err", message: String((e as Error).message ?? e) },
      }));
    }
  }

  // ---------- Render ----------

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          color: "var(--ink-3)",
          marginBottom: 16,
        }}
      >
        target: {address.slice(0, 16)}…{address.slice(-6)}
      </div>

      {/* Flow A — per-asset Drip / Claim */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {ASSETS.map((a) => {
          const s = drips[a.symbol] ?? { kind: "idle" };
          const isMinted = s.kind === "minted" || s.kind === "claiming";
          const isClaimed = s.kind === "claimed";
          const isWorking = s.kind === "minting" || s.kind === "claiming";
          return (
            <div
              key={a.symbol}
              style={{
                padding: "14px 16px",
                background: "var(--paper-2)",
                borderLeft: "3px solid var(--rule)",
                display: "grid",
                gridTemplateColumns: "80px 1fr auto",
                gap: 16,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.symbol}</div>
                <div
                  style={{
                    color: "var(--ink-3)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono-stack)",
                  }}
                >
                  {a.decimals} dec
                </div>
              </div>

              <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                {s.kind === "idle" && <em>drip: {a.dripHuman} {a.symbol}</em>}
                {s.kind === "minting" && <em>minting on server…</em>}
                {s.kind === "minted" && (
                  <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
                    ✓ minted tx <code>{s.txId.slice(0, 14)}…</code> — click Claim
                    to consume into your wallet
                  </span>
                )}
                {s.kind === "claiming" && (
                  <em>waiting for MidenFi popup confirmation…</em>
                )}
                {s.kind === "claimed" && (
                  <span style={{ fontFamily: "var(--font-mono-stack)", fontSize: 11 }}>
                    ✓ claimed — {a.dripHuman} {a.symbol} now in your vault
                  </span>
                )}
                {s.kind === "err" && (
                  <span
                    style={{
                      color: "#a01a1a",
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: 11,
                    }}
                  >
                    ✗ {s.message.slice(0, 200)}
                  </span>
                )}
              </div>

              {isMinted ? (
                <button
                  onClick={() =>
                    claimDrip(
                      a,
                      s.kind === "minted" ? s.noteId : (s as { noteId: string }).noteId,
                      s.kind === "minted" ? s.noteBytes : undefined,
                    )
                  }
                  disabled={isWorking}
                  style={{
                    padding: "8px 16px",
                    background: isWorking ? "var(--ink-3)" : "var(--orange)",
                    color: "var(--paper)",
                    border: 0,
                    cursor: isWorking ? "not-allowed" : "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.kind === "claiming" ? "claiming…" : `Claim ${a.symbol}`}
                </button>
              ) : (
                <button
                  onClick={() => drip(a)}
                  disabled={isWorking || isClaimed}
                  style={{
                    padding: "8px 16px",
                    background:
                      isWorking || isClaimed ? "var(--ink-3)" : "var(--ink)",
                    color: "var(--paper)",
                    border: 0,
                    cursor:
                      isWorking || isClaimed ? "not-allowed" : "pointer",
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {isClaimed ? "done ✓" : isWorking ? "…" : `Drip ${a.symbol}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Flow B — Scan inbox for notes from any source */}
      <div
        style={{
          marginTop: 28,
          padding: "16px 18px",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--rule)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            marginBottom: inbox.kind === "scanned" && inbox.notes.length > 0 ? 14 : 0,
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
              Inbox
            </div>
            <div
              style={{
                color: "var(--ink-3)",
                fontSize: 12,
                lineHeight: 1.5,
                maxWidth: 460,
              }}
            >
              Have pending notes minted from somewhere else (CLI, another dApp,
              an earlier session)? Click <em>Scan inbox</em> — one MidenFi
              popup, returns everything your wallet can consume.
            </div>
          </div>
          <button
            onClick={scanInbox}
            disabled={inbox.kind === "scanning"}
            style={{
              padding: "8px 16px",
              background:
                inbox.kind === "scanning" ? "var(--ink-3)" : "var(--ink)",
              color: "var(--paper)",
              border: 0,
              cursor: inbox.kind === "scanning" ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            {inbox.kind === "scanning" ? "scanning…" : "Scan inbox"}
          </button>
        </div>

        {inbox.kind === "err" && (
          <pre
            style={{
              marginTop: 10,
              padding: 8,
              background: "#fff0f0",
              fontSize: 11,
              color: "#a01a1a",
              overflowX: "auto",
            }}
          >
            {inbox.message}
          </pre>
        )}

        {inbox.kind === "scanned" && inbox.notes.length === 0 && (
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--ink-3)",
              fontFamily: "var(--font-mono-stack)",
            }}
          >
            No consumable notes for this wallet.
          </div>
        )}

        {inbox.kind === "scanned" && inbox.notes.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {inbox.notes.map((note) => {
              const asset = note.assets[0];
              const matched = asset && lookupAsset(asset.faucetId);
              const human = asset
                ? formatBaseUnits(asset.amount, matched?.decimals ?? 0)
                : "—";
              const label = matched?.symbol ?? asset?.faucetId.slice(0, 16) ?? "note";
              const cs = inboxClaims[note.noteId] ?? { kind: "idle" };
              const isWorking = cs.kind === "claiming";
              const isClaimed = cs.kind === "claimed";
              return (
                <div
                  key={note.noteId}
                  style={{
                    padding: "10px 12px",
                    background: "var(--paper)",
                    border: "1px solid var(--rule)",
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: 11,
                      color: "var(--ink-2)",
                    }}
                  >
                    <div style={{ fontWeight: 600, color: "var(--ink)" }}>
                      {human} {label}
                    </div>
                    <div style={{ color: "var(--ink-3)", marginTop: 2 }}>
                      note <code>{note.noteId.slice(0, 18)}…</code>
                    </div>
                    {cs.kind === "err" && (
                      <div style={{ color: "#a01a1a", marginTop: 4 }}>
                        ✗ {cs.message.slice(0, 200)}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => claimInbox(note)}
                    disabled={isWorking || isClaimed}
                    style={{
                      padding: "6px 14px",
                      background:
                        isWorking || isClaimed
                          ? "var(--ink-3)"
                          : "var(--orange)",
                      color: "var(--paper)",
                      border: 0,
                      cursor: isWorking || isClaimed ? "not-allowed" : "pointer",
                      fontSize: 12,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isClaimed
                      ? "claimed ✓"
                      : isWorking
                      ? "claiming…"
                      : "Claim"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p
        style={{
          marginTop: 20,
          fontSize: 11,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono-stack)",
          lineHeight: 1.6,
        }}
      >
        Drip = server-side mint (no wallet popup). Claim = single MidenFi
        confirmation popup that consumes the freshly-minted note into your
        wallet vault. Scan inbox = one extra popup to enumerate any
        externally-sourced notes; each one then claims with its own popup.
      </p>
    </div>
  );
}
