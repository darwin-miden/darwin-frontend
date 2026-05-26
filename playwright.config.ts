import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for darwin-frontend E2E.
 *
 * Targets the local dev server (or a manually-started prod build).
 * Tests in ./e2e cover the public surface — landing, basket browser,
 * basket detail with NAV chart, portfolio page with relay panels.
 * Wallet-required flows are out of scope (require MetaMask injection).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: process.env.DARWIN_E2E_URL || "http://localhost:3010",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
