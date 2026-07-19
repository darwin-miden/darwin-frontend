import type { Metadata } from "next";
import { NavBar } from "../../components/NavBar";
import {
  FLOW_A_EVENTS,
  FLOW_C_EVENTS,
  MIDENSCAN_BASE,
  POOL_FUNDING,
  type FlowEvent,
} from "../../lib/testnet-state";

export const metadata: Metadata = {
  title: "Flows",
  description:
    "Real Miden testnet transaction IDs for Darwin's atomic deposit (Flow A) and atomic redeem (Flow C) flows.",
};

function txUrl(id: string) {
  return `${MIDENSCAN_BASE}/tx/${id}`;
}

function noteUrl(id: string) {
  return `${MIDENSCAN_BASE}/note/${id}`;
}

function blockUrl(n: number) {
  return `${MIDENSCAN_BASE}/block/${n}`;
}

function EventCard({ ev, n }: { ev: FlowEvent; n: number }) {
  return (
    <article
      style={{
        borderLeft: "3px solid var(--orange)",
        background: "var(--paper-2)",
        padding: "20px 24px",
        marginBottom: 14,
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
              color: "var(--ink-3)",
              textTransform: "uppercase",
            }}
          >
            step {n.toString().padStart(2, "0")}
          </span>
          <h3 style={{ margin: "4px 0 0", fontSize: 17, lineHeight: 1.3 }}>
            {ev.label}
          </h3>
        </div>
        <a
          href={blockUrl(ev.block)}
          target="_blank"
          rel="noreferrer"
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 12,
            color: "var(--ink-2)",
            borderBottom: "1px dotted var(--rule)",
          }}
        >
          block #{ev.block.toLocaleString()}
        </a>
      </header>
      <p
        style={{
          margin: "12px 0 0",
          color: "var(--ink-2)",
          fontSize: 14.5,
          lineHeight: 1.55,
        }}
      >
        {ev.detail}
      </p>
      <dl
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 6,
          columnGap: 14,
          fontSize: 12.5,
        }}
      >
        <dt
          style={{
            fontFamily: "var(--font-mono-stack)",
            color: "var(--ink-3)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          tx
        </dt>
        <dd style={{ margin: 0 }}>
          <a
            href={txUrl(ev.txId)}
            target="_blank"
            rel="noreferrer"
            style={{
              fontFamily: "var(--font-mono-stack)",
              color: "var(--ink)",
              borderBottom: "1px dotted var(--rule)",
              wordBreak: "break-all",
            }}
          >
            {ev.txId}
          </a>
        </dd>
        {ev.note && (
          <>
            <dt
              style={{
                fontFamily: "var(--font-mono-stack)",
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              note
            </dt>
            <dd style={{ margin: 0 }}>
              <a
                href={noteUrl(ev.note)}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontFamily: "var(--font-mono-stack)",
                  color: "var(--ink)",
                  borderBottom: "1px dotted var(--rule)",
                  wordBreak: "break-all",
                }}
              >
                {ev.note}
              </a>
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}

export default function FlowsPage() {
  return (
    <>
      {/* /flows is preserved as a deep-link target but the top-nav now
          points at /faucet — leave `active` unset so no item highlights. */}
      <NavBar />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <div className="section-tag">
          <span className="tag-num">03</span>Flows on testnet
        </div>
        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          The Miden-native flows actually ran. Click any tx.
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
          Two atomic flows are live end-to-end on testnet — the on-chain
          note-execution primitive. The note script — including the{" "}
          <code>darwin::math::felt_div</code> call — executes inside the
          controller's transaction context, then drains the asset into the
          controller vault.
        </p>

        <section style={{ marginTop: 56 }}>
          <h2
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink)",
              borderBottom: "1px solid var(--ink)",
              paddingBottom: 8,
              marginBottom: 20,
            }}
          >
            Flow A · Atomic deposit · 100 dETH → v2 controller
          </h2>
          {FLOW_A_EVENTS.map((ev, i) => (
            <EventCard key={ev.txId} ev={ev} n={i + 1} />
          ))}
        </section>

        <section style={{ marginTop: 56 }}>
          <h2
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink)",
              borderBottom: "1px solid var(--ink)",
              paddingBottom: 8,
              marginBottom: 20,
            }}
          >
            Flow C · Atomic redeem · 50 DCC → v2 controller
          </h2>
          {FLOW_C_EVENTS.map((ev, i) => (
            <EventCard key={ev.txId} ev={ev} n={i + 1} />
          ))}
        </section>

        <section style={{ marginTop: 56 }}>
          <h2
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink)",
              borderBottom: "1px solid var(--ink)",
              paddingBottom: 8,
              marginBottom: 20,
            }}
          >
            Pool funding · primary mints into the v2 controller
          </h2>
          <p
            style={{
              fontSize: 14,
              color: "var(--ink-2)",
              lineHeight: 1.55,
              marginBottom: 16,
            }}
          >
            Pre-Flow-A bootstrap. Each row is a real on-chain faucet mint
            seeding the controller's vault so it can later compute NAV
            against live positions.
          </p>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13.5,
            }}
          >
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
                <th style={{ textAlign: "left", padding: "10px 12px" }}>
                  Basket
                </th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>
                  Asset
                </th>
                <th style={{ textAlign: "right", padding: "10px 12px" }}>
                  Amount
                </th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>
                  Mint tx
                </th>
              </tr>
            </thead>
            <tbody>
              {POOL_FUNDING.map((p) => (
                <tr
                  key={p.mintTx}
                  style={{ borderBottom: "1px solid var(--rule-2)" }}
                >
                  <td style={{ padding: "10px 12px" }}>
                    <strong>{p.basket}</strong>
                  </td>
                  <td style={{ padding: "10px 12px" }}>{p.asset}</td>
                  <td
                    style={{
                      padding: "10px 12px",
                      textAlign: "right",
                      fontFamily: "var(--font-mono-stack)",
                    }}
                  >
                    {p.amount.toLocaleString()}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    <a
                      href={txUrl(p.mintTx)}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontFamily: "var(--font-mono-stack)",
                        fontSize: 12,
                        borderBottom: "1px dotted var(--rule)",
                      }}
                    >
                      {p.mintTx.slice(0, 18)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
