import { test, expect } from "@playwright/test";

/**
 * CSP smoke — confirms the Content-Security-Policy + security headers are
 * served AND don't block the app's own legitimate resources/connections
 * (RPCs, *.miden.io, Epoch, WASM workers, self scripts/styles).
 *
 * Run (auto-starts the dev server via the webServer config in
 * playwright.config.ts):
 *
 *   npx playwright test e2e/csp-smoke.spec.ts
 *   # or, against an already-running server:
 *   DARWIN_E2E_URL=http://localhost:3000 npx playwright test e2e/csp-smoke.spec.ts
 *
 * A CSP violation against a host WE need fails the test with the exact
 * blocked directive+URI, so fixing it is a one-line connect-src edit.
 * Third-party wallet-adapter noise (Coinbase/WalletConnect/Reown/Aave) is
 * reported but not failed — those are dropped connectors, not our surface.
 */

const ROUTES = ["/", "/baskets", "/baskets/dcc"];

// Hosts that belong to third-party wallet adapters we intentionally don't
// use — a CSP block on these is expected/harmless, not a regression.
const THIRD_PARTY = /coinbase|walletconnect|reown|aave|cca-lite/i;

test.describe("CSP smoke", () => {
  test("security headers are served on the document response", async ({ page }) => {
    const res = await page.goto("/");
    expect(res, "no response for /").toBeTruthy();
    expect(res!.status()).toBe(200);
    const h = res!.headers();
    const csp = h["content-security-policy"] ?? "";
    expect(csp, "missing Content-Security-Policy header").toBeTruthy();
    expect(csp).toContain("connect-src");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["strict-transport-security"]).toBeTruthy();
    expect(h["referrer-policy"]).toBeTruthy();
    // The Miden prover needs cross-origin isolation.
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["cross-origin-embedder-policy"]).toBe("require-corp");
  });

  for (const route of ROUTES) {
    test(`no CSP violation blocks our own resources on ${route}`, async ({ page }) => {
      const consoleViolations: string[] = [];
      // Collect DOM securitypolicyviolation events (the authoritative source).
      await page.addInitScript(() => {
        (window as unknown as { __csp: unknown[] }).__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          const ev = e as SecurityPolicyViolationEvent;
          (window as unknown as { __csp: unknown[] }).__csp.push({
            directive: ev.effectiveDirective || ev.violatedDirective,
            blocked: ev.blockedURI,
          });
        });
      });
      page.on("console", (msg) => {
        const t = msg.text();
        if (/Content Security Policy|Refused to (connect|load|execute|apply)/i.test(t)) {
          consoleViolations.push(t);
        }
      });

      const res = await page
        .goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch(() => null);
      expect(res, `no response for ${route}`).toBeTruthy();
      expect(res!.status()).toBeLessThan(400);

      // Give async connects (RPC, Miden SDK init, prover workers) time to fire.
      await page.waitForTimeout(6_000);

      const domViolations = (await page.evaluate(
        () => (window as unknown as { __csp: { directive: string; blocked: string }[] }).__csp || [],
      )) as { directive: string; blocked: string }[];

      const all = [
        ...consoleViolations,
        ...domViolations.map((v) => `${v.directive} blocked ${v.blocked}`),
      ];
      const ours = all.filter((v) => !THIRD_PARTY.test(v));

      if (all.length) {
        console.log(
          `[${route}] CSP violations (all ${all.length}):\n` + all.join("\n"),
        );
      }
      expect(
        ours,
        `CSP blocked our own resources on ${route} — add the host to connect-src in next.config.mjs:\n${ours.join("\n")}`,
      ).toHaveLength(0);
    });
  }
});
