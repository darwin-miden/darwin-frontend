import { test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Headless screenshot pass for darwin-docs/docs/img/. Run with
 *
 *   DARWIN_SCREENSHOT_OUT=/path/to/darwin-docs/docs/img npx playwright test screenshots
 *
 * Each test navigates to a route, waits for content to settle, and
 * writes a PNG. Not part of the default suite (filename matches a
 * different prefix); invoke explicitly when refreshing docs.
 */

const OUT = process.env.DARWIN_SCREENSHOT_OUT
  ?? "/Users/eden/data/darwin/repos/darwin-docs/docs/img";

async function shoot(page: Page, name: string, route: string, ms = 1500) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.goto(route);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(ms);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

test.describe("docs screenshots", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("landing", async ({ page }) => {
    await shoot(page, "01-landing", "/");
  });

  test("basket browser", async ({ page }) => {
    await shoot(page, "02-baskets", "/baskets");
  });

  test("basket detail DCC", async ({ page }) => {
    // Give the LiveNavCard time to fetch /api/nav and render the
    // numeric figure (the placeholder is the dash).
    await shoot(page, "03-basket-dcc", "/baskets/dcc", 3000);
  });

  test("portfolio no-wallet", async ({ page }) => {
    await shoot(page, "04-portfolio-no-wallet", "/portfolio");
  });

  test("flows narrative", async ({ page }) => {
    await shoot(page, "05-flows", "/flows");
  });
});
