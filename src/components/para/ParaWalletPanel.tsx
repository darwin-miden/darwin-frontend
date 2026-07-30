"use client";

/**
 * Para connect panel — the "Connect with Para" button plus a live read-out of
 * the Para session and the Miden account it drives. Mirrors the upstream
 * react-signer example, wired to Darwin's look. Must be rendered inside
 * <ParaProviders>.
 */

import { useAccount, useMiden, useSigner, useSyncState } from "@miden-sdk/react";
import { useModal, useParaSigner } from "@miden-sdk/use-miden-para-react";

const PARA_API_KEY = process.env.NEXT_PUBLIC_PARA_API_KEY ?? "";

function short(v: string | null | undefined, head = 6, tail = 4) {
  if (!v) return "—";
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/10 py-2 last:border-0">
      <span className="text-sm text-white/50">{label}</span>
      <span className="max-w-[60%] break-all text-right font-mono text-sm text-white/90">
        {value}
      </span>
    </div>
  );
}

export function ParaWalletPanel() {
  const signer = useSigner();
  const { wallet, isConnected: paraConnected } = useParaSigner();
  const { openModal } = useModal();
  const { isReady, isInitializing, error, signerAccountId } = useMiden();
  const { syncHeight, isSyncing } = useSyncState();
  const account = useAccount(signerAccountId ?? undefined);

  const connected = !!signer?.isConnected;

  async function onConnect() {
    if (connected) {
      await signer?.disconnect();
    } else {
      openModal?.();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[460px] rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <h1 className="text-xl font-semibold text-white">Connect with Para</h1>
      <p className="mt-1 text-sm text-white/50">
        Sign in with email, Google, X or passkey — Para manages your Miden
        account. Fund it below from your own MetaMask / Rabby.
      </p>

      {!PARA_API_KEY && (
        <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          NEXT_PUBLIC_PARA_API_KEY is not set — get a BETA key at
          developer.getpara.com and add it to .env.local to enable sign-in.
        </p>
      )}

      <div className="mt-5">
        <Row label="Para connected" value={paraConnected ? "Yes" : "No"} />
        <Row label="Signer" value={signer?.name ?? "None"} />
        <Row label="Miden ready" value={isInitializing ? "Initializing…" : isReady ? "Yes" : "No"} />
        {wallet && <Row label="Para wallet" value={short(wallet.address ?? wallet.id)} />}
        {signerAccountId && <Row label="Miden account" value={short(signerAccountId, 8, 6)} />}
        {isReady && <Row label="Sync height" value={`${syncHeight}${isSyncing ? " (syncing…)" : ""}`} />}
        {account.assets.length > 0 &&
          account.assets.map((a) => (
            <Row key={a.assetId} label={a.symbol ?? "Asset"} value={a.amount.toString()} />
          ))}
        {error && <Row label="Error" value={error.message} />}
      </div>

      <button
        type="button"
        onClick={onConnect}
        className="nav-cta mt-6 w-full"
        style={{ textAlign: "center" }}
      >
        {connected ? "Disconnect Para" : "Connect with Para"}
      </button>
    </div>
  );
}
