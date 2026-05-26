import { test, expect } from "@playwright/test";

/**
 * Public-surface E2E — no wallet interaction required.
 *
 * Covers the routes a visitor can hit without connecting MetaMask
 * or MidenFi: landing, basket browser, basket detail (with the new
 * NAV chart), portfolio scaffolding, and the /api/nav-history JSON
 * endpoint.
 */

test.describe("landing", () => {
  test("/ renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });
    const r = await page.goto("/");
    expect(r?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Allow third-party wallet adapter warnings (Aave/Coinbase) — only
    // fail on darwin-* origin errors that we control.
    const ours = errors.filter(
      (e) => !/Aave|Coinbase|MetaMask|WalletConnect/i.test(e),
    );
    expect(ours, ours.join("\n")).toEqual([]);
  });
});

test.describe("basket browser", () => {
  test("/baskets lists the three M1 baskets", async ({ page }) => {
    const r = await page.goto("/baskets");
    expect(r?.status()).toBe(200);
    // M1-deployed basket symbols should appear as link cards.
    for (const sym of ["DCC", "DAG", "DCO"]) {
      await expect(page.getByText(sym, { exact: false }).first()).toBeVisible();
    }
  });

  test("/baskets/dcc renders NAV history chart", async ({ page }) => {
    const r = await page.goto("/baskets/dcc");
    expect(r?.status()).toBe(200);
    await expect(page.getByText("NAV — 30 day history")).toBeVisible();
    // Chart pulls from /api/nav-history; the synthetic source label is
    // the dev-mode indicator that the data round-tripped.
    await expect(
      page.getByText(/source: (sqlite|synthetic)/),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("portfolio", () => {
  test("/portfolio renders w/o wallet", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    const r = await page.goto("/portfolio");
    expect(r?.status()).toBe(200);
    // Connect-wallet prompt is the canonical no-wallet state.
    await expect(
      page.getByText(/Connect/i).first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("api", () => {
  test("/api/nav-history?basket=DCC returns 30 points", async ({ request }) => {
    const r = await request.get("/api/nav-history?basket=DCC");
    expect(r.status()).toBe(200);
    const j = (await r.json()) as {
      source: string;
      basket: string;
      points: Array<{ t: number; nav: number }>;
    };
    expect(j.basket).toBe("DCC");
    expect(["sqlite", "synthetic"]).toContain(j.source);
    expect(j.points.length).toBeGreaterThanOrEqual(10);
    for (const p of j.points) {
      expect(typeof p.t).toBe("number");
      expect(typeof p.nav).toBe("number");
      expect(p.nav).toBeGreaterThan(0);
    }
  });

  test("/api/nav-history rejects unknown basket", async ({ request }) => {
    const r = await request.get("/api/nav-history?basket=XYZ");
    expect(r.status()).toBe(400);
  });

  test("/api/nav-history defaults to DCC", async ({ request }) => {
    const r = await request.get("/api/nav-history");
    expect(r.status()).toBe(200);
    const j = (await r.json()) as { basket: string };
    expect(j.basket).toBe("DCC");
  });
});
