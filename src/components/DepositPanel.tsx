"use client";

import { ConnectKitButton } from "connectkit";
import { useEffect, useMemo, useState } from "react";
import { decodeEventLog, parseUnits } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import {
  BasketDef,
  DARWIN_RELAY_ABI,
  DARWIN_RELAY_ADDRESS,
  DEPOSIT_STATUS_LABELS,
  ERC20_ABI,
  MOCK_USDC_ADDRESS,
  sepoliaAddressUrl,
  sepoliaTxUrl,
} from "../lib/contracts";

interface Props {
  basket: BasketDef;
}

type Phase =
  | "idle"
  | "needs_funds"
  | "approving"
  | "approve_pending"
  | "depositing"
  | "deposit_pending"
  | "tracking"
  | "settled"
  | "refunded"
  | "cancelled"
  | "error";

const USDC_DECIMALS = 6;
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function DepositPanel({ basket }: Props) {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState<string>("100");
  const [phase, setPhase] = useState<Phase>("idle");
  const [depositId, setDepositId] = useState<bigint | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- reads ---
  const usdcBalance = useReadContract({
    address: MOCK_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  const allowance = useReadContract({
    address: MOCK_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, DARWIN_RELAY_ADDRESS] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  const basketBalance = useReadContract({
    address: basket.tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  const deposit = useReadContract({
    address: DARWIN_RELAY_ADDRESS,
    abi: DARWIN_RELAY_ABI,
    functionName: "getDeposit",
    args: depositId ? [depositId] : undefined,
    query: {
      enabled: depositId != null,
      refetchInterval: 4000,
    },
  });

  // --- writes ---
  const { writeContractAsync, data: writeHash } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({
    hash: writeHash,
    query: { enabled: !!writeHash },
  });

  const amountWei = useMemo(() => {
    try {
      return parseUnits(amount || "0", USDC_DECIMALS);
    } catch {
      return 0n;
    }
  }, [amount]);

  // --- derived UI state ---
  const haveBalance =
    typeof usdcBalance.data === "bigint" && usdcBalance.data >= amountWei;
  const haveAllowance =
    typeof allowance.data === "bigint" && allowance.data >= amountWei;

  // Promote phase based on on-chain deposit status.
  useEffect(() => {
    const d = deposit.data as
      | {
          status: number;
          user: `0x${string}`;
          amount: bigint;
          basketId: `0x${string}`;
          midenRecipient: `0x${string}`;
          requestedAt: bigint;
        }
      | undefined;
    if (!d || depositId == null) return;
    if (d.status === 3) setPhase("settled");
    else if (d.status === 4) setPhase("cancelled");
    else if (d.status === 5) setPhase("refunded");
    else if (phase === "deposit_pending" && d.status >= 1) setPhase("tracking");
  }, [deposit.data, depositId, phase]);

  // After approve receipt lands, refetch allowance and unlock deposit.
  useEffect(() => {
    if (phase === "approve_pending" && receipt.isSuccess) {
      void allowance.refetch();
      setPhase("idle");
    }
  }, [receipt.isSuccess, phase, allowance]);

  // After deposit receipt lands, extract the id from the
  // RelayDepositRequested event.
  useEffect(() => {
    if (phase !== "deposit_pending" || !receipt.data) return;
    const log = receipt.data.logs.find(
      (l) => l.address.toLowerCase() === DARWIN_RELAY_ADDRESS.toLowerCase(),
    );
    if (!log) return;
    try {
      const decoded = decodeEventLog({
        abi: DARWIN_RELAY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "RelayDepositRequested") {
        const id = (decoded.args as unknown as { id: bigint }).id;
        setDepositId(id);
        setPhase("tracking");
      }
    } catch {
      // ignore
    }
  }, [receipt.data, phase]);

  async function handleMintUsdc() {
    if (!address) return;
    try {
      setErrorMsg(null);
      await writeContractAsync({
        address: MOCK_USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "mint",
        args: [address, parseUnits("1000", USDC_DECIMALS)],
      });
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }

  async function handleApprove() {
    try {
      setErrorMsg(null);
      setPhase("approving");
      await writeContractAsync({
        address: MOCK_USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [DARWIN_RELAY_ADDRESS, amountWei],
      });
      setPhase("approve_pending");
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }

  async function handleDeposit() {
    try {
      setErrorMsg(null);
      setPhase("depositing");
      setDepositId(null);
      await writeContractAsync({
        address: DARWIN_RELAY_ADDRESS,
        abi: DARWIN_RELAY_ABI,
        functionName: "deposit",
        args: [amountWei, basket.basketId, ZERO32],
      });
      setPhase("deposit_pending");
    } catch (e) {
      setErrorMsg(String(e));
      setPhase("error");
    }
  }

  if (!isConnected) {
    return (
      <div
        style={{
          padding: "1.2rem 1.4rem",
          background: "var(--paper-2)",
          borderLeft: "3px solid var(--orange)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>Connect a Sepolia wallet</h3>
        <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55, marginBottom: 12 }}>
          The relay accepts deposits in MockUSDC on Sepolia testnet. Once
          settled, you hold {basket.symbol} ERC20 directly.
        </p>
        <ConnectKitButton.Custom>
          {({ show }) => (
            <button
              onClick={show}
              style={{
                padding: "10px 18px",
                background: "var(--ink)",
                color: "var(--paper)",
                border: 0,
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Connect wallet
            </button>
          )}
        </ConnectKitButton.Custom>
      </div>
    );
  }

  const usdcBal = (usdcBalance.data as bigint | undefined) ?? 0n;
  const basketBal = (basketBalance.data as bigint | undefined) ?? 0n;

  return (
    <div
      style={{
        padding: "1.2rem 1.4rem",
        background: "var(--paper-2)",
        borderLeft: "3px solid var(--orange)",
        marginTop: "1.2rem",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 16 }}>Deposit USDC → {basket.symbol}</h3>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 13,
          lineHeight: 1.55,
          marginTop: 6,
          marginBottom: 12,
        }}
      >
        Locks MockUSDC in{" "}
        <a
          href={sepoliaAddressUrl(DARWIN_RELAY_ADDRESS)}
          target="_blank"
          rel="noreferrer"
          style={{ borderBottom: "1px dotted var(--rule)" }}
        >
          DarwinRelayDeposit
        </a>
        . The off-chain relay catches the event and mints{" "}
        <a
          href={sepoliaAddressUrl(basket.tokenAddress)}
          target="_blank"
          rel="noreferrer"
          style={{ borderBottom: "1px dotted var(--rule)" }}
        >
          {basket.symbol}
        </a>{" "}
        to you within ~65 s.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 8,
          columnGap: 16,
          fontSize: 13,
          marginBottom: 14,
        }}
      >
        <span style={{ color: "var(--ink-3)" }}>your USDC balance</span>
        <span style={{ fontFamily: "var(--font-mono-stack)" }}>
          {format6(usdcBal)} USDC
          {usdcBal === 0n && (
            <button
              onClick={handleMintUsdc}
              style={{
                marginLeft: 10,
                fontSize: 11,
                padding: "2px 8px",
                background: "var(--orange)",
                color: "var(--paper)",
                border: 0,
                cursor: "pointer",
              }}
            >
              mint 1000 (faucet)
            </button>
          )}
        </span>
        <span style={{ color: "var(--ink-3)" }}>your {basket.symbol} balance</span>
        <span style={{ fontFamily: "var(--font-mono-stack)" }}>
          {format6(basketBal)} {basket.symbol}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min={0}
          step={1}
          style={{
            flex: 1,
            padding: "10px 12px",
            fontFamily: "var(--font-mono-stack)",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
          }}
        />
        <span
          style={{
            alignSelf: "center",
            fontFamily: "var(--font-mono-stack)",
            color: "var(--ink-3)",
          }}
        >
          USDC
        </span>
      </div>

      {!haveAllowance && haveBalance && (
        <button
          disabled={phase === "approving" || phase === "approve_pending"}
          onClick={handleApprove}
          style={primaryBtn(phase === "approving" || phase === "approve_pending")}
        >
          {phase === "approve_pending"
            ? "Waiting for approval to confirm…"
            : phase === "approving"
            ? "Signing approval…"
            : `1. Approve ${amount} USDC`}
        </button>
      )}

      {haveAllowance && haveBalance && (
        <button
          disabled={phase === "depositing" || phase === "deposit_pending"}
          onClick={handleDeposit}
          style={primaryBtn(phase === "depositing" || phase === "deposit_pending")}
        >
          {phase === "deposit_pending"
            ? "Waiting for deposit tx…"
            : phase === "depositing"
            ? "Signing deposit…"
            : `2. Deposit ${amount} USDC → ${basket.symbol}`}
        </button>
      )}

      {!haveBalance && (
        <p style={{ color: "var(--orange)", fontSize: 13 }}>
          Not enough USDC. Click the “mint 1000 (faucet)” button above to top
          up — MockUSDC is permissionless on Sepolia.
        </p>
      )}

      {(phase === "tracking" || phase === "settled" || phase === "refunded") && depositId != null && (
        <DepositTracker depositId={depositId} basketSymbol={basket.symbol} />
      )}

      {writeHash && (
        <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 10 }}>
          Last tx:{" "}
          <a
            href={sepoliaTxUrl(writeHash)}
            target="_blank"
            rel="noreferrer"
            style={{ fontFamily: "var(--font-mono-stack)" }}
          >
            {writeHash.slice(0, 16)}…
          </a>
        </p>
      )}

      {errorMsg && (
        <pre
          style={{
            marginTop: 10,
            padding: 10,
            background: "#fff0f0",
            fontSize: 11,
            overflowX: "auto",
            color: "#a01a1a",
          }}
        >
          {errorMsg}
        </pre>
      )}
    </div>
  );
}

function DepositTracker({
  depositId,
  basketSymbol,
}: {
  depositId: bigint;
  basketSymbol: string;
}) {
  const deposit = useReadContract({
    address: DARWIN_RELAY_ADDRESS,
    abi: DARWIN_RELAY_ABI,
    functionName: "getDeposit",
    args: [depositId],
    query: { refetchInterval: 4000 },
  });
  const status = (deposit.data as { status: number } | undefined)?.status ?? 0;
  const label = DEPOSIT_STATUS_LABELS[status] ?? "unknown";
  const color =
    status === 3
      ? "var(--green)"
      : status === 5 || status === 4
      ? "#d23f3f"
      : "var(--orange)";

  return (
    <div
      style={{
        marginTop: 14,
        padding: "10px 14px",
        background: "var(--paper)",
        borderLeft: `3px solid ${color}`,
      }}
    >
      <strong style={{ fontSize: 13 }}>
        Deposit #{depositId.toString()} — {basketSymbol}
      </strong>
      <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "6px 0" }}>
        On-chain status:{" "}
        <span style={{ color, fontFamily: "var(--font-mono-stack)" }}>
          {label}
        </span>
      </p>
      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: 0 }}>
        {status === 3
          ? `🎉 ${basketSymbol} ERC20 minted to your wallet by the relay.`
          : status === 5
          ? "Relay refunded the USDC."
          : "Polling every 4 s — the relay typically settles in ~65 s."}
      </p>
    </div>
  );
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "12px 16px",
    background: disabled ? "var(--ink-3)" : "var(--ink)",
    color: "var(--paper)",
    border: 0,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontWeight: 500,
  };
}

function format6(value: bigint): string {
  const integer = value / 1_000_000n;
  const frac = value % 1_000_000n;
  if (frac === 0n) return integer.toString();
  return `${integer.toString()}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}
