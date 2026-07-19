import type { Metadata } from "next";
import { NavBar } from "../../components/NavBar";
import {
  DEPLOYED_ACCOUNTS,
  MIDENSCAN_BASE,
  MIDEN_RPC,
  SEPOLIA_CONTRACTS,
  TESTNET_SNAPSHOT_TAKEN_AT,
  type DeployedAccount,
} from "../../lib/testnet-state";

export const metadata: Metadata = {
  title: "Accounts",
  description:
    "Every Miden testnet account that backs Darwin Protocol: faucets, controllers, oracles, wallets.",
};

const ROLE_LABEL: Record<DeployedAccount["role"], string> = {
  "asset-faucet": "Asset faucet",
  "basket-faucet": "Basket-token faucet",
  controller: "Controller (PEA)",
  "user-wallet": "User wallet",
  "team-wallet": "Team wallet",
  oracle: "Oracle",
};

const ROLE_ORDER: DeployedAccount["role"][] = [
  "asset-faucet",
  "basket-faucet",
  "controller",
  "oracle",
  "user-wallet",
  "team-wallet",
];

function midenscanUrl(id: string) {
  return `${MIDENSCAN_BASE}/account/${id}`;
}

function txUrl(id: string) {
  return `${MIDENSCAN_BASE}/tx/${id}`;
}

function StatusBadge({ mode }: { mode: DeployedAccount["storageMode"] }) {
  const live = mode === "public";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono-stack)",
        fontSize: 11,
        letterSpacing: "0.06em",
        padding: "2px 8px",
        borderRadius: 2,
        border: `1px solid ${live ? "var(--green)" : "var(--ink-3)"}`,
        color: live ? "var(--green)" : "var(--ink-3)",
        textTransform: "uppercase",
      }}
    >
      {live ? "● public · fetched" : "○ private · expected"}
    </span>
  );
}

function AccountRow({ acc }: { acc: DeployedAccount }) {
  return (
    <tr style={{ borderBottom: "1px solid var(--rule-2)" }}>
      <td style={{ padding: "14px 12px", verticalAlign: "top" }}>
        <div style={{ fontWeight: 500 }}>{acc.label}</div>
        {acc.notes && (
          <div
            style={{
              fontSize: 12.5,
              color: "var(--ink-3)",
              marginTop: 4,
              maxWidth: 520,
              lineHeight: 1.5,
            }}
          >
            {acc.notes}
          </div>
        )}
      </td>
      <td style={{ padding: "14px 12px", verticalAlign: "top" }}>
        <a
          href={midenscanUrl(acc.accountId)}
          target="_blank"
          rel="noreferrer"
          style={{
            fontFamily: "var(--font-mono-stack)",
            fontSize: 12.5,
            color: "var(--ink)",
            borderBottom: "1px dotted var(--rule)",
          }}
        >
          {acc.accountId}
        </a>
        {acc.deployTx && (
          <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
            deploy tx{" "}
            <a
              href={txUrl(acc.deployTx)}
              target="_blank"
              rel="noreferrer"
              style={{
                fontFamily: "var(--font-mono-stack)",
                borderBottom: "1px dotted var(--rule)",
              }}
            >
              {acc.deployTx.slice(0, 12)}…
            </a>
          </div>
        )}
      </td>
      <td style={{ padding: "14px 12px", verticalAlign: "top" }}>
        <StatusBadge mode={acc.storageMode} />
      </td>
    </tr>
  );
}

export default function AccountsPage() {
  const grouped = ROLE_ORDER.map((role) => ({
    role,
    accounts: DEPLOYED_ACCOUNTS.filter((a) => a.role === role),
  })).filter((g) => g.accounts.length > 0);

  const totalCount = DEPLOYED_ACCOUNTS.length;
  const publicCount = DEPLOYED_ACCOUNTS.filter(
    (a) => a.storageMode === "public",
  ).length;

  return (
    <>
      <NavBar active="accounts" />
      <main className="container" style={{ padding: "48px 0 96px" }}>
        <div className="section-tag">
          <span className="tag-num">02</span>Deployed accounts
        </div>
        <h1
          style={{
            fontSize: "clamp(2rem, 4vw, 3rem)",
            margin: "20px 0 8px",
            letterSpacing: "-0.015em",
            lineHeight: 1.05,
          }}
        >
          Every account Darwin runs on Miden testnet.
        </h1>
        <p
          style={{
            color: "var(--ink-2)",
            maxWidth: 720,
            fontSize: 16,
            lineHeight: 1.55,
            margin: "8px 0 24px",
          }}
        >
          Snapshot of <code>darwin-baskets/state/testnet.toml</code> as of{" "}
          <strong>{TESTNET_SNAPSHOT_TAKEN_AT}</strong>. The same registry the{" "}
          <code>darwin_doctor</code> binary pings. <strong>{totalCount}</strong>{" "}
          accounts — <strong>{publicCount}</strong> public (fetched live from
          the RPC), the rest private by design (controllers, wallets).
        </p>
        <p style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
          RPC: <code>{MIDEN_RPC}</code> · Explorer:{" "}
          <a
            href={MIDENSCAN_BASE}
            target="_blank"
            rel="noreferrer"
            style={{ borderBottom: "1px dotted var(--rule)" }}
          >
            {MIDENSCAN_BASE.replace("https://", "")}
          </a>
        </p>

        {grouped.map(({ role, accounts }) => (
          <section key={role} style={{ marginTop: 48 }}>
            <h2
              style={{
                fontSize: 14,
                fontFamily: "var(--font-mono-stack)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--ink)",
                borderBottom: "1px solid var(--ink)",
                paddingBottom: 8,
                marginBottom: 0,
              }}
            >
              {ROLE_LABEL[role]} · {accounts.length}
            </h2>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 14,
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
                    Role
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px" }}>
                    Account ID
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px" }}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <AccountRow key={a.accountId} acc={a} />
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <section style={{ marginTop: 64 }}>
          <h2
            style={{
              fontSize: 14,
              fontFamily: "var(--font-mono-stack)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink)",
              borderBottom: "1px solid var(--ink)",
              paddingBottom: 8,
              marginBottom: 0,
            }}
          >
            Sepolia stack · {SEPOLIA_CONTRACTS.length}
          </h2>
          <p style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 8 }}>
            ETH-side contracts the relay reads + writes — the basket-token
            ERC20s, the strategy registry, and the deposit escrow.
          </p>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 14,
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
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Contract</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Role</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>Address</th>
              </tr>
            </thead>
            <tbody>
              {SEPOLIA_CONTRACTS.map((c) => (
                <tr
                  key={c.address}
                  style={{ borderBottom: "1px solid var(--rule-2)" }}
                >
                  <td style={{ padding: "14px 12px", verticalAlign: "top" }}>
                    <div style={{ fontWeight: 500 }}>{c.label}</div>
                    {c.notes && (
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--ink-3)",
                          marginTop: 4,
                          maxWidth: 480,
                          lineHeight: 1.5,
                        }}
                      >
                        {c.notes}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "14px 12px",
                      verticalAlign: "top",
                      fontFamily: "var(--font-mono-stack)",
                      fontSize: 12,
                      color: "var(--ink-2)",
                    }}
                  >
                    {c.role}
                  </td>
                  <td style={{ padding: "14px 12px", verticalAlign: "top" }}>
                    <a
                      href={`https://sepolia.etherscan.io/address/${c.address}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        fontFamily: "var(--font-mono-stack)",
                        fontSize: 12.5,
                        borderBottom: "1px dotted var(--rule)",
                      }}
                    >
                      {c.address}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section style={{ marginTop: 64 }}>
          <div className="section-tag">
            <span className="tag-num">↻</span>Verify it yourself
          </div>
          <pre
            style={{
              marginTop: 16,
              padding: "16px 20px",
              background: "var(--paper-2)",
              borderLeft: "3px solid var(--orange)",
              fontFamily: "var(--font-mono-stack)",
              fontSize: 13,
              overflowX: "auto",
              lineHeight: 1.55,
            }}
          >
            {`# clone the protocol repo
git clone https://github.com/darwin-miden/darwin-protocol.git
cd darwin-protocol

# pings every account ID above against rpc.testnet.miden.io
cargo run -p darwin-protocol-account --bin darwin_doctor

# expected: "Summary: 17/17 accounts confirmed (live or private-as-expected)."
`}
          </pre>
        </section>
      </main>
    </>
  );
}
