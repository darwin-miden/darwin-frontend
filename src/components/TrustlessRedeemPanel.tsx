"use client";

/**
 * Trustless redeem — no server, no MidenFi extension.
 *
 * Reverse of TrustlessDepositPanel. Path:
 *   1. Same MetaMask-derived Miden wallet (deterministic from signature)
 *      — must already hold dUSDC from a prior deposit.
 *   2. Call Epoch to reverse-quote Miden→Sepolia (dUSDC in → USDC out).
 *   3. Epoch SDK invokes our `createMidenP2IDNote` callback: we spend
 *      dUSDC from the derived wallet into a P2IDE note targeting Epoch's
 *      allocator on Miden.
 *   4. Epoch solver consumes the note on Miden and delivers USDC to the
 *      user's Sepolia address (no user tx on Sepolia — the P2IDE note IS
 *      the proof of intent).
 *
 * The whole "no server trust" story from the deposit flow holds: this
 * panel talks straight to Epoch's public allocator + the Miden network,
 * with no Darwin backend involvement.
 */

import {
  useCompile,
  useConsume,
  useCreateWallet,
  useMiden,
  useSend,
  useSyncControl,
  useSyncState,
  useTransaction,
  useWaitForCommit,
  useWaitForNotes,
} from "@miden-sdk/react";
import { AccountFile, TransactionRequestBuilder } from "@miden-sdk/miden-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  keccak256,
  parseTransaction,
  parseUnits,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveMidenWallet } from "../lib/deriveWallet";
import { sepolia } from "viem/chains";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain } from "wagmi";
import { EpochIntentSDK } from "@epoch-protocol/epoch-intents-sdk";

import {
  ALLOCATOR_URL,
  EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
  MIDEN_DESTINATION_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  applySlippageBps,
  dusdcMidenBaseUnits,
  fetchQuote,
  fetchRedeemQuote,
  submitIntent,
  submitRedeemIntent,
  usdcSepoliaBaseUnits,
} from "../lib/epoch";
import {
  TRUSTLESS_CONTROLLER_HEX,
  basketFelts,
  buildSetPositionScript,
  evmToUserIdFelts,
  fetchTrustlessPosition,
} from "../lib/trustlessController";
import { liveDccBalance, readDccBalance, stashDccBalance } from "../lib/dccBalance";
import { basketDecimals, isNavBasket } from "../lib/basketFaucets";
import { autoBackupWallet, restoreFromBackup } from "../lib/walletBackup";
import { decryptBytes, encryptBytes } from "../lib/storeBackup";
import {
  gunzip,
  gzip,
  readOnchainBackup,
  warmOnchainBackup,
  writeOnchainBackupViaMac,
} from "../lib/onchainBackup";
import { backupAuthTypedData } from "../lib/backupAuthMessage";
import { logActivity } from "../lib/activityLog";

const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// viem walletClient whose transport signs everything locally with the
// given private-key account. The Epoch SDK's sendTransactionSync path
// emits the non-standard eth_sendRawTransactionSync — public RPCs reject
// it, so translate to eth_sendRawTransaction + waitForTransactionReceipt
// and hand back a raw-RPC-shaped receipt (hex fields) for viem's
// formatter. Same wrapper validated in the Node E2E harness.
function localSepoliaSigningClient(
  account: ReturnType<typeof privateKeyToAccount>,
) {
  const pub = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA_RPC_URL),
  });
  return createWalletClient({
    account,
    chain: sepolia,
    transport: custom({
      async request({ method, params }) {
        if (
          method === "eth_sendTransaction" ||
          method === "wallet_sendTransaction"
        ) {
          // Some Epoch SDK versions submit UNSIGNED tx params and expect
          // the wallet to sign (a public RPC answers "unknown account").
          // Sign locally as a plain legacy tx — same rationale and gas
          // policy as the raw-sync branch below — and return the hash,
          // which is all eth_sendTransaction promises.
          const tx = (params as [
            {
              to?: `0x${string}`;
              data?: `0x${string}`;
              value?: `0x${string}`;
              gas?: `0x${string}`;
            },
          ])[0];
          const nonce = await pub.getTransactionCount({
            address: account.address,
            blockTag: "pending",
          });
          const gasPrice = ((await pub.getGasPrice()) * 25n) / 10n;
          let gas = tx.gas ? BigInt(tx.gas) : undefined;
          if (!gas) {
            try {
              gas =
                ((await pub.estimateGas({
                  account: account.address,
                  to: tx.to,
                  data: tx.data,
                  value: tx.value ? BigInt(tx.value) : 0n,
                })) *
                  13n) /
                10n;
            } catch {
              gas = 500_000n;
            }
          }
          const signed = await account.signTransaction({
            type: "legacy",
            chainId: sepolia.id,
            nonce,
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : 0n,
            gas,
            gasPrice,
          });
          return await pub.request({
            method: "eth_sendRawTransaction",
            params: [signed],
          });
        }
        if (method === "eth_sendRawTransactionSync") {
          // publicnode rejects the browser-built eip1559 raw with
          // "Invalid parameters" (the same viem prepare path works from
          // Node — cause unclear, likely a stricter pool node). Decode
          // the raw, re-sign as a plain legacy tx with fresh
          // nonce/gasPrice, and submit that instead. Legacy raw sends
          // are reliably accepted (verified live).
          const parsed = parseTransaction(
            (params as [/* signedTx */ `0x${string}`])[0],
          );
          const nonce = await pub.getTransactionCount({
            address: account.address,
            blockTag: "pending",
          });
          // 2.5x: a slow legacy tx here is fatal — the Compact nonce the SDK
          // grabbed at quote time expires if the receipt takes minutes, and
          // Epoch then rejects the allocation with "Nonce has already been
          // used". Overpaying a few gwei on testnet is the cheap fix.
          const gasPrice = ((await pub.getGasPrice()) * 25n) / 10n;
          let gas = parsed.gas;
          if (!gas) {
            try {
              gas =
                ((await pub.estimateGas({
                  account: account.address,
                  to: parsed.to ?? undefined,
                  data: parsed.data,
                  value: parsed.value ?? 0n,
                })) *
                  13n) /
                10n;
            } catch {
              gas = 500_000n;
            }
          }
          const signed = await account.signTransaction({
            type: "legacy",
            chainId: sepolia.id,
            nonce,
            to: parsed.to ?? undefined,
            data: parsed.data,
            value: parsed.value ?? 0n,
            gas,
            gasPrice,
          });
          const hash = (await pub.request({
            method: "eth_sendRawTransaction",
            params: [signed],
          })) as `0x${string}`;
          const r = await pub.waitForTransactionReceipt({
            hash,
            timeout: 150_000,
          });
          return {
            transactionHash: hash,
            transactionIndex: "0x" + r.transactionIndex.toString(16),
            blockHash: r.blockHash,
            blockNumber: "0x" + r.blockNumber.toString(16),
            from: r.from,
            to: r.to,
            cumulativeGasUsed: "0x" + r.cumulativeGasUsed.toString(16),
            gasUsed: "0x" + r.gasUsed.toString(16),
            effectiveGasPrice:
              r.effectiveGasPrice != null
                ? "0x" + r.effectiveGasPrice.toString(16)
                : "0x0",
            contractAddress: r.contractAddress ?? null,
            logs: [],
            logsBloom: "0x" + "00".repeat(256),
            status: r.status === "success" ? "0x1" : "0x0",
            type: "0x2",
          };
        }
        return pub.request({ method: method as never, params: params as never });
      },
    }),
  });
}

// @miden-sdk/react's default `AuthScheme` symbol is wrong at runtime
// (matches TrustlessDepositPanel's fix). Pass the raw wasm enum value.
const AUTH_SCHEME_FALCON_ENUM_VALUE = 2;

type Stage =
  | "idle"
  | "signing"
  | "deriving"
  | "ready"
  | "sync-vault"
  | "quoting"
  | "sending-note"
  | "awaiting-fill"
  | "debiting"
  | "done"
  | "error";

type StageState = "idle" | "running" | "done";

function StageRow({
  label,
  state,
  detail,
  link,
  testId,
}: {
  label: string;
  state: StageState;
  detail: string;
  link?: string | null;
  testId?: string;
}) {
  const badge = state === "done" ? "✓" : state === "running" ? "◐" : "·";
  const badgeColor =
    state === "done"
      ? "#0a7a3e"
      : state === "running"
        ? "#c47a00"
        : "var(--ink-3)";
  const detailColor = state === "idle" ? "var(--ink-3)" : "var(--ink)";
  const running = state === "running";
  return (
    <div
      data-testid={testId}
      data-stage-state={state}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 150px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "8px 10px",
        borderRadius: 4,
        background: running ? "#fff4dc" : "transparent",
        borderLeft: running
          ? "3px solid #c47a00"
          : "3px solid transparent",
        borderBottom: "1px dashed var(--rule)",
        transition: "background 120ms ease-out",
      }}
    >
      <span
        style={{
          color: badgeColor,
          fontWeight: 700,
          fontSize: 16,
          textAlign: "center",
          display: "inline-block",
          animation: running ? "trustlessSpin 1.2s linear infinite" : undefined,
        }}
      >
        {badge}
      </span>
      <span
        style={{
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.08em",
          color: running ? "#8b5500" : "var(--ink-2)",
          fontWeight: running ? 700 : 500,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: detailColor,
          wordBreak: "break-all",
          fontSize: 12,
          fontFamily: link ? "var(--font-mono-stack)" : undefined,
        }}
      >
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            style={{ color: detailColor, textDecoration: "underline" }}
          >
            {detail}
          </a>
        ) : (
          detail
        )}
      </span>
    </div>
  );
}

const REDEEM_AMOUNT_DEFAULT = "";


// The derive step is deterministic per EVM address and the signing keys
// persist in the WASM keystore (IndexedDB), so once ANY panel derived
// the wallet in this browser, others can reuse the id without asking
// for another MetaMask signature.
function storedWalletId(evm: string | undefined): string | null {
  if (!evm || typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(`darwin-derived-${evm.toLowerCase()}`);
  } catch {
    return null;
  }
}
function storeWalletId(evm: string | undefined, id: string) {
  if (!evm || typeof window === "undefined") return;
  try {
    sessionStorage.setItem(`darwin-derived-${evm.toLowerCase()}`, id);
  } catch {}
}

export function TrustlessRedeemPanel({
  basket,
  compact = false,
  network = false,
}: {
  /** Basket to debit — keys slot-10 per (user, basket). Omit = legacy flat slot. */
  basket?: { symbol: string; faucetHex: string };
  /** Embedded in the basket tab: the pane already provides mode/destination context — hide the panel's own heading + intro. */
  compact?: boolean;
  /**
   * Network rail: the redeem is a request note the NTX builder executes
   * against the network controller — it debits the position AND pays the
   * dUSDC from the controller vault via a private payback P2ID that only
   * this browser can claim. No Epoch leg: funds land in the derived
   * Miden wallet.
   */
  network?: boolean;
} = {}) {
  const { address: evmAddress, isConnected: ethConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const publicClient = usePublicClient();
  const { switchChainAsync } = useSwitchChain();
  const { createWallet, isCreating, error: createErr } = useCreateWallet();
  const { send: sendNote } = useSend();
  const { consume } = useConsume();
  const { pauseSync, resumeSync } = useSyncControl();
  const { sync: syncState } = useSyncState();
  const { waitForConsumableNotes } = useWaitForNotes();
  const { waitForCommit } = useWaitForCommit();
  const { runExclusive, client } = useMiden();
  const { txScript: compileTxScript } = useCompile();
  const { execute: executeTx } = useTransaction();
  // Backup & restore are INVISIBLE + automatic — no buttons, no prompts, nothing
  // for the user to see (src/lib/walletBackup.ts): auto-backup after every
  // deposit/withdraw and on load (autoBackupWallet), auto-restore on derivation
  // (restoreFromBackup wired into deriveMidenWallet's tryRestore). The Mac relay
  // does the on-chain write; the backup key rides the wallet-derivation signature.


  // Browser self-test (gated behind ?backuptest) — validates the backup data
  // path end-to-end WITHOUT MetaMask or funds: creates a throwaway private
  // wallet, exports its account file, runs gzip→encrypt→decrypt→gunzip→
  // deserialize→import, and reports on window.__darwinBackupSelfTest(). Harmless
  // (no seed derivation, no controller writes) so it survives the prod build.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("backuptest")) return;
    const w = window as unknown as {
      __darwinBackupSelfTest?: () => Promise<Record<string, unknown>>;
    };
    w.__darwinBackupSelfTest = async () => {
      const r: Record<string, unknown> = {};
      try {
        const cAny = client as unknown as {
          exportAccountFile?: (id: unknown) => Promise<{ serialize: () => Uint8Array }>;
          importAccountFile?: (file: unknown) => Promise<string>;
        };
        r.hasExport = typeof cAny.exportAccountFile === "function";
        r.hasImport = typeof cAny.importAccountFile === "function";
        if (!cAny.exportAccountFile || !cAny.importAccountFile)
          throw new Error("exportAccountFile/importAccountFile missing on client");
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const acct = (await createWallet({
          initSeed: seed,
          storageMode: "private",
          authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as never,
        })) as unknown as { id: () => { toString: () => string } };
        const id = acct.id().toString();
        r.walletId = id;
        const { AccountId } = await import("@miden-sdk/miden-sdk");
        const file = await cAny.exportAccountFile(AccountId.fromHex(id));
        const fileBytes = file.serialize();
        r.fileBytes = fileBytes.length;
        const key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        const enc = await encryptBytes(key, await gzip(fileBytes));
        r.encBytes = enc.length;
        const back = await gunzip(await decryptBytes(key, enc));
        r.roundtripEqual =
          back.length === fileBytes.length && back.every((b, i) => b === fileBytes[i]);
        const af = AccountFile.deserialize(back);
        try {
          await cAny.importAccountFile(af);
          r.imported = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          r.importErr = msg;
          r.imported = /already being tracked|already exist/i.test(msg);
        }
        r.ok =
          r.hasExport === true &&
          r.hasImport === true &&
          r.roundtripEqual === true &&
          r.imported === true;
      } catch (e) {
        r.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        r.ok = false;
      }
      return r;
    };
    // Full ON-CHAIN round-trip (slow: real controller writes + WASM proving):
    // export → gzip → encrypt → writeOnchainBackup (real txs) → readOnchainBackup
    // (via /api/backup-read) → decrypt → gunzip → deserialize → import. Uses a
    // fixed TEST namespace so it never collides with a real user's backup.
    const wf = window as unknown as {
      __darwinBackupFullTest?: (nChunks?: number) => Promise<Record<string, unknown>>;
    };
    wf.__darwinBackupFullTest = async (nChunks?: number) => {
      const r: Record<string, unknown> = {};
      const log = (m: string) => {
        try {
          console.log("[selftest] " + m);
        } catch {
          /* noop */
        }
      };
      try {
        const { AccountId } = await import("@miden-sdk/miden-sdk");
        const cAny = client as unknown as {
          exportAccountFile: (id: unknown) => Promise<{ serialize: () => Uint8Array }>;
          importAccountFile: (file: unknown) => Promise<string>;
        };
        // Fixed test IDENTITY (a well-known throwaway test key, never a real
        // user) — so the self-test also exercises the write route's real
        // ownership auth: sign the proof with the test key, write to its slot.
        const { privateKeyToAccount } = await import("viem/accounts");
        const testAccount = privateKeyToAccount(
          "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        );
        const testEvmAddress = testAccount.address;
        const { suffix, prefix } = evmToUserIdFelts(testEvmAddress);
        const testAuthSig = await testAccount.signTypedData(
          backupAuthTypedData(testEvmAddress) as never,
        );
        let enc: Uint8Array;
        let key: CryptoKey | null = null;
        let fileBytes: Uint8Array | null = null;
        if (nChunks && nChunks > 0) {
          // Light mode: dummy random payload of N chunks — validates the
          // multi-tx write-chaining + on-chain round-trip with minimal proving.
          enc = crypto.getRandomValues(new Uint8Array(nChunks * 28));
          r.mode = `dummy-${nChunks}ch`;
          log(`dummy payload ${enc.length}B (${nChunks} chunks)`);
        } else {
          // Full mode: real account file through the entire pipeline.
          const seed = crypto.getRandomValues(new Uint8Array(32));
          const acct = (await createWallet({
            initSeed: seed,
            storageMode: "private",
            authScheme: AUTH_SCHEME_FALCON_ENUM_VALUE as never,
          })) as unknown as { id: () => { toString: () => string } };
          const id = acct.id().toString();
          log(`wallet ${id}`);
          const file = await cAny.exportAccountFile(AccountId.fromHex(id));
          fileBytes = file.serialize();
          r.fileBytes = fileBytes.length;
          key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"],
          );
          enc = await encryptBytes(key, await gzip(fileBytes));
          r.mode = "full-file";
        }
        r.encBytes = enc.length;
        log("writing on-chain (Mac relay)…");
        const t0 = performance.now();
        const wres = await writeOnchainBackupViaMac({
          suffix,
          prefix,
          controllerId: TRUSTLESS_CONTROLLER_HEX,
          encryptedBytes: enc,
          evmAddress: testEvmAddress,
          authSig: testAuthSig,
        });
        r.writeRes = wres;
        if (!wres.ok) {
          r.error = wres.error;
          r.ok = false;
          return r;
        }
        r.writeMs = Math.round(performance.now() - t0);
        log(`written in ${r.writeMs}ms; reading back (poll for commit)…`);
        // Poll a few block-times for the committed state to reflect the writes.
        let readBack: Uint8Array | null = null;
        const t1 = performance.now();
        for (let a = 0; a < 8; a++) {
          await warmOnchainBackup(suffix, prefix, TRUSTLESS_CONTROLLER_HEX);
          const rb = await readOnchainBackup(suffix, prefix, TRUSTLESS_CONTROLLER_HEX);
          if (rb && rb.length === enc.length && rb.every((b, i) => b === enc[i])) {
            readBack = rb;
            break;
          }
          log(`read attempt ${a + 1}: ${rb ? rb.length : "null"}B (want ${enc.length})`);
          await new Promise((res) => setTimeout(res, 5000));
        }
        r.readMs = Math.round(performance.now() - t1);
        r.readBytes = readBack ? readBack.length : 0;
        r.onchainEqual = !!readBack;
        if (!readBack) {
          r.ok = false;
          return r;
        }
        if (nChunks && nChunks > 0) {
          r.ok = r.onchainEqual === true; // chaining + round-trip validated
          return r;
        }
        const back = await gunzip(await decryptBytes(key as CryptoKey, readBack));
        r.decryptEqual =
          !!fileBytes &&
          back.length === fileBytes.length &&
          back.every((b, i) => b === (fileBytes as Uint8Array)[i]);
        const af = AccountFile.deserialize(back);
        try {
          await cAny.importAccountFile(af);
          r.imported = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          r.importErr = msg;
          r.imported = /already being tracked|already exist/i.test(msg);
        }
        r.ok =
          r.onchainEqual === true &&
          r.decryptEqual === true &&
          r.imported === true;
      } catch (e) {
        r.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        r.ok = false;
      }
      return r;
    };
    return () => {
      const g = window as unknown as Record<string, unknown>;
      delete g.__darwinBackupSelfTest;
      delete g.__darwinBackupFullTest;
    };
  }, [client, createWallet]);

  const [stage, setStage] = useState<Stage>("idle");
  const [walletId, setWalletId] = useState<string | null>(null);
  // Track the connected EVM account. On an in-wallet account switch
  // (A→B, no disconnect) evmAddress changes: reset walletId to whatever
  // was derived for the NEW address (or null), so we never drive account
  // A's already-unlocked Miden hot wallet while reading account B's
  // position. Reuses a wallet already derived this session for B.
  useEffect(() => {
    if (!evmAddress) {
      setWalletId(null);
      return;
    }
    setWalletId(storedWalletId(evmAddress));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmAddress]);
  const [humanAmount, setHumanAmount] = useState<string>(REDEEM_AMOUNT_DEFAULT);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Displayed withdraw balance = the REAL confidential DCC balance, read from
  // the cache the deposit/withdraw flows write (getBalance only resolves in a
  // flow's warm client, so this is the only place it's reliably captured).
  // Refreshes on stage changes so a just-finished flow's fresh value shows.
  const [positionBase, setPositionBase] = useState<bigint | null>(null);

  useEffect(() => {
    if (!walletId) {
      setPositionBase(null);
      return;
    }
    const v = readDccBalance(walletId);
    if (v != null) setPositionBase(v);
  }, [walletId, stage]);

  // NAV baskets: the on-chain USD value of one share. Used to turn the typed
  // "USDC to receive" into the number of shares to burn (the redeem note prices
  // the payout at the live NAV). null until fetched / for non-NAV baskets.
  const [navPerShare, setNavPerShare] = useState<number | null>(null);
  useEffect(() => {
    if (!isNavBasket(basket?.symbol ?? "DCC")) return;
    let cancelled = false;
    fetch(`/api/nav-status?basket=${basket?.symbol ?? "DCC"}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const n = Number(d.navPerShareUsd);
        // V==0 (par — vault holds no priced constituents yet, e.g. right after
        // a fresh deposit before the orchestrate seeds) reports 0. Treat as
        // $1/share so withdraw stays enabled and uses the par conversion, which
        // matches the redeem note's own par fallback (release = s/100).
        setNavPerShare(Number.isFinite(n) && n > 0 ? n : 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [basket?.symbol]);

  // Live-refresh the confidential balance from the OWNED vault whenever the
  // wallet changes (getAccount → vault().getBalance — reliable for a private
  // account we own). Fixes "Balance: —" on a fresh load / after a restore, where
  // the flow-written cache is empty. Best-effort; falls back to the cache value.
  useEffect(() => {
    if (!walletId) return;
    let cancelled = false;
    void liveDccBalance(client, runExclusive, walletId, basket?.symbol ?? "DCC").then(
      (b) => {
        if (cancelled || b == null) return;
        setPositionBase(b);
        // A wallet that holds a balance must always have a current backup —
        // silently (re)back it up on load (debounced, no prompt, no UI).
        if (b > 0n && evmAddress)
          void autoBackupWallet({
            client,
            runExclusive,
            walletId,
            evmAddress: evmAddress as `0x${string}`,
          });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId]);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [midenTxId, setMidenTxId] = useState<string | null>(null);
  const [sepoliaTxHint, setSepoliaTxHint] = useState<string | null>(null);
  const [intentNonce, setIntentNonce] = useState<string | null>(null);
  const [vaultSyncMsg, setVaultSyncMsg] = useState<string | null>(null);
  const [debitTx, setDebitTx] = useState<string | null>(null);
  // Network mode chains two legs: "withdraw" (request note -> NTB debits
  // the position and pays the wallet) then "exit" (P2IDE -> Epoch fills
  // USDC on Sepolia). Drives the stage rows.
  const [netPhase, setNetPhase] = useState<"withdraw" | "exit">("withdraw");
  // Dev-only test buttons: hidden in normal use, shown with ?dev=1 or a
  // pre-injected window.__devKey (Playwright). DEV BUILDS ONLY — these
  // buttons include a raw "paste your private key" prompt, which must
  // never be reachable on a production origin (phishing / self-XSS lure),
  // so devMode is hard-gated on NODE_ENV, not just the URL param.
  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __devKey?: string };
    const qs = new URLSearchParams(window.location.search);
    setDevMode(Boolean(w.__devKey) || qs.has("dev"));
  }, []);
  const sdkRef = useRef<EpochIntentSDK | null>(null);

  // Derive a Miden wallet from a LOCAL viem account through the EXACT
  // production path (deriveMidenWallet: EIP-712 typed data + low-s
  // canonicalisation), so the autonomous E2E exercises the real
  // derivation rather than a divergent personal_sign fork. keyIndex
  // isolates each run's wallet without changing the crypto path.
  const deriveDevWallet = useCallback(
    async (
      account: ReturnType<typeof privateKeyToAccount>,
      keyIndex: bigint = 0n,
    ) =>
      deriveMidenWallet(createWallet, {
        evmAddress: account.address as `0x${string}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signTypedData: (td) => account.signTypedData(td as any),
        keyIndex,
      }),
    [createWallet],
  );

  // Autonomous E2E flow — used by both the "Autonomous test" button and
  // the window.__darwinTrustlessRedeem debug hook. Bypasses wagmi entirely
  // by signing with a local viem account, and drives the panel's stage
  // machine as it progresses (so Playwright / a human watching the panel
  // can follow along without polling internal state).
  const runAutonomousFlow = useCallback(
    async (devKeyHex: string, humanAmount: string) => {
      const trace: Record<string, unknown> = {
        humanAmount,
        startedAt: Date.now(),
      };
      const log = (step: string, extra?: unknown) => {
        const t = (
          (Date.now() - (trace.startedAt as number)) /
          1000
        ).toFixed(1);
        console.log(`[redeem-auto t+${t}s] ${step}`, extra ?? "");
      };
      // Reset any prior run's UI state.
      setErrorMsg(null);
      setNoteId(null);
      setMidenTxId(null);
      setSepoliaTxHint(null);
      setIntentNonce(null);
      setVaultSyncMsg(null);
      pauseSync();
      try {
        log("start");
        const account = privateKeyToAccount(devKeyHex as `0x${string}`);
        const evm = account.address as `0x${string}`;
        trace.evm = evm;

        // Exact production derivation (EIP-712 typed data + low-s
        // canonicalisation) via a local signer — same path onDerive uses.
        setStage("signing");
        log("signing derive typed data (production path)");
        setStage("deriving");
        log("createWallet");
        const derivedWalletId = await deriveDevWallet(account);
        setWalletId(derivedWalletId);
        storeWalletId(evmAddress, derivedWalletId);
        trace.walletId = derivedWalletId;
        log("walletId", derivedWalletId);

        // Sync + drain any consumable notes into the vault.
        setStage("sync-vault");
        for (let i = 0; i < 3; i++) {
          setVaultSyncMsg(`syncing derived wallet (${i + 1}/3)…`);
          log(`syncState ${i + 1}/3`);
          try {
            await runExclusive(() => syncState());
          } catch (e) {
            log(`syncState ${i + 1}/3 failed`, String(e).slice(0, 100));
          }
          await new Promise((r) => setTimeout(r, 1200));
        }
        setVaultSyncMsg("scanning for pending P2ID notes (~15s)…");
        log("waitForConsumableNotes");
        // waitForConsumableNotes' internal timeout isn't honoured in some
        // fresh-IndexedDB contexts (verified: hangs indefinitely in a
        // Playwright test even with timeoutMs=15_000). Wrap in a manual
        // Promise.race so the flow can't get stuck — if there's no
        // vault balance, we'll fall through and let send() throw the
        // real underflow error instead.
        // NB: NOT wrapped in runExclusive — waitForConsumableNotes is a
        // read + it internally holds the mutex on hangs, blocking every
        // downstream runExclusive (like the send() proving pass). We
        // hard-cap it with Promise.race so the flow can't stall.
        const HARD_TIMEOUT_MS = 18_000;
        let pending: unknown[] = [];
        try {
          const raced = await Promise.race<unknown[] | undefined>([
            waitForConsumableNotes({
              accountId: derivedWalletId!,
              minCount: 1,
              timeoutMs: 15_000,
              intervalMs: 3_000,
            }) as Promise<unknown[] | undefined>,
            new Promise<unknown[]>((resolve) =>
              setTimeout(() => resolve([]), HARD_TIMEOUT_MS),
            ),
          ]);
          pending = Array.isArray(raced) ? raced : [];
          if (
            !Array.isArray(pending) ||
            (pending as unknown[]).length === 0
          ) {
            log("no consumable notes after hard timeout");
          }
        } catch (e) {
          log("waitForConsumableNotes threw", String(e).slice(0, 100));
        }
        trace.pendingNotesFound = pending.length;
        if (pending.length > 0) {
          setVaultSyncMsg(`draining ${pending.length} note(s) into vault…`);
          log(`consume ${pending.length}`);
          try {
            const autoPendingIds = (pending as Array<{
              inputNoteRecord?: () =>
                | { id?: () => { toString?: () => string } }
                | null;
            }>)
              .map((n) => n.inputNoteRecord?.()?.id?.()?.toString?.() ?? "")
              .filter(Boolean);
            await consume({
              accountId: derivedWalletId!,
              notes: autoPendingIds,
            });
            trace.drained = pending.length;
          } catch (e) {
            trace.drainError = String(e).slice(0, 200);
            log("consume threw", trace.drainError);
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        setVaultSyncMsg(null);

        // Build the Epoch SDK — Miden virtual chain ID for the collateral
        // path.
        const sepoliaWC = createWalletClient({
          account,
          chain: sepolia,
          transport: http(),
        });
        const midenWC = {
          ...sepoliaWC,
          chain: { ...sepoliaWC.chain, id: MIDEN_DESTINATION_CHAIN_ID },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const sdk = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient: midenWC,
        });
        sdkRef.current = sdk;

        setStage("quoting");
        const minSepoliaOut = applySlippageBps(
          usdcSepoliaBaseUnits(humanAmount),
          EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
        );
        log("fetchRedeemQuote");
        const quote = await fetchRedeemQuote(sdk, {
          midenSourceId: derivedWalletId!,
          evmRecipient: evm,
          minUsdcSepoliaBaseUnits: minSepoliaOut,
        });
        trace.quoteOk = true;
        trace.tokenIn = String(quote.quoteResult.tokenIn ?? "");
        log("quote OK", trace.tokenIn);

        setStage("sending-note");
        log("submitRedeemIntent");
        let capturedMidenTxId: string | undefined;
        let capturedNoteId: string | undefined;
        const submit = await submitRedeemIntent(
          sdk,
          quote,
          async (faucetId, amount, allocatorId) => {
            log("createMidenP2IDNote callback fired");
            try {
              const out = await sendNote({
                  from: derivedWalletId!,
                  to: allocatorId,
                  assetId: faucetId,
                  amount: BigInt(amount),
                  noteType: "public",
                  // returnNote builds the P2ID note explicitly and returns
                  // the Note object — without it SendResult.note is null and
                  // the Epoch SDK rejects our callback for missing noteId.
                  returnNote: true,
                });
              capturedMidenTxId = out?.txId;
              // Reference app waits for the note tx to COMMIT before
              // handing the noteId to the SDK (its 12s wait alone can be
              // shorter than a Miden block); mirror that here.
              if (capturedMidenTxId) {
                try {
                  await waitForCommit(capturedMidenTxId, {
                    timeoutMs: 120_000,
                    intervalMs: 4_000,
                  });
                } catch (_) {}
              }
              capturedNoteId =
                (out?.note as unknown as {
                  id?: () => { toString?: () => string };
                })
                  ?.id?.()
                  ?.toString?.() ?? undefined;
              setNoteId(capturedNoteId ?? null);
              setMidenTxId(capturedMidenTxId ?? null);
              log("P2IDE note created", capturedNoteId);
              return { success: true, noteId: capturedNoteId };
            } catch (e) {
              trace.p2ideError = String(e).slice(0, 200);
              log("sendNote threw", trace.p2ideError);
              return { success: false };
            }
          },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = submit as any;
        const nonce = String(
          s?.nonce ?? s?.submittedIntentData?.compact?.nonce ?? "",
        );
        if (nonce) setIntentNonce(nonce);
        trace.midenTxId = capturedMidenTxId;
        trace.noteId = capturedNoteId;
        trace.intentNonce = nonce;

        setStage("awaiting-fill");
        log("polling intentStatus", nonce);
        const url = `${ALLOCATOR_URL}/intentStatus/${evm}/${nonce}`;
        let fillTx: string | undefined;
        for (let t = 0; t < 24; t++) {
          try {
            const r = await fetch(url).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const st = r[0];
              if (st?.status === "success") {
                fillTx = st?.transactionHash;
                break;
              }
              if (st?.status === "failed") {
                trace.fillFailed = st;
                break;
              }
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 5_000));
        }
        trace.fillTx = fillTx;
        setSepoliaTxHint(fillTx ?? null);
        logActivity(evmAddress, {
          type: "withdraw",
          basket: basket?.symbol ?? "DCC",
          amount: humanAmount,
          tx: fillTx ?? undefined,
        });
        setStage("done");
        trace.finishedAt = Date.now();
        trace.wallClockMs =
          (trace.finishedAt as number) - (trace.startedAt as number);
        log("done", trace.wallClockMs + "ms");
        return trace;
      } catch (e) {
        trace.error = e instanceof Error ? e.message : String(e);
        trace.finishedAt = Date.now();
        setErrorMsg(String(trace.error));
        setStage("error");
        return trace;
      } finally {
        resumeSync();
      }
    },
    [
      createWallet,
      pauseSync,
      resumeSync,
      runExclusive,
      syncState,
      waitForConsumableNotes,
      consume,
      sendNote,
      waitForCommit,
      client,
      compileTxScript,
      executeTx,
      basket,
    ],
  );

  // Full autonomous ROUNDTRIP: deposit (Sepolia→Miden) into a FRESH
  // derived wallet, consume the delivered note, then redeem it back
  // (Miden→Sepolia). Solves the fresh-IndexedDB problem an autonomous
  // runner hits: a brand-new browser profile has no vault balance, so a
  // redeem-only test can never spend. The deposit leg funds the wallet
  // first — and as a bonus the loop covers BOTH bridge directions
  // against the real Epoch allocator + real Miden network, no mocks.
  const runAutonomousRoundtrip = useCallback(
    async (devKeyHex: string, redeemAmount: string, salt?: string) => {
      const trace: Record<string, unknown> = {
        redeemAmount,
        startedAt: Date.now(),
      };
      const log = (step: string, extra?: unknown) => {
        const t = (
          (Date.now() - (trace.startedAt as number)) /
          1000
        ).toFixed(1);
        console.log(`[roundtrip t+${t}s] ${step}`, extra ?? "");
      };
      setErrorMsg(null);
      setNoteId(null);
      setMidenTxId(null);
      setSepoliaTxHint(null);
      setIntentNonce(null);
      pauseSync();
      try {
        const runSalt = salt ?? String(Math.floor(Math.random() * 1e9));
        trace.salt = runSalt;
        log("start", `salt=${runSalt}`);
        const account = privateKeyToAccount(devKeyHex as `0x${string}`);
        const evm = account.address as `0x${string}`;
        trace.evm = evm;

        // ── Fresh wallet per run: same production derivation, isolated
        // by a keyIndex derived from the run salt (replaces the old
        // salted personal_sign message so the E2E stays on the real path).
        setStage("deriving");
        const keyIndex = BigInt(keccak256(toBytes(String(runSalt))));
        const freshWalletId = await deriveDevWallet(account, keyIndex);
        setWalletId(freshWalletId);
        trace.walletId = freshWalletId;
        log("fresh wallet", freshWalletId);

        // ── Deposit leg: Sepolia USDC → dUSDC note to the fresh wallet.
        setStage("sync-vault");
        setVaultSyncMsg("deposit leg: quoting Sepolia→Miden…");
        const sepoliaWC = localSepoliaSigningClient(account);
        const sdkDep = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient: sepoliaWC,
        });
        const DEPOSIT_HUMAN = "0.5"; // dUSDC out — covers any redeem ≤ ~0.45
        const minTokenOut = applySlippageBps(
          dusdcMidenBaseUnits(DEPOSIT_HUMAN),
          EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
        );
        const dQuote = await fetchQuote(sdkDep, {
          evmSourceAddress: evm,
          midenRecipientId: freshWalletId,
          minTokenOut,
        });
        trace.depositTokenIn = String(dQuote.quoteResult.tokenIn ?? "");
        log("deposit quote OK", trace.depositTokenIn);

        setVaultSyncMsg(
          "deposit leg: signing Compact deposit on Sepolia (local key)…",
        );
        const dSubmit = await submitIntent(sdkDep, dQuote);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dS = dSubmit as any;
        const dNonce = String(
          dS?.nonce ?? dS?.submittedIntentData?.compact?.nonce ?? "",
        );
        trace.depositNonce = dNonce;
        log("deposit intent submitted", dNonce.slice(-6));

        setVaultSyncMsg("deposit leg: waiting for Epoch delivery (~60s)…");
        let depositNoteId: string | undefined;
        for (let t = 0; t < 24; t++) {
          try {
            const r = await fetch(
              `${ALLOCATOR_URL}/intentStatus/${evm}/${dNonce}`,
            ).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const st = r[0];
              if (st?.status === "success") {
                depositNoteId = st?.midenNoteId;
                break;
              }
              if (st?.status === "failed") {
                throw new Error(
                  `deposit intent failed: ${JSON.stringify(st).slice(0, 150)}`,
                );
              }
            }
          } catch (e) {
            if (String(e).includes("deposit intent failed")) throw e;
          }
          await new Promise((r) => setTimeout(r, 5_000));
        }
        if (!depositNoteId) throw new Error("deposit never resolved");
        trace.depositNoteId = depositNoteId;
        log("deposit delivered", depositNoteId);

        // ── Consume the delivered P2ID note into the fresh vault.
        setVaultSyncMsg("deposit leg: syncing to pick up the note…");
        for (let i = 0; i < 3; i++) {
          try {
            await runExclusive(() => syncState());
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        }
        setVaultSyncMsg("deposit leg: waiting for the note to be consumable…");
        const raced = await Promise.race<unknown[] | undefined>([
          waitForConsumableNotes({
            accountId: freshWalletId!,
            minCount: 1,
            timeoutMs: 90_000,
            intervalMs: 5_000,
          }) as Promise<unknown[] | undefined>,
          new Promise<unknown[]>((resolve) =>
            setTimeout(() => resolve([]), 95_000),
          ),
        ]);
        const pending = Array.isArray(raced) ? raced : [];
        if (pending.length === 0) {
          throw new Error("delivered note never became consumable locally");
        }
        setVaultSyncMsg(`deposit leg: consuming ${pending.length} note(s)…`);
        log("consuming", pending.length);
        const rtPendingIds = (pending as Array<{
          inputNoteRecord?: () => { id?: () => { toString?: () => string } } | null;
        }>)
          .map((n) => n.inputNoteRecord?.()?.id?.()?.toString?.() ?? "")
          .filter(Boolean);
        await consume({ accountId: freshWalletId!, notes: rtPendingIds });
        trace.consumed = pending.length;
        await new Promise((r) => setTimeout(r, 2_000));
        setVaultSyncMsg(null);
        log("vault funded — crediting slot-10 position");

        // ── Network mode (salt prefixed "net-"): the fresh wallet emits
        // an atomic deposit note at the NETWORK controller and the NTX
        // builder executes the credit — the browser never touches the
        // controller. Ends here (no redeem leg): the assertion is the
        // NTB consuming the note and slot-10 moving on the network
        // controller.
        // conf- salt: v10 CONFIDENTIAL deposit — emit at the basket
        // faucet-network; the NTX builder drains the collateral and mints
        // basket tokens into a PRIVATE note this wallet consumes.
        if (runSalt.startsWith("conf-")) {
          log("confidential mode — emitting deposit note at the basket faucet");
          const emitBase = (BigInt(dusdcMidenBaseUnits(DEPOSIT_HUMAN)) * 95n) / 100n;
          const rn = await fetch("/api/confidential-note", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sender: freshWalletId,
              recipient: freshWalletId,
              basket: basket?.symbol ?? "DCC",
              amount: emitBase.toString(),
            }),
          });
          const built = (await rn.json()) as {
            noteId?: string;
            noteB64?: string;
            paybackId?: string;
            paybackFileB64?: string;
            mintAmount?: string;
            error?: string;
          };
          if (!rn.ok || !built.noteB64 || !built.paybackFileB64) {
            throw new Error(built.error ?? `confidential-note ${rn.status}`);
          }
          const { Note, NoteArray, NoteFile } = await import("@miden-sdk/miden-sdk");
          const nbytes = Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0));
          const depositNote = Note.deserialize(nbytes);
          const emitRes = await executeTx({
            accountId: freshWalletId!,
            request: () =>
              new TransactionRequestBuilder()
                .withOwnOutputNotes(new NoteArray([depositNote]))
                .build(),
          });
          trace.confNoteId = built.noteId;
          trace.confEmitTx = emitRes?.transactionId?.toString?.() ?? null;
          trace.confMintAmount = built.mintAmount;
          log("CONFIDENTIAL NOTE EMITTED", `${built.noteId} mint=${built.mintAmount}`);
          // Import + consume the minted private token note.
          const fileBytes = Uint8Array.from(atob(built.paybackFileB64), (c) => c.charCodeAt(0));
          const noteFile = NoteFile.deserialize(fileBytes);
          const cAny = client as unknown as {
            importNoteFile?: (f: unknown) => Promise<string>;
          };
          await cAny.importNoteFile?.(noteFile);
          let minted = false;
          for (let i = 0; i < 30 && !minted; i++) {
            await new Promise((res) => setTimeout(res, 5_000));
            try {
              await runExclusive(() => syncState());
            } catch (_) {}
            try {
              await consume({ accountId: freshWalletId!, notes: [built.paybackId!] });
              minted = true;
            } catch (_) {
              /* not minted yet */
            }
          }
          trace.confMinted = minted;
          log(minted ? "TOKENS MINTED + CONSUMED (private)" : "mint not consumable in 150s");
          setStage("done");
          console.log("[roundtrip] CONFIDENTIAL DONE", JSON.stringify(trace));
          return trace;
        }

        if (runSalt.startsWith("net-")) {
          log("network mode — emitting deposit note at the network controller");
          const emitBase = (BigInt(dusdcMidenBaseUnits(DEPOSIT_HUMAN)) * 95n) / 100n;
          const rn = await fetch("/api/network-note", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sender: freshWalletId,
              userEvm: evm,
              basket: basket?.symbol ?? "DCC",
              amount: emitBase.toString(),
            }),
          });
          const built = (await rn.json()) as {
            noteId?: string;
            noteB64?: string;
            error?: string;
          };
          if (!rn.ok || !built.noteB64) {
            throw new Error(built.error ?? `network-note ${rn.status}`);
          }
          const { Note, NoteArray } = await import("@miden-sdk/miden-sdk");
          const nbytes = Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0));
          const depositNote = Note.deserialize(nbytes);
          const emitRes = await executeTx({
            accountId: freshWalletId!,
            request: () =>
              new TransactionRequestBuilder()
                .withOwnOutputNotes(new NoteArray([depositNote]))
                .build(),
          });
          trace.networkNoteId = built.noteId;
          trace.networkEmitTx = emitRes?.transactionId?.toString?.() ?? null;
          log(
            "NETWORK NOTE EMITTED",
            `${built.noteId} emitTx=${trace.networkEmitTx}`,
          );
          setStage("done");
          console.log("[roundtrip] NETWORK DONE", JSON.stringify(trace));
          return trace;
        }

        // ── Credit the trustless-controller position with the deposit —
        // full Darwin accounting: read-modify-write on slot-10.
        // Per-basket keying when the panel has a basket prop — the
        // roundtrip then exercises the exact native accounting path.
        const rtFelts = basket
          ? await basketFelts(basket.faucetHex)
          : { basketSuffix: 0n, basketPrefix: 0n };
        trace.basket = basket?.symbol ?? "flat";
        const setPosition = async (newPos: bigint) => {
          const clientAny = client as unknown as {
            importAccountById?: (id: unknown) => Promise<unknown>;
            syncState?: () => Promise<unknown>;
          };
          const { AccountId } = await import("@miden-sdk/miden-sdk");
          const accId = AccountId.fromHex(TRUSTLESS_CONTROLLER_HEX);
          try {
            await clientAny.importAccountById?.(accId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/already being tracked/i.test(msg)) throw e;
          }
          try {
            await clientAny.syncState?.();
          } catch (_) {}
          const { suffix, prefix } = evmToUserIdFelts(evm);
          const scriptSrc = buildSetPositionScript(
            suffix,
            prefix,
            newPos,
            rtFelts.basketSuffix,
            rtFelts.basketPrefix,
          );
          const txScript = await compileTxScript({ code: scriptSrc });
          try {
            const res = await executeTx({
              accountId: TRUSTLESS_CONTROLLER_HEX,
              request: () =>
                new TransactionRequestBuilder()
                  .withCustomScript(txScript)
                  .build(),
            });
            return res?.transactionId?.toString?.() ?? "submitted";
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (
              !/apply transaction result|storage error: account data wasn't found/i.test(
                msg,
              )
            ) {
              throw e;
            }
            return "submitted (apply-cosmetic)";
          }
        };
        try {
          const creditBase = dusdcMidenBaseUnits(DEPOSIT_HUMAN);
          const { position: posBefore, positionKnown: knownB } =
            await fetchTrustlessPosition(evm, rtFelts);
          trace.positionBeforeCredit = posBefore.toString();
          if (knownB) {
            const credited = posBefore + BigInt(creditBase);
            trace.creditTx = await setPosition(credited);
            trace.positionAfterCreditTarget = credited.toString();
            log("position credited", `${posBefore} -> ${credited}`);
          } else {
            trace.creditSkipped = "position read failed";
            log("credit skipped — position read failed");
          }
        } catch (e) {
          trace.creditError = String(e).slice(0, 200);
          log("credit failed", trace.creditError);
        }
        log("starting redeem leg");

        // ── Redeem leg: dUSDC → USDC back to the dev EVM address.
        setStage("quoting");
        const midenWC = {
          ...sepoliaWC,
          chain: { ...sepoliaWC.chain, id: MIDEN_DESTINATION_CHAIN_ID },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        const sdkRed = new EpochIntentSDK({
          apiBaseUrl: ALLOCATOR_URL,
          walletClient: midenWC,
        });
        const minSepoliaOut = applySlippageBps(
          usdcSepoliaBaseUnits(redeemAmount),
          EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
        );
        const rQuote = await fetchRedeemQuote(sdkRed, {
          midenSourceId: freshWalletId!,
          evmRecipient: evm,
          minUsdcSepoliaBaseUnits: minSepoliaOut,
        });
        trace.redeemTokenIn = String(rQuote.quoteResult.tokenIn ?? "");
        log("redeem quote OK", trace.redeemTokenIn);

        setStage("sending-note");
        let capturedMidenTxId: string | undefined;
        let capturedNoteId: string | undefined;
        const rSubmit = await submitRedeemIntent(
          sdkRed,
          rQuote,
          async (faucetId, amount, allocatorId) => {
            log("createMidenP2IDNote fired", amount);
            try {
              const out = await sendNote({
                  from: freshWalletId!,
                  to: allocatorId,
                  assetId: faucetId,
                  amount: BigInt(amount),
                  noteType: "public",
                  // returnNote builds the P2ID note explicitly and returns
                  // the Note object — without it SendResult.note is null and
                  // the Epoch SDK rejects our callback for missing noteId.
                  returnNote: true,
                });
              capturedMidenTxId = out?.txId;
              // Reference app waits for the note tx to COMMIT before
              // handing the noteId to the SDK (its 12s wait alone can be
              // shorter than a Miden block); mirror that here.
              if (capturedMidenTxId) {
                try {
                  await waitForCommit(capturedMidenTxId, {
                    timeoutMs: 120_000,
                    intervalMs: 4_000,
                  });
                } catch (_) {}
              }
              capturedNoteId =
                (out?.note as unknown as {
                  id?: () => { toString?: () => string };
                })
                  ?.id?.()
                  ?.toString?.() ?? undefined;
              setNoteId(capturedNoteId ?? null);
              setMidenTxId(capturedMidenTxId ?? null);
              log("P2IDE note created", capturedNoteId);
              return { success: true, noteId: capturedNoteId };
            } catch (e) {
              trace.p2ideError = String(e).slice(0, 200);
              log("sendNote threw", trace.p2ideError);
              return { success: false };
            }
          },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rS = rSubmit as any;
        const rNonce = String(
          rS?.nonce ?? rS?.submittedIntentData?.compact?.nonce ?? "",
        );
        if (rNonce) setIntentNonce(rNonce);
        trace.redeemNonce = rNonce;
        trace.midenTxId = capturedMidenTxId;
        trace.noteId = capturedNoteId;

        setStage("awaiting-fill");
        log("polling redeem fill", rNonce.slice(-6));
        let fillTx: string | undefined;
        for (let t = 0; t < 24; t++) {
          try {
            const r = await fetch(
              `${ALLOCATOR_URL}/intentStatus/${evm}/${rNonce}`,
            ).then((r) => r.json());
            if (Array.isArray(r) && r.length > 0) {
              const st = r[0];
              if (st?.status === "success") {
                fillTx = st?.transactionHash;
                break;
              }
              if (st?.status === "failed") {
                trace.fillFailed = st;
                break;
              }
            }
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 5_000));
        }
        trace.fillTx = fillTx;
        setSepoliaTxHint(fillTx ?? null);

        // ── Debit slot-10 with the dUSDC the redeem consumed.
        setStage("debiting");
        try {
          const spentBase = BigInt(String(rQuote.quoteResult.tokenIn ?? "0"));
          const { position: posBeforeD, positionKnown: knownD } =
            await fetchTrustlessPosition(evm, rtFelts);
          trace.positionBeforeDebit = posBeforeD.toString();
          if (knownD) {
            const debited =
              posBeforeD > spentBase ? posBeforeD - spentBase : 0n;
            trace.debitTx = await setPosition(debited);
            setDebitTx(String(trace.debitTx));
            trace.positionAfterDebitTarget = debited.toString();
            log("position debited", `${posBeforeD} -> ${debited}`);
          } else {
            trace.debitSkipped = "position read failed";
            log("debit skipped — position read failed");
          }
        } catch (e) {
          trace.debitError = String(e).slice(0, 200);
          log("debit failed", trace.debitError);
        }

        setStage("done");
        trace.finishedAt = Date.now();
        trace.wallClockMs =
          (trace.finishedAt as number) - (trace.startedAt as number);
        log("ROUNDTRIP DONE", `${trace.wallClockMs}ms fillTx=${fillTx}`);
        console.log("[roundtrip-trace]", JSON.stringify(trace));
        return trace;
      } catch (e) {
        trace.error = e instanceof Error ? e.message : String(e);
        trace.finishedAt = Date.now();
        setErrorMsg(String(trace.error));
        setStage("error");
        console.log("[roundtrip-trace]", JSON.stringify(trace));
        return trace;
      } finally {
        resumeSync();
      }
    },
    [
      createWallet,
      pauseSync,
      resumeSync,
      runExclusive,
      syncState,
      waitForConsumableNotes,
      consume,
      sendNote,
      waitForCommit,
      client,
      compileTxScript,
      executeTx,
      basket,
    ],
  );

  // Dev/test hook for the NETWORK rail's browser leg: derive a salted
  // wallet (one that already holds dUSDC from a prior roundtrip), fetch
  // the pre-assembled network deposit note, deserialize it, and emit it
  // from that wallet. The NTX builder does the rest — this exercises
  // exactly the deserialize+emit path the deposit panel's ?network=1
  // mode runs, without needing an Epoch leg.
  const runNetworkEmit = useCallback(
    async (devKeyHex: string, salt: string, amountBase: string, basketSym?: string) => {
      const account = privateKeyToAccount(devKeyHex as `0x${string}`);
      const evm = account.address as `0x${string}`;
      // Production derivation path, run-isolated by keyIndex(salt).
      const keyIndex = BigInt(keccak256(toBytes(String(salt))));
      const wid = await deriveDevWallet(account, keyIndex);
      await runExclusive(() => syncState());
      const r = await fetch("/api/network-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: wid,
          userEvm: evm,
          basket: basketSym ?? "DCC",
          amount: amountBase,
        }),
      });
      const built = (await r.json()) as { noteId?: string; noteB64?: string; error?: string };
      if (!r.ok || !built.noteB64) throw new Error(built.error ?? `network-note ${r.status}`);
      const { Note, NoteArray } = await import("@miden-sdk/miden-sdk");
      const bytes = Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0));
      const depositNote = Note.deserialize(bytes);
      const emitResult = await executeTx({
        accountId: wid,
        request: () =>
          new TransactionRequestBuilder()
            .withOwnOutputNotes(new NoteArray([depositNote]))
            .build(),
      });
      const out = {
        walletId: wid,
        noteId: built.noteId,
        emitTx: emitResult?.transactionId?.toString?.() ?? null,
      };
      console.log("[network-emit] DONE", JSON.stringify(out));
      return out;
    },
    [createWallet, executeTx, runExclusive, syncState],
  );

  // Dev/test hook for the NETWORK redeem's browser leg: derive a salted
  // wallet, emit the redeem request, import the private payback and
  // consume it. Mirrors onRedeem's ?network=1 branch without MetaMask.
  const runNetworkRedeem = useCallback(
    async (devKeyHex: string, salt: string, amountBase: string, basketSym?: string) => {
      const account = privateKeyToAccount(devKeyHex as `0x${string}`);
      const evm = account.address as `0x${string}`;
      // Production derivation path, run-isolated by keyIndex(salt).
      const keyIndex = BigInt(keccak256(toBytes(String(salt))));
      const wid = await deriveDevWallet(account, keyIndex);
      await runExclusive(() => syncState());

      const r = await fetch("/api/network-redeem-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: wid,
          recipient: wid,
          userEvm: evm,
          basket: basketSym ?? "DCC",
          amount: amountBase,
        }),
      });
      const built = (await r.json()) as {
        noteId?: string;
        noteB64?: string;
        paybackId?: string;
        paybackFileB64?: string;
        error?: string;
      };
      if (!r.ok || !built.noteB64 || !built.paybackFileB64) {
        throw new Error(built.error ?? `network-redeem-note ${r.status}`);
      }
      const { Note, NoteArray, NoteFile } = await import("@miden-sdk/miden-sdk");
      const reqBytes = Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0));
      const requestNote = Note.deserialize(reqBytes);
      const emitRes = await executeTx({
        accountId: wid,
        request: () =>
          new TransactionRequestBuilder()
            .withOwnOutputNotes(new NoteArray([requestNote]))
            .build(),
      });
      const emitTx = emitRes?.transactionId?.toString?.() ?? null;
      console.log("[network-redeem-test] request emitted", built.noteId, emitTx);

      const fileBytes = Uint8Array.from(atob(built.paybackFileB64), (c) => c.charCodeAt(0));
      const noteFile = NoteFile.deserialize(fileBytes);
      const clientAny = client as unknown as {
        importNoteFile?: (f: unknown) => Promise<string>;
      };
      await clientAny.importNoteFile?.(noteFile);
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 5_000));
        try {
          await runExclusive(() => syncState());
        } catch (_) {}
        try {
          await consume({ accountId: wid, notes: [built.paybackId!] });
          const out = {
            walletId: wid,
            requestNoteId: built.noteId,
            emitTx,
            paybackId: built.paybackId,
            consumedAfterSec: (i + 1) * 5,
          };
          console.log("[network-redeem-test] DONE", JSON.stringify(out));
          return out;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`[network-redeem-test] not ready (${i}):`, msg.slice(0, 90));
        }
      }
      throw new Error("payback not consumable after 150s");
    },
    [client, consume, createWallet, executeTx, runExclusive, syncState],
  );

  // Expose the same flow via a window function for direct JS testing.
  // DEV-ONLY: these hooks hand any injected script a turnkey
  // derive/sign/emit/redeem toolkit driven by the already-loaded wallet,
  // so they are dead-code-eliminated from prod builds.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as {
      __darwinTrustlessRedeem?: (
        devKeyHex: string,
        humanAmount: string,
      ) => Promise<unknown>;
      __darwinTrustlessRoundtrip?: (
        devKeyHex: string,
        redeemAmount: string,
        salt?: string,
      ) => Promise<unknown>;
      __darwinNetworkEmit?: (
        devKeyHex: string,
        salt: string,
        amountBase: string,
        basketSym?: string,
      ) => Promise<unknown>;
    };
    w.__darwinTrustlessRedeem = runAutonomousFlow;
    w.__darwinTrustlessRoundtrip = runAutonomousRoundtrip;
    w.__darwinNetworkEmit = runNetworkEmit;
    (w as unknown as {
      __darwinNetworkRedeem?: typeof runNetworkRedeem;
    }).__darwinNetworkRedeem = runNetworkRedeem;
    return () => {
      if (w.__darwinTrustlessRedeem === runAutonomousFlow) {
        delete w.__darwinTrustlessRedeem;
      }
      if (w.__darwinTrustlessRoundtrip === runAutonomousRoundtrip) {
        delete w.__darwinTrustlessRoundtrip;
      }
    };
  }, [runAutonomousFlow, runAutonomousRoundtrip, runNetworkEmit, runNetworkRedeem]);


  // Silence the internal @miden-sdk error banner when it's just "already
  // being tracked" — that's expected on re-derive; onDerive handles it.
  const visibleCreateErr =
    createErr?.message && /already being tracked/i.test(createErr.message)
      ? null
      : createErr?.message ?? null;

  async function onDerive() {
    if (!evmAddress) {
      setErrorMsg("Connect your ETH wallet above first.");
      return;
    }
    try {
      setErrorMsg(null);
      setStage("signing");
      // Minimal seed exposure — signature + seed stay inside
      // deriveMidenWallet and the seed is wiped after createWallet.
      setStage("deriving");
      pauseSync();
      let resolvedWalletId: string;
      try {
        resolvedWalletId = await deriveMidenWallet(createWallet, {
          evmAddress,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signTypedData: (td) => signTypedDataAsync(td as any),
          getCode: (addr) => publicClient!.getCode({ address: addr }),
          // Silent auto-restore on a cleared store / new device.
          tryRestore: () =>
            restoreFromBackup({ client, runExclusive, syncState, evmAddress: evmAddress! }),
        });
      } finally {
        resumeSync();
      }
      setWalletId(resolvedWalletId);
      storeWalletId(evmAddress, resolvedWalletId);
      setStage("ready");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    }
  }

  // Callback the Epoch SDK invokes to spend dUSDC from the derived wallet
  // into a P2ID note targeting Epoch's allocator on Miden. useSend does
  // WASM proving + submit. IMPORTANT: consume()/sendNote() must be called
  // BARE — they acquire the client mutex internally, so wrapping them in
  // runExclusive self-deadlocks (verified live: 'draining N notes' hung
  // forever). Only syncState() gets the runExclusive treatment.
  const buildCreateNoteCallback = useCallback(
    (fromWallet: string) => {
      return async (
        faucetId: string,
        amount: string,
        allocatorId: string,
      ) => {
        try {
          const out = await sendNote({
              from: fromWallet,
              to: allocatorId,
              assetId: faucetId,
              amount: BigInt(amount),
              noteType: "public",
              // Plain public P2ID — matches the reference app's
              // crosschain IntentForm exactly (SendTransaction(..., 'public',
              // amount), NO recallHeight). A recall height in the past made
              // the note reclaimable immediately and solvers may skip it.
              // returnNote: SendResult.note is null without it, and the
              // Epoch SDK rejects a callback result with no noteId.
              returnNote: true,
            });
          if (out?.txId) {
            try {
              await waitForCommit(out.txId, {
                timeoutMs: 120_000,
                intervalMs: 4_000,
              });
            } catch (_) {}
          }
          const outNoteId =
            (out?.note as unknown as { id?: () => { toString?: () => string } })
              ?.id?.()
              ?.toString?.() ?? undefined;
          setNoteId(outNoteId ?? null);
          setMidenTxId(out?.txId ?? null);
          return { success: true, noteId: outNoteId };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[redeem] createMidenP2IDNote failed:", msg);
          return { success: false };
        }
      };
    },
    [runExclusive, sendNote, waitForCommit],
  );

  async function onRedeem() {
    if (!walletId || !evmAddress) return;
    pauseSync();
    try {
      setErrorMsg(null);
      setNetPhase("withdraw");

      if (network) {
        // ── Confidential rail: emit a confidential_redeem_note carrying
        // the user's own basket tokens at the basket faucet-network
        // account; the NTX builder burns them and releases the dUSDC into
        // a PRIVATE payback note. Symmetric to the confidential deposit.
        //
        // This replaces the old /api/network-redeem-note slot-10 rail,
        // which (a) debited a public controller position the confidential
        // deposit never credited, and (b) paid out unconditionally from
        // the controller vault regardless of that position — an
        // unauthenticated drain. The confidential redeem burns the REAL
        // basket tokens the user holds (must own them to fund the note)
        // and the on-chain note pays out exactly that burned amount.
        // NAV baskets: burn SHARES (8-dec) priced at the live NAV to release
        // ~humanAmount dUSDC. shares = usdc / navPerShare, +2% buffer so the
        // released dUSDC covers the reverse-quote's tokenIn (Epoch fee). The
        // redeem note computes the exact release on-chain. Non-NAV: 1:1 dUSDC.
        const isNav = isNavBasket(basket?.symbol ?? "DCC");
        const amountBase = isNav
          ? BigInt(
              Math.ceil(
                (parseFloat(humanAmount || "0") / (navPerShare || 1)) * 1e8 * 1.02,
              ),
            )
          : parseUnits(humanAmount, 6);
        setStage("quoting");
        const r = await fetch("/api/confidential-redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sender: walletId,
            recipient: walletId,
            basket: basket?.symbol ?? "DCC",
            amount: amountBase.toString(),
          }),
        });
        const built = (await r.json()) as {
          noteId?: string;
          noteB64?: string;
          paybackId?: string;
          paybackFileB64?: string;
          error?: string;
        };
        if (!r.ok || !built.noteB64 || !built.paybackFileB64) {
          throw new Error(built.error ?? `confidential-redeem ${r.status}`);
        }

        setStage("sending-note");
        const { Note, NoteArray, NoteFile } = await import("@miden-sdk/miden-sdk");
        const reqBytes = Uint8Array.from(atob(built.noteB64), (c) => c.charCodeAt(0));
        const requestNote = Note.deserialize(reqBytes);
        const emitRes = await executeTx({
          accountId: walletId,
          request: () =>
            new TransactionRequestBuilder()
              .withOwnOutputNotes(new NoteArray([requestNote]))
              .build(),
        });
        setNoteId(built.noteId ?? null);
        setMidenTxId(emitRes?.transactionId?.toString?.() ?? null);
        console.log("[network-redeem] request emitted", built.noteId);

        // Import the private payback's details — only this browser knows
        // them — then wait for the NTB to create it and consume.
        setStage("awaiting-fill");
        const fileBytes = Uint8Array.from(atob(built.paybackFileB64), (c) => c.charCodeAt(0));
        const noteFile = NoteFile.deserialize(fileBytes);
        const clientAny = client as unknown as {
          importNoteFile?: (f: unknown) => Promise<string>;
        };
        await clientAny.importNoteFile?.(noteFile);
        let consumed = false;
        for (let i = 0; i < 30 && !consumed; i++) {
          await new Promise((res) => setTimeout(res, 5_000));
          try {
            await runExclusive(() => syncState());
          } catch (_) {}
          try {
            await consume({ accountId: walletId, notes: [built.paybackId!] });
            consumed = true;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`[network-redeem] payback not ready (${i}):`, msg.slice(0, 90));
          }
        }
        if (!consumed) {
          throw new Error(
            "payback note not consumable after 150s — check network-note-status",
          );
        }
        setDebitTx("executed by the network — same tx as the payout");
        console.log(
          "[network-redeem] payback consumed — chaining the Sepolia exit",
        );
        // Chain the Sepolia exit: the wallet now holds the dUSDC — fall
        // through into the classic Epoch leg (P2IDE -> USDC on Sepolia).
        setNetPhase("exit");
        setNoteId(null);
        setMidenTxId(null);
        setSepoliaTxHint(null);
        setIntentNonce(null);
      }

      // Force-sync the derived wallet and drain any consumable notes into
      // the vault before we spend dUSDC. Every WASM call goes through
      // runExclusive so the background auto-sync + any other Miden hook
      // can't race and panic on RefCell (the /trustless route already
      // isolates this panel; runExclusive is belt-and-braces).
      setStage("sync-vault");
      for (let i = 0; i < 3; i++) {
        setVaultSyncMsg(`syncing derived wallet (${i + 1}/3)…`);
        try {
          await runExclusive(() => syncState());
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 1500));
      }
      setVaultSyncMsg("scanning for pending P2ID notes (~15s)…");
      console.log("[redeem] waitForConsumableNotes start");
      // Same hard Promise.race cap as the autonomous flow —
      // waitForConsumableNotes' internal timeout isn't honoured in some
      // contexts and it must NOT run inside runExclusive (a hang there
      // would hold the mutex and block the send() prove downstream).
      let pendingNotes: unknown[] = [];
      try {
        const raced = await Promise.race<unknown[] | undefined>([
          waitForConsumableNotes({
            accountId: walletId,
            minCount: 1,
            timeoutMs: 15_000,
            intervalMs: 3_000,
          }) as Promise<unknown[] | undefined>,
          new Promise<unknown[]>((resolve) =>
            setTimeout(() => resolve([]), 18_000),
          ),
        ]);
        pendingNotes = Array.isArray(raced) ? raced : [];
      } catch (e) {
        console.log("[redeem] scan threw:", String(e).slice(0, 120));
        pendingNotes = [];
      }
      console.log("[redeem] scan done, consumable:", pendingNotes.length);
      if (pendingNotes.length > 0) {
        setVaultSyncMsg(
          `draining ${pendingNotes.length} note(s) into vault…`,
        );
        try {
          const pendingIds = (pendingNotes as Array<{
          inputNoteRecord?: () => { id?: () => { toString?: () => string } } | null;
        }>)
          .map((n) => n.inputNoteRecord?.()?.id?.()?.toString?.() ?? "")
          .filter(Boolean);
        await consume({ accountId: walletId, notes: pendingIds });
          // Small settle beat so IndexedDB reflects the new vault balance
          // by the time send() reads it.
          await new Promise((res) => setTimeout(res, 1500));
        } catch (e) {
          console.warn("[redeem] consume failed:", e);
        }
      } else {
        setVaultSyncMsg(
          "no consumable notes — vault already funded from a prior drain",
        );
        await new Promise((res) => setTimeout(res, 1000));
      }
      setVaultSyncMsg(null);

      setStage("quoting");

      // Epoch requires walletClient.chain.id = MIDEN_DESTINATION_CHAIN_ID
      // for the Miden→EVM path (see reference app's useEpochIntent).
      try {
        await switchChainAsync({ chainId: SEPOLIA_CHAIN_ID });
      } catch (_) {}
      const eth = (window as unknown as { ethereum?: unknown }).ethereum;
      if (!eth) throw new Error("No injected ETH provider (MetaMask?)");
      const sepoliaWalletClient = createWalletClient({
        account: evmAddress as `0x${string}`,
        chain: sepolia,
        transport: custom(eth as never),
      });
      // Override the chain id to Miden's virtual chain — the Epoch SDK
      // uses it to route the intent as Miden-collateralized.
      const midenWalletClient = {
        ...sepoliaWalletClient,
        chain: { ...sepoliaWalletClient.chain, id: MIDEN_DESTINATION_CHAIN_ID },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      sdkRef.current = new EpochIntentSDK({
        apiBaseUrl: ALLOCATOR_URL,
        walletClient: midenWalletClient,
      });

      // Reverse quote: user asks "give me at least X USDC on Sepolia" and
      // the backend computes how much dUSDC input is needed.
      const minSepoliaOut = applySlippageBps(
        usdcSepoliaBaseUnits(humanAmount),
        EPOCH_MIN_TOKEN_OUT_SLIPPAGE_BPS,
      );
      console.log("[redeem] fetching reverse quote…");
      const quote = await fetchRedeemQuote(sdkRef.current, {
        midenSourceId: walletId,
        evmRecipient: evmAddress as `0x${string}`,
        minUsdcSepoliaBaseUnits: minSepoliaOut,
      });
      console.log(
        "[redeem] quote OK — dUSDC in:",
        String(quote.quoteResult.tokenIn ?? "?"),
      );

      setStage("sending-note");
      console.log("[redeem] submitting intent (P2IDE note will prove in WASM)…");
      const submit = await submitRedeemIntent(
        sdkRef.current,
        quote,
        buildCreateNoteCallback(walletId),
      );
      console.log("[redeem] intent submitted");

      const nonce =
        (submit as { nonce?: string })?.nonce ??
        (submit as { submittedIntentData?: { compact?: { nonce?: string } } })
          ?.submittedIntentData?.compact?.nonce;
      if (nonce) setIntentNonce(String(nonce));

      setStage("awaiting-fill");
      // Poll Epoch's /intentStatus for the fill transaction hash.
      let filledTxHash: string | null = null;
      const start = Date.now();
      while (Date.now() - start < 3 * 60_000) {
        try {
          const r = await fetch(
            `${ALLOCATOR_URL}/intentStatus/${evmAddress}/${nonce}`,
          ).then((r) => r.json());
          if (Array.isArray(r) && r.length > 0) {
            const s = r[0];
            if (s.status === "success") {
              filledTxHash = s.transactionHash ?? null;
              break;
            }
            if (s.status === "failed") {
              throw new Error(`Epoch reported failed: ${JSON.stringify(s)}`);
            }
          }
        } catch (_) {}
        await new Promise((res) => setTimeout(res, 6_000));
      }
      setSepoliaTxHint(filledTxHash);

      // ── Debit the slot-10 position on the trustless controller —
      // mirror of the deposit panel's credit step, so the Darwin
      // position tracks both legs. Read-modify-write with the dUSDC
      // amount the redeem actually consumed.
      setStage("debiting");
      console.log("[redeem] debiting slot-10 position…");
      try {
        if (network) {
          // The NTB already debited the network position during the
          // withdraw leg — the classic NoAuth debit doesn't apply.
          throw new Error("__network_skip__");
        }
        const spentBase = BigInt(String(quote.quoteResult.tokenIn ?? "0"));
        const bFelts = basket
          ? await basketFelts(basket.faucetHex)
          : { basketSuffix: 0n, basketPrefix: 0n };
        const { position: currentPos, positionKnown } =
          await fetchTrustlessPosition(evmAddress, bFelts);
        if (!positionKnown) {
          // Never blind-write on a failed read — a debit that assumed 0
          // would wipe a real balance. Skip and surface in the UI.
          console.warn("[redeem] position read failed — skipping debit");
          setDebitTx("skipped (position read failed)");
        } else {
          const newPos = currentPos > spentBase ? currentPos - spentBase : 0n;
          const clientAny = client as unknown as {
            importAccountById?: (id: unknown) => Promise<unknown>;
            syncState?: () => Promise<unknown>;
          };
          const { AccountId } = await import("@miden-sdk/miden-sdk");
          const accId = AccountId.fromHex(TRUSTLESS_CONTROLLER_HEX);
          try {
            await clientAny.importAccountById?.(accId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/already being tracked/i.test(msg)) throw e;
          }
          try {
            await clientAny.syncState?.();
          } catch (_) {}
          const { suffix, prefix } = evmToUserIdFelts(evmAddress);
          const scriptSrc = buildSetPositionScript(
            suffix,
            prefix,
            newPos,
            bFelts.basketSuffix,
            bFelts.basketPrefix,
          );
          const txScript = await compileTxScript({ code: scriptSrc });
          try {
            const res = await executeTx({
              accountId: TRUSTLESS_CONTROLLER_HEX,
              request: () =>
                new TransactionRequestBuilder()
                  .withCustomScript(txScript)
                  .build(),
            });
            setDebitTx(res?.transactionId?.toString?.() ?? "submitted");
          } catch (e) {
            // Same cosmetic apply-error as the deposit panel: the tx is
            // submitted + committed on-chain but the local store can't
            // apply the foreign-account delta. Swallow that one only.
            const msg = e instanceof Error ? e.message : String(e);
            if (
              !/apply transaction result|storage error: account data wasn't found/i.test(
                msg,
              )
            ) {
              throw e;
            }
            setDebitTx("submitted (see midenscan)");
          }
          console.log(
            "[redeem] position debited:",
            currentPos.toString(),
            "→",
            newPos.toString(),
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message === "__network_skip__") {
          // network mode: debit already done on the network controller.
        } else {
          // A debit failure shouldn't mask a successful redeem — the USDC
          // is already on Sepolia. Record and continue to done.
          console.warn("[redeem] debit failed:", e);
          setDebitTx("failed (redeem itself succeeded)");
        }
      }

      // Refresh the cached DCC balance after the burn (getBalance works here —
      // warm client) so the panel shows the reduced balance right away.
      if (walletId)
        await stashDccBalance(client, runExclusive, walletId, basket?.symbol ?? "DCC");

      // Silent auto-backup — the withdraw changed the wallet's state.
      if (walletId && evmAddress)
        void autoBackupWallet({
          client,
          runExclusive,
          walletId,
          evmAddress: evmAddress as `0x${string}`,
          signTypedData: (td) => signTypedDataAsync(td as any),
          force: true,
        });

      setStage("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage("error");
    } finally {
      resumeSync();
    }
  }

  // ── Withdraw-amount / balance validation. The withdraw burns basket
  // tokens 1:1 with the typed amount (parseUnits(humanAmount, 6)), so the cap
  // is the wallet's confidential token balance (positionBase). ──
  let redeemBase: bigint | null;
  try {
    redeemBase = parseUnits(humanAmount || "0", 6);
  } catch {
    redeemBase = null; // mid-typing
  }
  // Soft over-balance warning (non-NAV only — there redeemBase and positionBase
  // are both 6-dec dUSDC). For NAV the input is USDC and positionBase is 8-dec
  // shares, so the comparison is meaningless; an over-redeem reverts safely.
  const overPosition =
    !isNavBasket(basket?.symbol ?? "DCC") &&
    positionBase != null &&
    redeemBase != null &&
    redeemBase > positionBase;
  // The balance/Max are a best-effort helper (the confidential balance is a
  // slow in-browser read that can lag behind the mutex). They must NEVER gate
  // the withdraw — the button stays usable the instant an amount is typed,
  // exactly as it did before the balance read existed. Over-position is a soft
  // warning only; an over-withdraw just reverts on-chain (fee 0, no funds
  // lost). Only the amount being empty/zero disables the button.
  const redeemValid = redeemBase != null && redeemBase > 0n;
  // NAV baskets hold 8-dec shares priced at the vault's live NAV; the legacy
  // 1:1 rail holds 6-dec dUSDC. Read the token symbol + decimals from the
  // single source of truth so the balance never displays with the wrong scale
  // or label.
  const sym = basket?.symbol ?? "DCC";
  const isNav = isNavBasket(sym);
  const dec = basketDecimals(sym);
  const balToken = isNav ? sym : "USDC";
  const fmtBal = (base: bigint) =>
    parseFloat(formatUnits(base, dec)).toLocaleString(undefined, {
      maximumFractionDigits: 4,
    });
  // Balance line for NAV baskets shows BOTH the token amount (what you hold)
  // and its live USD value (amount × NAV-per-share) so the two are never
  // conflated — e.g. "98.8725 DCC · ≈ $99.63".
  const balLabel = (base: bigint): string => {
    const amount = `${fmtBal(base)} ${balToken}`;
    if (!isNav || navPerShare == null) return amount;
    const usd = parseFloat(formatUnits(base, dec)) * navPerShare;
    return `${amount} · ≈ $${usd.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };
  // Max = the full token balance, floored to 4 decimals (matches the balance
  // shown below). No cushion needed: the burn is 1:1 and the Epoch exit leg
  // consumes marginally LESS dUSDC than the burn releases (the slippage
  // buffer keeps tokenIn under the released amount), so the whole balance
  // withdraws — symmetric with the deposit Max.
  function setMaxRedeem() {
    if (positionBase == null || positionBase === 0n) return;
    // The input is "USDC to receive". NAV: the full DCC balance is worth
    // (shares × navPerShare) USD — floor a hair so rounding never asks for
    // more than the redeem releases. Non-NAV: the dUSDC balance 1:1.
    const usd = isNav
      ? (parseFloat(formatUnits(positionBase, dec)) * (navPerShare ?? 0)) * 0.99
      : parseFloat(formatUnits(positionBase, 6));
    const human = Math.floor(usd * 1e4) / 1e4;
    setHumanAmount(String(human));
  }

  return (
    <section style={{ marginTop: 24 }}>
      <style>{`
        @keyframes trustlessSpin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      {!compact && (
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
          {network
            ? "Withdraw · network-executed"
            : "Redeem · demo (no server, no extension)"}
        </h2>
      )}

      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 16 }}>
        {network
          ? "One action, two network hops: the Miden network debits your position and pays your wallet (~10s), then Epoch bridges the dUSDC to USDC on your Sepolia address (~2 min)."
          : "Burn your wallet's dUSDC into a P2IDE note; Epoch's solver pays USDC to your Sepolia address (~2 min)."}
      </p>

      {!ethConnected && (
        <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
          Connect your ETH wallet above to begin.
        </p>
      )}

      {/* Autonomous test — Playwright-driven E2E. Same real WASM + real
          Epoch + real network as the manual flow; the only shortcut is
          skipping wagmi/MetaMask by signing the derive message with a
          dev-only test key. Hidden behind a data-testid so a Playwright
          selector can find it without depending on the label text. */}
      {devMode &&
        stage !== "signing" &&
        stage !== "deriving" &&
        stage !== "sync-vault" &&
        stage !== "quoting" &&
        stage !== "sending-note" &&
        stage !== "awaiting-fill" && (
          <button
            data-testid="autonomous-redeem"
            onClick={() => {
              // Playwright pre-injects window.__devKey / __devAmount via
              // addInitScript so the click is a plain no-argument DOM
              // event. Manual users get a browser prompt fallback so the
              // button is still usable interactively.
              const w = window as unknown as {
                __devKey?: string;
                __devAmount?: string;
              };
              let key = w.__devKey;
              let amt = w.__devAmount ?? humanAmount;
              if (!key) {
                key =
                  window.prompt("Dev private key (testnet only):", "") ??
                  undefined;
                if (!key) return;
                amt = window.prompt("USDC amount to redeem:", humanAmount) ??
                  humanAmount;
              }
              void runAutonomousFlow(key, amt);
            }}
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono-stack)",
              padding: "6px 10px",
              border: "1px dashed var(--rule)",
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "pointer",
              marginBottom: 12,
              marginRight: 8,
            }}
          >
            ⚙ Autonomous test (dev key)
          </button>
        )}

      {devMode &&
        stage !== "signing" &&
        stage !== "deriving" &&
        stage !== "sync-vault" &&
        stage !== "quoting" &&
        stage !== "sending-note" &&
        stage !== "awaiting-fill" && (
          <button
            data-testid="autonomous-roundtrip"
            onClick={() => {
              const w = window as unknown as {
                __devKey?: string;
                __devAmount?: string;
                __devSalt?: string;
              };
              let key = w.__devKey;
              const amt = w.__devAmount ?? "0.1";
              if (!key) {
                key =
                  window.prompt("Dev private key (testnet only):", "") ??
                  undefined;
                if (!key) return;
              }
              void runAutonomousRoundtrip(key, amt, w.__devSalt);
            }}
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono-stack)",
              padding: "6px 10px",
              border: "1px dashed var(--rule)",
              background: "transparent",
              color: "var(--ink-3)",
              cursor: "pointer",
              marginBottom: 12,
            }}
          >
            ⚙⚙ Roundtrip test (deposit → redeem, fresh wallet)
          </button>
        )}

      {ethConnected &&
        !walletId &&
        stage !== "signing" &&
        stage !== "deriving" && (
          <button
            onClick={onDerive}
            className="nav-cta"
            style={{ minWidth: 260 }}
            disabled={isCreating}
          >
            Step 1 · Derive Miden key from MetaMask
          </button>
        )}

      {stage === "signing" && (
        <p style={{ fontSize: 13 }}>Waiting for MetaMask signature…</p>
      )}
      {stage === "deriving" && (
        <p style={{ fontSize: 13 }}>
          Building Miden wallet from your signature (WASM proof)…
        </p>
      )}

      {walletId && (
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            border: "1px solid var(--rule)",
            padding: 12,
            background: "var(--paper-2)",
            marginBottom: 16,
          }}
        >
          <div>
            <strong>Derived Miden wallet</strong>: <code>{walletId}</code>
          </div>
          <div style={{ color: "var(--ink-3)", marginTop: 4 }}>
            {isNav
              ? `Holds ${sym} shares priced at the vault's live NAV (from a prior deposit).`
              : "Must already hold dUSDC (from a prior deposit)."}
          </div>
        </div>
      )}

      {walletId &&
        stage !== "done" &&
        stage !== "quoting" &&
        stage !== "sending-note" &&
        stage !== "awaiting-fill" && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 13 }}>
                {network ? "Withdraw (USDC to Sepolia):" : "USDC to receive on Sepolia:"}{" "}
                <input
                  type="text"
                  inputMode="decimal"
                  value={humanAmount}
                  onChange={(e) => setHumanAmount(e.target.value)}
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: 13,
                    padding: "4px 8px",
                    width: 90,
                    border: `1px solid ${overPosition ? "crimson" : "var(--ink)"}`,
                    background: "var(--paper)",
                    color: "var(--ink)",
                  }}
                />
              </label>
              <button
                type="button"
                onClick={setMaxRedeem}
                disabled={positionBase == null || positionBase === 0n}
                className="nav-cta"
                style={{
                  padding: "4px 12px",
                  fontSize: 12,
                  opacity: positionBase == null || positionBase === 0n ? 0.5 : 1,
                }}
                title="Withdraw your full confidential balance"
              >
                Max
              </button>
              <button
                onClick={onRedeem}
                disabled={!redeemValid || (isNav && !navPerShare)}
                className="nav-cta"
                style={{
                  minWidth: 260,
                  opacity: !redeemValid || (isNav && !navPerShare) ? 0.5 : 1,
                }}
                title={
                  isNav && !navPerShare
                    ? "Loading the live NAV…"
                    : undefined
                }
              >
                {network ? "Withdraw" : "Redeem via Epoch (~2 min)"}
              </button>
            </div>
            {/* Balance line — reads the slot-10 position (fast, reliable). A
                brief "checking…" then the value. Never gates the withdraw. */}
            <div
              style={{
                fontSize: 12,
                marginTop: 6,
                fontFamily: "var(--font-mono-stack)",
                color: overPosition ? "crimson" : "var(--ink-3)",
              }}
            >
              {positionBase == null
                ? "Balance: reading confidential vault…"
                : overPosition
                  ? `Balance: ${balLabel(positionBase)} — more than you hold; a larger amount just reverts on-chain.`
                  : `Balance: ${balLabel(positionBase)}`}
            </div>
            {isNav && navPerShare != null && (
              <div
                style={{
                  fontSize: 12,
                  marginTop: 6,
                  fontFamily: "var(--font-mono-stack)",
                  color: "var(--ink-3)",
                }}
              >
                Burns {sym} shares at the live NAV (${navPerShare.toFixed(4)}
                /share) and bridges the released dUSDC to USDC on Sepolia. Enter
                the USDC you want out.
              </div>
            )}
            {/* Backup & restore are automatic + invisible — no buttons. Your
                confidential state is backed up on-chain (encrypted) after every
                deposit/withdraw, and restored silently on a new device. */}
          </div>
        )}

      {(stage === "sync-vault" ||
        stage === "quoting" ||
        stage === "sending-note" ||
        stage === "awaiting-fill" ||
        stage === "debiting" ||
        stage === "done") && (
        <div
          style={{
            fontSize: 12,
            fontFamily: "var(--font-mono-stack)",
            border: "1px solid var(--ink)",
            padding: 12,
            background: "var(--paper-2)",
            marginTop: 16,
          }}
        >
          <StageRow
            label={network ? "position check" : "sync vault"}
            testId="row-sync-vault"
            state={
              stage === "sync-vault"
                ? "running"
                : stage === "quoting" ||
                    stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "sync-vault"
                ? vaultSyncMsg ?? "syncing…"
                : stage === "quoting" ||
                    stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "vault ready"
                  : "waiting"
            }
          />
          {network && (
            <StageRow
              label="network withdraw"
              testId="row-network-withdraw"
              state={
                netPhase === "exit"
                  ? "done"
                  : stage === "quoting" ||
                      stage === "sending-note" ||
                      stage === "awaiting-fill"
                    ? "running"
                    : "idle"
              }
              detail={
                netPhase === "exit"
                  ? "position debited + dUSDC paid to your wallet by the network"
                  : stage === "quoting" ||
                      stage === "sending-note" ||
                      stage === "awaiting-fill"
                    ? "request note → the network debits and pays out (~10s)…"
                    : "waiting"
              }
            />
          )}
          <StageRow
            label="quote"
            testId="row-quote"
            state={
              stage === "quoting"
                ? "running"
                : stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "quoting"
                ? "Reverse-quoting Miden→Sepolia via Epoch…"
                : stage === "sending-note" ||
                    stage === "awaiting-fill" ||
                    stage === "done"
                  ? "quote ready"
                  : "waiting"
            }
          />
          <StageRow
            label="p2ide note"
            testId="row-p2ide"
            state={
              stage === "sending-note" && !noteId
                ? "running"
                : noteId || stage === "awaiting-fill" || stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "sending-note" && !noteId
                ? "Spending dUSDC → P2IDE note (WASM prove + submit)…"
                : noteId
                  ? noteId
                  : "waiting"
            }
            link={
              noteId ? `https://testnet.midenscan.com/note/${noteId}` : null
            }
          />
          <StageRow
            label="miden tx"
            testId="row-miden-tx"
            state={midenTxId ? "done" : stage === "sending-note" ? "running" : "idle"}
            detail={midenTxId ?? "waiting"}
            link={
              midenTxId
                ? `https://testnet.midenscan.com/tx/${midenTxId}`
                : null
            }
          />
          <StageRow
            label="epoch fill"
            testId="row-epoch-fill"
            state={
              stage === "awaiting-fill"
                ? "running"
                : sepoliaTxHint || stage === "debiting" || stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "awaiting-fill"
                ? "Epoch solver is consuming the note and paying you on Sepolia (~1-2 min)…"
                : sepoliaTxHint
                  ? sepoliaTxHint
                  : "waiting"
            }
            link={
              sepoliaTxHint && sepoliaTxHint.startsWith("0x")
                ? `https://sepolia.etherscan.io/tx/${sepoliaTxHint}`
                : null
            }
          />
          {!network && (
          <StageRow
            label="debit slot-10"
            testId="row-debit"
            state={
              stage === "debiting"
                ? "running"
                : debitTx || stage === "done"
                  ? "done"
                  : "idle"
            }
            detail={
              stage === "debiting"
                ? "Reading position + submitting set_user_position against v8-noauth…"
                : debitTx
                  ? debitTx
                  : "waiting"
            }
            link={
              debitTx && debitTx.startsWith("0x")
                ? `https://testnet.midenscan.com/tx/${debitTx}`
                : null
            }
          />
          )}
          {stage === "done" && (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--rule)",
                color: "var(--ink-3)",
              }}
            >
              {network ? (
                <>
                  ✅ USDC delivered to your Sepolia address. The Miden
                  network debited your position and paid your wallet from
                  the controller vault; Epoch bridged the exit — fully
                  self-custodial, end to end.
                </>
              ) : (
                <>
                  ✅ USDC delivered to your Sepolia address. Zero backend,
                  single provider (Epoch) for both bridge directions.
                </>
              )}
              {intentNonce && (
                <>
                  {" "}
                  Intent nonce: <code>{intentNonce}</code>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {(() => {
        const visibleErr = errorMsg
          ? errorMsg
          : visibleCreateErr;
        if (!visibleErr) return null;
        return (
          <p style={{ fontSize: 13, color: "crimson" }}>{visibleErr}</p>
        );
      })()}
    </section>
  );
}
