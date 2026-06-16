import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: "npm run dev -- --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4174"
  }
});
