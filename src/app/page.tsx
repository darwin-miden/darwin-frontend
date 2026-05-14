import { LogoFull, LogoMark } from "@/components/Logo";
import { BASKETS, formatWeight } from "@/lib/baskets";

const PILLARS = [
  {
    num: "01",
    title: "Native to Miden.",
    body:
      "All basket operations — deposit, mint, rebalance, redeem — execute as STARK-proven Miden transactions. No bridges in the hot path.",
    glyph:
`┌─────────┐
│ ACCOUNT │
│  (priv) │
└────┬────┘
     ▼
  KERNEL`,
  },
  {
    num: "02",
    title: "Client-side proofs.",
    body:
      "DepositNote and RedeemNote are proven on the user's machine. The protocol never sees positions, weights, or NAV in the clear.",
    glyph:
`STARK ▸ ───
        ───
   verify ✓`,
  },
  {
    num: "03",
    title: "Open to ETH, too.",
    body:
      "EVM users come in through Near Intent and a relay wallet, with AggLayer BridgeAsset handling the round-trip in 10–20 minutes.",
    glyph:
`ETH ━━▸ MIDEN
       └─▸ NOTE
       └─▸ MINT`,
  },
];

export default function Page() {
  return (
    <>
      {/* ======================================================== nav */}
      <nav className="nav">
        <div className="container nav-inner">
          <a href="#" className="nav-logo" aria-label="Darwin Protocol">
            <LogoFull style={{ height: 22 }} />
          </a>
          <div className="nav-links">
            <a href="#protocol">Protocol</a>
            <a href="#baskets">Baskets</a>
            <a href="#flow">Flow</a>
            <a href="#roadmap">Roadmap</a>
            <a
              className="nav-cta"
              href="https://github.com/darwin-miden"
              target="_blank"
              rel="noreferrer"
            >
              GitHub ↗
            </a>
          </div>
        </div>
      </nav>

      {/* ======================================================== hero */}
      <header className="hero">
        <div className="container" style={{ position: "relative" }}>
          <div className="hero-eyebrow rise d1">
            <span className="dot" />
            <span className="eyebrow">Darwin Protocol · M3 · Q3 2026</span>
          </div>

          <h1 className="rise d2">
            Confidential<br />
            baskets, <em>native</em><br />
            to Miden.
          </h1>

          <div className="hero-sub">
            <p className="rise d3">
              Client-side STARK proofs. Pragma price feeds. AggLayer access from any
              EVM wallet. The portfolio is yours — and only yours.
            </p>
            <div className="hero-cta rise d4">
              <a className="btn btn-primary" href="#baskets">
                Browse baskets <span className="arrow">→</span>
              </a>
              <a
                className="btn btn-ghost"
                href="https://github.com/darwin-miden/darwin-docs"
                target="_blank"
                rel="noreferrer"
              >
                Read the spec
              </a>
            </div>
          </div>

          <LogoMark className="hero-mark" />
        </div>
      </header>

      {/* ======================================================== stats band */}
      <section className="stats" aria-label="Network stats">
        <div className="container">
          <div className="stats-row">
            <div className="stat">
              <span className="stat-label">Curated baskets</span>
              <span className="stat-value">03<span className="unit">live</span></span>
            </div>
            <div className="stat">
              <span className="stat-label">Settlement</span>
              <span className="stat-value">~200<span className="unit">ms</span></span>
            </div>
            <div className="stat">
              <span className="stat-label">Proof generation</span>
              <span className="stat-value">&lt;10<span className="unit">s</span></span>
            </div>
            <div className="stat">
              <span className="stat-label">Bridge round-trip</span>
              <span className="stat-value">10–20<span className="unit">min</span></span>
            </div>
          </div>
        </div>
      </section>

      {/* ======================================================== [01] What */}
      <section className="block" id="protocol">
        <div className="container">
          <div className="block-header">
            <div className="left rise d1">
              <span className="section-tag"><span className="tag-num">[01]</span> What</span>
            </div>
            <div className="rise d2">
              <h2 className="headline">Three things Darwin gets right.</h2>
              <p className="lead" style={{ marginTop: 16 }}>
                A confidential basket protocol that doesn't compromise on transparency
                where it matters: open-source, audited, verifiable on-chain.
              </p>
            </div>
          </div>

          <div className="pillars">
            {PILLARS.map((p, i) => (
              <article key={p.num} className={`pillar rise d${i + 2}`}>
                <span className="pillar-num">[{p.num}]</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
                <div className="pillar-glyph">{p.glyph}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ======================================================== [02] Baskets */}
      <section className="block" id="baskets">
        <div className="container">
          <div className="block-header">
            <div className="left rise d1">
              <span className="section-tag"><span className="tag-num">[02]</span> Baskets</span>
            </div>
            <div className="rise d2">
              <h2 className="headline">Three curated strategies. Mainnet day one.</h2>
              <p className="lead" style={{ marginTop: 16 }}>
                Hand-picked weights, governed by the Private Execution Account.
                More strategies land after audit completes.
              </p>
            </div>
          </div>

          <div className="baskets rise d3">
            {BASKETS.map((b) => (
              <a key={b.symbol} href="#" className="basket-row">
                <span className="basket-symbol">{b.symbol}</span>
                <span className="basket-name">{b.name}</span>
                <span className="basket-weights">
                  {b.constituents.map((c) => {
                    const ticker = c.faucetAlias.replace(/^darwin-/, "").toUpperCase();
                    return (
                      <span key={c.faucetAlias} className="pair">
                        <span className="ticker">{ticker}</span>
                        <span className="pct">{formatWeight(c.targetWeightBps)}</span>
                      </span>
                    );
                  })}
                </span>
                <span className="basket-arrow" aria-hidden>→</span>
              </a>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
