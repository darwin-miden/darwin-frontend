import { LogoFull, LogoMark } from "@/components/Logo";

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
    </>
  );
}
