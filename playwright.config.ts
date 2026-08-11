import { defineConfig, devices } from "@playwright/test";

const useProductionPreview = process.env.PLAYWRIGHT_USE_PREVIEW === "1";
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // First-time compilation of the globe and Cesium graphs is memory-heavy on Windows CI.
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4333",
    trace: "retain-on-failure",
  },
  webServer: useExternalServer
    ? undefined
    : {
        command: useProductionPreview
          ? "node node_modules/astro/bin/astro.mjs preview --host 127.0.0.1 --port 4333"
          : "node node_modules/astro/bin/astro.mjs dev --host 127.0.0.1 --port 4333",
        env: {
          ...process.env,
          PUBLIC_GOOGLE_MAP_TILES_API_KEY: "",
          PUBLIC_CESIUM_ION_TOKEN: "",
        },
        url: "http://127.0.0.1:4333",
        reuseExistingServer: false,
        timeout: 120_000,
      },
  projects: [
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
