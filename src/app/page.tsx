import Link from "next/link";
import { NavBar } from "../components/NavBar";
import { LogoMark } from "../components/Logo";

/**
 * Darwin Protocol — landing page.
 *
 * Editorial paper/ink aesthetic from globals.css. Targets two audiences
 * at once: (a) Miden ecosystem grant reviewers who want to verify
 * what's actually on-chain, (b) future users who want to try a deposit.
 *
 * Sections (top to bottom):
 *   1. Hero with primary CTA → /baskets/dcc (deposit), secondary → /status
 *   2. Stat strip — live numbers across M1 + M2
 *   3. "Try it now" — three steps the user can run today on Sepolia
 *   4. "How it works" — the 3 atomic flows (A deposit / B rebalance / C redeem)
 *   5. "What's live" navigation grid (5 pages)
 *   6. Footer with open-source pointers
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
              gridTemplateColumns: "1.5fr 1fr",
              gap: 48,
              alignItems: "center",
            }}
          >
            <div>
              <div
                className="eyebrow"
                style={{ marginBottom: 16, color: "var(--orange)" }}
              >
                M1 + M2 live · Miden testnet + Sepolia
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
                  maxWidth: 580,
                  margin: "0 0 32px",
                }}
              >
                Deposit USDC on Ethereum, hold a STARK-proven basket position
                privately on Miden. The relay does the bridging in 65 seconds.
                No Miden account, no Falcon-512 key, no proof-generation
                friction.
              </p>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <Link
                  href="/baskets/dcc"
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
                  Try a deposit on Sepolia{" "}
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
                  Grant status
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

        {/* stat strip — updated for M1 + M2 */}
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
              gridTemplateColumns: "repeat(5, 1fr)",
              padding: 0,
            }}
          >
            <Stat n="19" label="Miden accounts live" />
            <Stat n="6" label="Sepolia contracts" />
            <Stat n="3" label="atomic flows on-chain" />
            <Stat n="290" label="green tests" />
            <Stat n="65s" label="ETH → basket" />
          </div>
        </section>

        {/* Try it now */}
        <section className="container" style={{ padding: "80px 0 40px" }}>
          <div className="section-tag">
            <span className="tag-num">01</span>Try it now
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
            Three steps, one Sepolia wallet, no Miden onboarding.
          </h2>
          <p
            style={{
              color: "var(--ink-2)",
              maxWidth: 680,
              fontSize: 16,
              lineHeight: 1.55,
            }}
          >
            The flow you&apos;d run as an ETH-native user, browsable end-to-end
            from this site. No backend in the path you don&apos;t already trust
            (your wallet + Sepolia RPC + the Darwin escrow contract).
          </p>
          <div
            style={{
              marginTop: 32,
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 0,
              borderTop: "1px solid var(--ink)",
            }}
          >
            <Step
              num="1"
              title="Connect your wallet"
              body="Tap Connect wallet in the nav, sign with MetaMask / WalletConnect / Coinbase. We target Sepolia exclusively for the demo."
            />
            <Step
              num="2"
              title="Pick a basket"
              body="DCC / DAG / DCO each show their target weights, live drift, on-chain contracts, and a deposit panel that talks to the Sepolia relay."
            />
            <Step
              num="3"
              title="Deposit USDC"
              body="Self-mint MockUSDC if needed, approve, deposit. The relay catches your event, claims, mints DCC ERC20 to your wallet. ~65 s."
              last
            />
          </div>
        </section>

        {/* How it works — 3 flows */}
        <section className="container" style={{ padding: "40px 0 80px" }}>
          <div className="section-tag">
            <span className="tag-num">02</span>How it works
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
            Three atomic flows, all live on Miden testnet.
          </h2>
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
            <FlowCard
              tag="Flow A"
              title="Atomic deposit"
              body="Note carries the asset + math + drain-into-controller loop. Consumed in one tx by the v2 controller's receive_asset proc."
              proofTx="0x2e211adf · block 703322"
              link="/flows"
            />
            <FlowCard
              tag="Flow B"
              title="Rebalance trigger"
              body="Zero-asset note calls execute_rebalance_step on the v4 controller. Off-chain rebalance_bot reads live Pragma + decides when to fire."
              proofTx="0xaf8521f2 · block 782152"
              link="/flows"
            />
            <FlowCard
              tag="Flow C"
              title="Atomic redeem"
              body="Symmetric of Flow A. User attaches DCC, the redeem note runs felt_div on-chain and drains the basket tokens into the controller."
              proofTx="0x005c4eec · block 777149"
              link="/flows"
              last
            />
          </div>
        </section>

        {/* What's live — navigation */}
        <section
          className="container"
          style={{
            padding: "40px 0 80px",
          }}
        >
          <div className="section-tag">
            <span className="tag-num">03</span>What&apos;s live to browse
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
            Five pages, every claim cross-referenced to an on-chain artefact.
          </h2>
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
              body="DCC, DAG, DCO — target weights, live drift planner with skew slider, links to per-basket detail pages with deposit panels."
            />
            <PokeCard
              num="02"
              href="/portfolio"
              title="Your portfolio"
              body="Live ERC20 balances of your wDCC/wDAG/wDCO on Sepolia. Polls every 8 s. Total USD value at the top."
            />
            <PokeCard
              num="03"
              href="/accounts"
              title="Deployed accounts"
              body="19 Miden testnet accounts + 6 Sepolia contracts, each grouped by role and linked to the explorer."
            />
            <PokeCard
              num="04"
              href="/flows"
              title="Flow A · B · C runs"
              body="Real testnet tx hashes proving the three atomic flows ran end-to-end inside the controller's tx context."
            />
            <PokeCard
              num="05"
              href="/status"
              title="M1 + M2 deliverables"
              body="Both milestones with status pills and evidence lists. The honest scoreboard, including external blockers (AggLayer, Near Intents Miden)."
              spansBoth
            />
          </div>
        </section>

        {/* footer */}
        <section
          style={{
            borderTop: "1px solid var(--ink)",
            padding: "48px 0",
            background: "var(--paper-2)",
          }}
        >
          <div
            className="container"
            style={{
              display: "grid",
              gridTemplateColumns: "1.5fr 1fr 1fr",
              gap: 48,
            }}
          >
            <div>
              <h3 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>
                Open source from day one
              </h3>
              <p
                style={{
                  color: "var(--ink-2)",
                  fontSize: 14,
                  lineHeight: 1.55,
                  marginTop: 8,
                }}
              >
                Every contract, every controller, every Rust crate is in the{" "}
                <a
                  href="https://github.com/darwin-miden"
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderBottom: "1px dotted var(--rule)" }}
                >
                  darwin-miden
                </a>{" "}
                org. Tag <code>v0.2.0-m2</code> across all repos pins the
                shipped state.
              </p>
            </div>
            <div>
              <h4
                style={{
                  margin: 0,
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                }}
              >
                Miden testnet
              </h4>
              <ul style={{ paddingLeft: 0, listStyle: "none", marginTop: 10 }}>
                <FootLink
                  href="https://testnet.midenscan.com"
                  label="testnet.midenscan.com"
                />
                <FootLink href="https://miden.xyz" label="miden.xyz" />
                <FootLink
                  href="https://docs.miden.xyz"
                  label="docs.miden.xyz"
                />
              </ul>
            </div>
            <div>
              <h4
                style={{
                  margin: 0,
                  fontFamily: "var(--font-mono-stack)",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  color: "var(--ink-3)",
                  textTransform: "uppercase",
                }}
              >
                Sepolia
              </h4>
              <ul style={{ paddingLeft: 0, listStyle: "none", marginTop: 10 }}>
                <FootLink
                  href="https://sepolia.etherscan.io/address/0x7e5279AD0d9F7fB8884562C336Fa6d78DCbf7c93"
                  label="DarwinRelayDeposit"
                />
                <FootLink
                  href="https://sepolia.etherscan.io/address/0x1EB7Bd808402824232853e66DF6843D68462B7A4"
                  label="DCC token"
                />
                <FootLink
                  href="https://sepolia.etherscan.io/address/0x6dAb940a4E1d434965E22e9F6d624fF68F6922a0"
                  label="MockUSDC (faucet)"
                />
              </ul>
            </div>
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
          fontSize: "clamp(1.6rem, 3vw, 2.6rem)",
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

function Step({
  num,
  title,
  body,
  last,
}: {
  num: string;
  title: string;
  body: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "28px 24px",
        borderRight: last ? "0" : "1px solid var(--rule)",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.12em",
          color: "var(--orange)",
        }}
      >
        step {num.padStart(2, "0")}
      </div>
      <h3
        style={{
          margin: "8px 0",
          fontSize: 20,
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
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        {body}
      </p>
    </div>
  );
}

function FlowCard({
  tag,
  title,
  body,
  proofTx,
  link,
  last,
}: {
  tag: string;
  title: string;
  body: string;
  proofTx: string;
  link: string;
  last?: boolean;
}) {
  return (
    <Link
      href={link}
      style={{
        display: "block",
        padding: "28px 24px",
        borderRight: last ? "0" : "1px solid var(--rule)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11,
          letterSpacing: "0.12em",
          color: "var(--orange)",
        }}
      >
        {tag}
      </div>
      <h3
        style={{
          margin: "8px 0",
          fontSize: 20,
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
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        {body}
      </p>
      <div
        style={{
          marginTop: 12,
          fontFamily: "var(--font-mono-stack)",
          fontSize: 11.5,
          color: "var(--ink-3)",
        }}
      >
        proof · {proofTx}
      </div>
    </Link>
  );
}

function PokeCard({
  num,
  href,
  title,
  body,
  spansBoth,
}: {
  num: string;
  href: string;
  title: string;
  body: string;
  spansBoth?: boolean;
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
        gridColumn: spansBoth ? "1 / -1" : undefined,
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
          maxWidth: 540,
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

function FootLink({ href, label }: { href: string; label: string }) {
  return (
    <li style={{ marginTop: 6, fontSize: 14 }}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ borderBottom: "1px dotted var(--rule)" }}
      >
        {label}
      </a>
    </li>
  );
}
