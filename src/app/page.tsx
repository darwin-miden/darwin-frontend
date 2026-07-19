import Link from "next/link";
import { NavBar } from "../components/NavBar";
import { LogoMark } from "../components/Logo";

/**
 * Darwin Protocol — landing page.
 *
 * Editorial paper/ink aesthetic from globals.css. Targets users arriving
 * from socials who want to try a confidential deposit on testnet. Copy is
 * kept honest to the live rail: keys stay in the browser, the Miden network
 * executes the deposit, and the basket position is minted into a private note.
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
                Live on Miden testnet · Sepolia bridge
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
                  native to zk.
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
                Hold a STARK-proven basket position privately on Miden. One
                signature derives a wallet in your browser — your key never
                leaves it. Epoch bridges your Sepolia USDC, the network itself
                executes your deposit, and your basket tokens are minted into a
                private note only you can open.
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
                  Try a deposit <span className="arrow">→</span>
                </Link>
                <Link
                  href="/portfolio"
                  className="btn btn-ghost"
                  style={{
                    padding: "14px 22px",
                    border: "1px solid var(--ink)",
                    fontFamily: "var(--font-sans-stack)",
                  }}
                >
                  Your portfolio
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

        {/* fact strip — honest, product-level (no infra vanity) */}
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
            <Stat n="3" label="confidential baskets" />
            <Stat n="Private" label="positions on Miden" />
            <Stat n="Self-custody" label="no operator wallet" />
            <Stat n="~40s" label="USDC → basket" last />
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
            Two paths to the same private position.
          </h2>
          <p
            style={{
              color: "var(--ink-2)",
              maxWidth: 720,
              fontSize: 16,
              lineHeight: 1.55,
            }}
          >
            Pick the rail that matches your wallet. Both mint the same
            confidential basket position on Miden testnet.
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
              title="Connect a wallet"
              body="ETH wallet (MetaMask / WalletConnect / Coinbase) via Connect ETH, or a native Miden wallet (browser extension, Para, Turnkey) via Connect. Both buttons are in the nav."
            />
            <Step
              num="2"
              title="Pick a basket"
              body="DCC, DAG and DCO each show their target weights, live NAV, the on-chain faucet, and a deposit panel."
            />
            <Step
              num="3"
              title="Deposit"
              body="Self-custody: one signature derives your wallet, Epoch bridges your Sepolia USDC, and the Miden network executes the deposit — minting basket tokens into a private note. Native Miden wallet: sign a deposit note directly and your browser proves the STARK in under a second."
              last
            />
          </div>
        </section>

        {/* How it works — the confidential flows */}
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
            Two confidential flows, live on testnet.
          </h2>
          <p
            style={{
              color: "var(--ink-2)",
              maxWidth: 720,
              fontSize: 16,
              lineHeight: 1.55,
            }}
          >
            Each basket is a network account on Miden. Notes are consumed and
            executed by the network itself — never a custodian.
          </p>
          <div
            style={{
              marginTop: 32,
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 0,
              borderTop: "1px solid var(--ink)",
              borderBottom: "1px solid var(--ink)",
            }}
          >
            <FlowCard
              tag="Deposit"
              title="Collateral in, private tokens out"
              body="Your dUSDC funds a deposit note the network consumes. It drains the collateral into the basket faucet and mints basket tokens — bound 1:1 to the real collateral — into a private note only you can open."
              foot="network-executed · Miden testnet"
              link="/flows"
            />
            <FlowCard
              tag="Redeem"
              title="Burn tokens, get assets back"
              body="Burn your basket tokens back to the faucet; the network releases the underlying dUSDC into a private note, bridged back to your Sepolia wallet via Epoch."
              foot="network-executed · Miden testnet"
              link="/flows"
              last
            />
          </div>
        </section>

        {/* What's live — navigation */}
        <section className="container" style={{ padding: "40px 0 80px" }}>
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
            Browse the live testnet deployment.
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
              body="DCC, DAG and DCO — target weights, live NAV, and a deposit panel on each per-basket page."
            />
            <PokeCard
              num="02"
              href="/portfolio"
              title="Your portfolio"
              body="Your confidential DCC / DAG / DCO positions, read live from your private Miden vault in the browser."
            />
            <PokeCard
              num="03"
              href="/flows"
              title="Deposit & redeem runs"
              body="Real testnet transactions showing the confidential deposit and redeem flows executed end to end by the network."
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
              gridTemplateColumns: "1.5fr 1fr",
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
                Every note script, every controller, every Rust crate is{" "}
                <a
                  href="https://github.com/darwin-miden"
                  target="_blank"
                  rel="noreferrer"
                  style={{ borderBottom: "1px dotted var(--rule)" }}
                >
                  open source
                </a>
                . MIT licensed.
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
                Where it runs
              </h4>
              <ul style={{ paddingLeft: 0, listStyle: "none", marginTop: 10 }}>
                <li style={{ marginTop: 6, fontSize: 14, color: "var(--ink-2)" }}>
                  Miden testnet — 3 confidential basket faucets
                </li>
                <li style={{ marginTop: 6, fontSize: 14 }}>
                  <a
                    href="https://sepolia.etherscan.io/address/0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69"
                    target="_blank"
                    rel="noreferrer"
                    style={{ borderBottom: "1px dotted var(--rule)" }}
                  >
                    Sepolia — USDC bridged via Epoch
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

function Stat({
  n,
  label,
  last,
}: {
  n: string;
  label: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "32px 24px",
        borderRight: last ? "0" : "1px solid var(--rule)",
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
          fontSize: "clamp(1.4rem, 2.4vw, 2.2rem)",
          fontWeight: 500,
          letterSpacing: "-0.02em",
          lineHeight: 1.05,
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
  foot,
  link,
  last,
}: {
  tag: string;
  title: string;
  body: string;
  foot?: string;
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
      {foot ? (
        <div
          style={{
            marginTop: 12,
            fontFamily: "var(--font-mono-stack)",
            fontSize: 11.5,
            color: "var(--ink-3)",
          }}
        >
          {foot}
        </div>
      ) : null}
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
