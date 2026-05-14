"use client";

import { useState } from "react";

type FlowKey = "A" | "B" | "C";

const FLOWS: Record<FlowKey, { label: string; tagline: string; legend: { k: string; v: string }[]; diagram: string }> = {
  A: {
    label: "A · Deposit",
    tagline: "Two paths converge into a single Miden-native mint.",
    legend: [
      { k: "Entry", v: "EVM wallet via Near Intent + AggLayer · or native Miden wallet." },
      { k: "Proof", v: "STARK generated client-side from the DepositNote — server never sees the position." },
      { k: "Output", v: "Basket token minted as a private note on Miden." },
    ],
    diagram:
`     ┌─────────────────┐                ┌─────────────────┐
     │   ETH USER      │                │   MIDEN USER    │
     │   no Miden a/c  │                │   has a Miden a/c│
     └────────┬────────┘                └────────┬────────┘
              │                                  │
              ▼                                  ▼
     ┌─────────────────┐                ┌─────────────────┐
     │  NEAR INTENT    │                │  DEPOSIT NOTE   │
     │  relay wallet   │                │  STARK proof    │
     └────────┬────────┘                └────────┬────────┘
              │                                  │
              ▼                                  │
     ┌─────────────────┐                         │
     │   AGGLAYER      │                         │
     │   ETH ▸ MIDEN   │                         │
     │   10 – 20 min   │                         │
     └────────┬────────┘                         │
              │                                  │
              └──────────────┬───────────────────┘
                             ▼
               ┌─────────────────────────┐         ┌──────────────┐
               │  TRANSACTION  KERNEL    │ ───────▸│  PRAGMA      │
               │  verifies the proof     │         │  ~200 ms     │
               │  consumes  the  note    │ ◂───────│  price feeds │
               └────────────┬────────────┘         └──────────────┘
                            ▼
               ┌─────────────────────────┐
               │  BASKET TOKEN           │
               │  minted privately       │
               │  on Miden               │
               └─────────────────────────┘`,
  },
  B: {
    label: "B · Rebalance",
    tagline: "Drift detection runs entirely on Miden — no ETH-side execution.",
    legend: [
      { k: "Trigger", v: "Private Account compares current weights to targets, fires when drift exceeds threshold." },
      { k: "Routing", v: "Near Intent dispatches the swap to the in-protocol Miden DEX, with a cross-chain SDK fallback." },
      { k: "Privacy", v: "Positions remain private by default. ETH-side liquidity is also reachable, still private." },
    ],
    diagram:
`     ┌─────────────────────────┐
     │  PRIVATE  ACCOUNT       │
     │  detects drift          │
     │  vs.  target  weights   │
     └────────────┬────────────┘
                  ▼
     ┌─────────────────────────┐
     │  DELTA  COMPUTATION     │
     │  buy / sell amounts     │
     │  per token              │
     └────────────┬────────────┘
                  ▼
     ┌─────────────────────────┐         ┌─────────────────────────┐
     │  NEAR  INTENT           │ ───────▸│  MIDEN  DEX             │
     │  routes the swap        │         │  in-protocol            │
     └─────────────────────────┘         └────────────┬────────────┘
                                                      │   fallback:
                                                      │   x-chain SDK
                                                      ▼
                                         ┌─────────────────────────┐
                                         │  POSITIONS  UPDATED     │
                                         │  private  by  default   │
                                         └─────────────────────────┘`,
  },
  C: {
    label: "C · Redeem",
    tagline: "Burn the basket token, fan out the underlying — privately.",
    legend: [
      { k: "Initiation", v: "User builds a RedeemNote from their private Miden account." },
      { k: "Settlement", v: "Kernel verifies the STARK, Private Account computes the pro-rata share via Pragma." },
      { k: "Payout", v: "Miden users receive on Miden. ETH users receive on EVM via AggLayer + relay wallet." },
    ],
    diagram:
`     ┌─────────────────────────┐
     │  USER                   │
     │  initiates redemption   │
     └────────────┬────────────┘
                  ▼
     ┌─────────────────────────┐
     │  REDEEM  NOTE           │
     │  STARK proof            │
     │  built  client-side     │
     └────────────┬────────────┘
                  ▼
     ┌─────────────────────────┐         ┌─────────────────────────┐
     │  TRANSACTION  KERNEL    │ ───────▸│  PRIVATE  ACCOUNT       │
     │  verifies the proof     │         │  pro-rata share         │
     │  burns the basket token │ ◂───────│  via  Pragma  prices    │
     └────────────┬────────────┘         └─────────────────────────┘
                  │
                  ├──────────▸  MIDEN  USER
                  │             receives assets on Miden  ·  private
                  │
                  └──────────▸  ETH  USER
                                AggLayer  BridgeAsset
                                auto-withdraw  ▸  EVM  wallet`,
  },
};

export function FlowSection() {
  const [active, setActive] = useState<FlowKey>("A");
  const flow = FLOWS[active];

  return (
    <section className="block flow" id="flow">
      <div className="container">
        <div className="block-header">
          <div className="left rise d1">
            <span className="section-tag"><span className="tag-num">[03]</span> Flow</span>
          </div>
          <div className="rise d2">
            <h2 className="headline">How a deposit becomes a basket token.</h2>
            <p className="lead" style={{ marginTop: 16 }}>{flow.tagline}</p>
          </div>
        </div>

        <div className="rise d3">
          <div className="flow-tabs" role="tablist" aria-label="Protocol flows">
            {(Object.keys(FLOWS) as FlowKey[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={active === k}
                className={`flow-tab ${active === k ? "active" : ""}`}
                onClick={() => setActive(k)}
              >
                {FLOWS[k].label}
              </button>
            ))}
          </div>

          <pre className="flow-diagram" aria-label={`Flow ${active} diagram`}>
            {flow.diagram}
          </pre>

          <div className="flow-legend">
            {flow.legend.map((row) => (
              <div className="item" key={row.k}>
                <span className="k">{row.k}</span>
                <span className="v">{row.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
