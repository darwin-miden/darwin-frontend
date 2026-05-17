import type { Metadata } from "next";
import { NavBar } from "../../components/NavBar";
import {
  M1_DELIVERABLES,
  M2_DELIVERABLES,
  TESTNET_SNAPSHOT_TAKEN_AT,
  type M1Deliverable,
} from "../../lib/testnet-state";

export const metadata: Metadata = {
  title: "M1 + M2 status — Darwin",
  description:
    "Live status of Darwin Protocol's Milestone 1 + Milestone 2 deliverables under the Miden grant.",
};

const STATUS_STYLE: Record<
  M1Deliverable["status"],
  { label: string; color: string; bg: string }
> = {
  shipped: {
    label: "shipped",
    color: "#1f6b3a",
    bg: "color-mix(in srgb, var(--green) 18%, var(--paper))",
  },
  "in-flight": {
    label: "in-flight",
    color: "#7a5400",
    bg: "color-mix(in srgb, #f0c060 30%, var(--paper))",
  },
  "blocked-external": {
    label: "blocked-external",
    color: "#7a3a3a",
    bg: "color-mix(in srgb, #d99494 35%, var(--paper))",
  },
};

function StatusPill({ status }: { status: M1Deliverable["status"] }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      style={{
        fontFamily: "var(--font-mono-stack)",
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "3px 10px",
        borderRadius: 2,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.color}`,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

export default function StatusPage() {
  return (
    <>
      <NavBar active="status" />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <div className="section-tag">
          <span className="tag-num">M1+M2</span>Grant deliverables
        </div>
        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          Where we stand on the Darwin × Miden grant.
        </h1>
        <p
          style={{
            color: "var(--ink-2)",
            maxWidth: 720,
            fontSize: 16,
            lineHeight: 1.55,
            margin: "8px 0 0",
          }}
        >
          Snapshot taken <strong>{TESTNET_SNAPSHOT_TAKEN_AT}</strong>. Every
          line below points at evidence — testnet account IDs, Sepolia
          contract addresses, transaction hashes, source files, or external
          dependencies.
        </p>

        <MilestoneSection
          tag="M1"
          intro="Miden Core Layer: Private Execution, Basket Token Logic & Oracle Integration."
          deliverables={M1_DELIVERABLES}
        />

        <MilestoneSection
          tag="M2"
          intro="Relay Wallet, Rebalancing Engine & Full-Flow Completion (A + B + C)."
          deliverables={M2_DELIVERABLES}
        />

        <section style={{ marginTop: 56 }}>
          <div className="section-tag">
            <span className="tag-num">∞</span>External dependencies
          </div>
          <p
            style={{
              marginTop: 16,
              color: "var(--ink-2)",
              fontSize: 14.5,
              lineHeight: 1.6,
              maxWidth: 720,
            }}
          >
            Two grant items are gated on external infrastructure that Darwin
            doesn&apos;t control:
          </p>
          <ul
            style={{
              marginTop: 8,
              paddingLeft: 20,
              color: "var(--ink-2)",
              fontSize: 14.5,
              lineHeight: 1.6,
              maxWidth: 720,
            }}
          >
            <li>
              <strong>M1 #4 / M2 #3 ETH-side roundtrip</strong> — Miden ↔ Ethereum
              canonical bridge (AggLayer) is owned by Miden Labs /
              gateway-fm. Darwin&apos;s wrapper (24 Foundry tests, two Rust
              CLIs, miden-agglayer 0.14 wired) is ready to flip from{" "}
              <code>MockPolygonZkEVMBridge</code> to the real address the day
              the public bridge ships.
            </li>
            <li>
              <strong>M2 #1 Near Intents Miden destination</strong> — Near
              Intents doesn&apos;t list Miden as a destination chain today.
              Darwin built <code>darwin-relay</code> as a stand-in (live on
              Sepolia) so the M2 flow ships now; it will hand off to the
              canonical Near Intent path the day it&apos;s available.
            </li>
          </ul>
        </section>
      </main>
    </>
  );
}

function MilestoneSection({
  tag,
  intro,
  deliverables,
}: {
  tag: string;
  intro: string;
  deliverables: M1Deliverable[];
}) {
  const shipped = deliverables.filter((d) => d.status === "shipped").length;
  const inFlight = deliverables.filter((d) => d.status === "in-flight").length;
  const blocked = deliverables.filter((d) => d.status === "blocked-external").length;

  return (
    <section style={{ marginTop: 48 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 16,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 26,
            letterSpacing: "-0.015em",
          }}
        >
          <span style={{ color: "var(--orange)" }}>{tag}</span> · {intro}
        </h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 0,
          borderTop: "1px solid var(--ink)",
          borderBottom: "1px solid var(--ink)",
        }}
      >
        <Stat n={shipped} total={deliverables.length} label="shipped" color="var(--green)" />
        <Stat n={inFlight} total={deliverables.length} label="in-flight" color="#c5a23e" />
        <Stat n={blocked} total={deliverables.length} label="blocked external" color="#d23f3f" />
      </div>

      <div style={{ marginTop: 24 }}>
        {deliverables.map((d) => (
          <article
            key={`${tag}-${d.id}`}
            style={{
              padding: "20px 0",
              borderBottom: "1px solid var(--rule)",
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div>
                <span
                  style={{
                    fontFamily: "var(--font-mono-stack)",
                    fontSize: 11,
                    letterSpacing: "0.12em",
                    color: "var(--orange)",
                    textTransform: "uppercase",
                  }}
                >
                  {tag} deliverable {d.id.padStart(2, "0")}
                </span>
                <h3
                  style={{
                    margin: "4px 0 0",
                    fontSize: 18,
                    lineHeight: 1.3,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {d.title}
                </h3>
              </div>
              <StatusPill status={d.status} />
            </header>
            <ul
              style={{
                marginTop: 12,
                paddingLeft: 0,
                listStyle: "none",
                color: "var(--ink-2)",
                fontSize: 14,
                lineHeight: 1.55,
              }}
            >
              {d.evidence.map((e, i) => (
                <li
                  key={i}
                  style={{
                    position: "relative",
                    paddingLeft: 18,
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      color: "var(--orange)",
                      fontFamily: "var(--font-mono-stack)",
                    }}
                  >
                    ▸
                  </span>
                  {e}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function Stat({
  n,
  total,
  label,
  color,
}: {
  n: number;
  total: number;
  label: string;
  color: string;
}) {
  return (
    <div
      style={{
        padding: "20px 16px",
        borderRight: "1px solid var(--rule)",
        textAlign: "left",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 30,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          color,
        }}
      >
        {n}
        <span style={{ color: "var(--ink-3)", fontSize: 16, marginLeft: 6 }}>
          / {total}
        </span>
      </div>
    </div>
  );
}
