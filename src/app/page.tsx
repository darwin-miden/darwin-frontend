/**
 * Darwin Protocol — landing page placeholder for M3.
 *
 * The actual M3 frontend (basket browser, deposit/redeem UI, portfolio
 * dashboard, client-side proving via the Miden Web SDK) will replace
 * this single file. Until then the page intentionally serves as a
 * "coming soon" with links back to the documentation.
 */
export default function Page() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>
        Darwin Protocol
      </h1>
      <p style={{ fontSize: "1.1rem", maxWidth: 540, lineHeight: 1.5 }}>
        Confidential basket protocol on Miden. Frontend ships with Milestone
        3 of the Darwin x Miden grant.
      </p>
      <p style={{ marginTop: "2rem", fontSize: "0.95rem" }}>
        Read the M1 architecture spec on{" "}
        <a
          href="https://github.com/darwin-miden/darwin-docs"
          style={{ textDecoration: "underline" }}
        >
          darwin-docs
        </a>{" "}
        — or browse the source under the{" "}
        <a
          href="https://github.com/darwin-miden"
          style={{ textDecoration: "underline" }}
        >
          darwin-miden
        </a>{" "}
        GitHub organisation.
      </p>
    </main>
  );
}
