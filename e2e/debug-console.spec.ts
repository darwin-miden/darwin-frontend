import { test } from "@playwright/test";

/**
 * Debug helper: capture every console + pageerror from the running
 * dev server. Not part of the default suite.
 *
 *   npx playwright test debug-console --reporter=line
 */

test.describe("debug console", () => {
  test("/portfolio console + pageerrors", async ({ page }) => {
    const events: string[] = [];
    page.on("console", (m) => {
      events.push(`[console.${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (e) => {
      events.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`);
    });
    await page.goto("/portfolio");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    console.log("\n=== console + errors captured ===");
    for (const ev of events) console.log(ev);
  });

  test("/baskets/dcc console + pageerrors", async ({ page }) => {
    const events: string[] = [];
    page.on("console", (m) => {
      events.push(`[console.${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (e) => {
      events.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`);
    });
    await page.goto("/baskets/dcc");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    console.log("\n=== console + errors captured ===");
    for (const ev of events) console.log(ev);
  });
});
