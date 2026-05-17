import Link from "next/link";
import { NavBar } from "../components/NavBar";
import { LogoMark } from "../components/Logo";

/**
 * Darwin Protocol — index. Editorial paper/ink aesthetic from
 * globals.css. Surfaces the four real app pages (Baskets, Accounts,
 * Flows, Status) so the grant reviewer lands and immediately knows
 * what's testable.
 */
export default function Page() {
  return (
    <>
      <NavBar active="home" />
      <main>
        {/* hero */}
        <section className="container" style={{ padding: "96px 0 64px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr",
              gap: 48,
              alignItems: "center",
            }}
          >
            <div>
              <div
                className="eyebrow"
                style={{ marginBottom: 16, color: "var(--orange)" }}
              >
                Milestone 1 · Live on Miden testnet
              </div>
              <h1
                style={{
                  fontSize: "clamp(2.6rem, 6vw, 4.6rem)",
                  letterSpacing: "-0.025em",
                  lineHeight: 1,
                  margin: "0 0 24px",
                  fontWeight: 500,
                }}
              >
                Confidential baskets,{" "}
                <em
                  style={{
                    fontStyle: "italic",
                    color: "var(--orange)",
                    fontFamily: "var(--font-mono-stack)",
                    letterSpacing: "-0.04em",
                  }}
                >
                  native to Miden.
                </em>
              </h1>
              <p
                style={{
                  fontSize: 18,
                  lineHeight: 1.55,
                  color: "var(--ink-2)",
                  maxWidth: 560,
                  margin: "0 0 32px",
                }}
              >
                Client-side STARK-proven basket protocol. Pragma price feeds,
                AggLayer access from any EVM wallet. The portfolio is yours —
                and only yours.
              </p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <Link
                  href="/baskets"
                  className="btn btn-primary"
                  style={{
                    padding: "14px 22px",
                    border: "1px solid var(--ink)",
                    fontFamily: "var(--font-sans-stack)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  Open the basket dashboard{" "}
                  <span className="arrow">→</span>
                </Link>
                <Link
                  href="/status"
                  className="btn btn-ghost"
                  style={{
                    padding: "14px 22px",
                    border: "1px solid var(--ink)",
                    fontFamily: "var(--font-sans-stack)",
                  }}
                >
                  See M1 status
                </Link>
              </div>
            </div>
            <div
              style={{
                color: "var(--ink)",
                opacity: 0.92,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <LogoMark style={{ height: 280, width: "auto" }} />
            </div>
          </div>
        </section>

        {/* stat strip */}
        <section
          style={{
            borderTop: "1px solid var(--ink)",
            borderBottom: "1px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <div
            className="container"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              padding: 0,
            }}
          >
            <Stat n="17" label="testnet accounts" />
            <Stat n="6" label="M1 deliverables" />
            <Stat n="165+" label="green tests" />
            <Stat n="2" label="atomic flows live" />
          </div>
        </section>

        {/* what you can poke */}
        <section className="container" style={{ padding: "80px 0" }}>
          <div className="section-tag">
            <span className="tag-num">04</span>What you can poke today
          </div>
          <h2
            style={{
              fontSize: "clamp(1.6rem, 3vw, 2.4rem)",
              letterSpacing: "-0.015em",
              margin: "20px 0 8px",
              maxWidth: 780,
              lineHeight: 1.1,
              fontWeight: 500,
            }}
          >
            Four pages, four ways to verify Milestone 1 is real.
          </h2>
          <p style={{ color: "var(--ink-2)", maxWidth: 680, fontSize: 16 }}>
            Everything below pulls from a static snapshot of the testnet
            registry that ships with the repo — no servers, no APIs, just
            hashes you can paste into{" "}
            <a
              href="https://testnet.midenscan.com"
              target="_blank"
              rel="noreferrer"
              style={{ borderBottom: "1px dotted var(--rule)" }}
            >
              testnet.midenscan.com
            </a>
            .
          </p>
          <div
            style={{
              marginTop: 32,
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 0,
              borderTop: "1px solid var(--ink)",
            }}
          >
            <PokeCard
              num="01"
              href="/baskets"
              title="Basket browser"
              body="DCC, DAG, DCO — target weights, live drift planner with skew slider, links to per-basket detail pages."
            />
            <PokeCard
              num="02"
              href="/accounts"
              title="Deployed accounts"
              body="All 17 testnet account IDs (faucets, controllers, oracle, wallets) grouped by role, each linked to the explorer."
            />
            <PokeCard
              num="03"
              href="/flows"
              title="Flow A · Flow C runs"
              body="Real testnet transaction IDs proving the atomic deposit and atomic redeem flows ran end-to-end inside the controller's tx context."
            />
            <PokeCard
              num="04"
              href="/status"
              title="M1 deliverables"
              body="Six grant deliverables × status pill × evidence list. The honest scoreboard, including what's blocked on the public AggLayer bridge."
            />
          </div>
        </section>
      </main>
    </>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div
      style={{
        padding: "32px 24px",
        borderRight: "1px solid var(--rule)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: "clamp(2rem, 3.6vw, 3rem)",
          fontWeight: 500,
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        {n}
      </div>
    </div>
  );
}

function PokeCard({
  num,
  href,
  title,
  body,
}: {
  num: string;
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "block",
        padding: "32px 28px",
        borderRight: "1px solid var(--rule)",
        borderBottom: "1px solid var(--rule)",
        textDecoration: "none",
        color: "inherit",
        position: "relative",
        transition: "background 120ms ease",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.12em",
          color: "var(--orange)",
        }}
      >
        {num}
      </span>
      <h3
        style={{
          margin: "10px 0 8px",
          fontSize: 22,
          fontWeight: 500,
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: 0,
          color: "var(--ink-2)",
          fontSize: 14.5,
          lineHeight: 1.55,
          maxWidth: 460,
        }}
      >
        {body}
      </p>
      <span
        style={{
          marginTop: 14,
          display: "inline-flex",
          fontFamily: "var(--font-mono-stack)",
          fontSize: 12,
          color: "var(--ink-3)",
        }}
      >
        open →
      </span>
    </Link>
  );
}
