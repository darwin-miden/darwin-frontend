import type { Metadata } from "next";
import { NavBar } from "../../components/NavBar";
import {
  M1_DELIVERABLES,
  TESTNET_SNAPSHOT_TAKEN_AT,
  type M1Deliverable,
} from "../../lib/testnet-state";

export const metadata: Metadata = {
  title: "M1 status — Darwin",
  description:
    "Live status of Darwin Protocol's Milestone 1 deliverables under the Miden grant.",
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
  const shipped = M1_DELIVERABLES.filter((d) => d.status === "shipped").length;
  const inFlight = M1_DELIVERABLES.filter((d) => d.status === "in-flight")
    .length;
  const blocked = M1_DELIVERABLES.filter(
    (d) => d.status === "blocked-external",
  ).length;

  return (
    <>
      <NavBar active="status" />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <div className="section-tag">
          <span className="tag-num">M1</span>Grant deliverables
        </div>
        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          Where we stand on Milestone 1.
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
          line below points at evidence — testnet account IDs, transaction
          hashes, source files, or external dependencies.
        </p>

        <div
          style={{
            marginTop: 32,
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 0,
            borderTop: "1px solid var(--ink)",
            borderBottom: "1px solid var(--ink)",
          }}
        >
          <Stat n={shipped} label="shipped" color="var(--green)" />
          <Stat n={inFlight} label="in-flight" color="#c5a23e" />
          <Stat n={blocked} label="blocked external" color="#d23f3f" />
        </div>

        <section style={{ marginTop: 56 }}>
          {M1_DELIVERABLES.map((d) => (
            <article
              key={d.id}
              style={{
                padding: "24px 0",
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
                    deliverable {d.id.padStart(2, "0")}
                  </span>
                  <h2
                    style={{
                      margin: "4px 0 0",
                      fontSize: 20,
                      lineHeight: 1.3,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {d.title}
                  </h2>
                </div>
                <StatusPill status={d.status} />
              </header>
              <ul
                style={{
                  marginTop: 14,
                  paddingLeft: 0,
                  listStyle: "none",
                  color: "var(--ink-2)",
                  fontSize: 14.5,
                  lineHeight: 1.55,
                }}
              >
                {d.evidence.map((e, i) => (
                  <li
                    key={i}
                    style={{
                      position: "relative",
                      paddingLeft: 20,
                      marginTop: 6,
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
        </section>

        <section style={{ marginTop: 56 }}>
          <div className="section-tag">
            <span className="tag-num">∞</span>External dependency
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
            Deliverable #4 (AggLayer BridgeAsset) is the only line not
            shipped. The Miden ↔ Ethereum canonical bridge is owned by Miden
            Labs / gateway-fm; Darwin's wrapper (24 Foundry tests, two Rust
            CLIs, miden-agglayer 0.14 wired) sits ready to flip the
            integration test from <code>MockPolygonZkEVMBridge</code> to the
            real address the day the public bridge ships.
          </p>
        </section>
      </main>
    </>
  );
}

function Stat({
  n,
  label,
  color,
}: {
  n: number;
  label: string;
  color: string;
}) {
  return (
    <div
      style={{
        padding: "24px 16px",
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
          marginTop: 6,
          fontSize: 36,
          fontWeight: 500,
          letterSpacing: "-0.02em",
          color,
        }}
      >
        {n}
        <span style={{ color: "var(--ink-3)", fontSize: 18, marginLeft: 6 }}>
          / 6
        </span>
      </div>
    </div>
  );
}
